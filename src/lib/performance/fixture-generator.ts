/**
 * Deterministic synthetic multi-tenant fixture generator (Issue #744, epic
 * #738 platform-evolution). Pure — no I/O, no database — every function
 * here takes a `PerformanceScaleProfile` (`scale-profiles.ts`) and a seed
 * and returns plain row objects; `fixture-seeder.ts` is the (separate,
 * I/O-performing) module that actually writes these into PostgreSQL.
 *
 * Synthetic-only, by construction: every string field is built from a
 * small fixed vocabulary (`SYNTHETIC_*` word lists below) combined via the
 * seeded PRNG — there is no code path here that could ever read or embed
 * real production data, a real credential, or a real customer identifier
 * (the non-negotiable "synthetic data only" requirement).
 */
import { createPrng, deterministicUuid, hashSeed, type Prng } from "./prng";
import type { PerformanceScaleProfile } from "./scale-profiles";

export type TenantFixturePlan = {
  tenantId: string;
  tenantCode: string;
  tenantName: string;
  syncNodeId: string;
  syncNodeCode: string;
  isNoisyNeighbor: boolean;
  /** This tenant's actual per-table row counts (profile's `rowsPerTenant`, multiplied by `noisyNeighborMultiplier` for the noisy-neighbor tenant). */
  rowCounts: PerformanceScaleProfile["rowsPerTenant"];
};

export type FixturePlan = {
  seed: string;
  profileId: PerformanceScaleProfile["id"];
  tenants: TenantFixturePlan[];
};

/**
 * Builds the tenant roster for a profile — deterministic ids/codes derived
 * from `seed`, so re-running the same `(profile, seed)` always yields the
 * identical tenant set (required for reproducible before/after release
 * comparisons, the issue's own "results can be compared between two
 * releases/commits" acceptance criterion). The LAST tenant is always the
 * designated noisy neighbor.
 */
export function buildFixturePlan(
  profile: PerformanceScaleProfile,
  seed: string
): FixturePlan {
  const tenants: TenantFixturePlan[] = [];
  // `awcms_mini_tenants.tenant_code` and `awcms_mini_sync_nodes.node_code`
  // are unique across the WHOLE table (not scoped to any run), so the code
  // itself must depend on `seed`, not just `profile.id` — otherwise two
  // runs of the same scale profile with DIFFERENT seeds (e.g. two
  // independent CI runs, or `performance:suite` and
  // `performance:query-plan:check`'s own different default seeds) would
  // collide on tenant_code even though their tenantId uuids correctly
  // differ, since `ON CONFLICT (id) DO NOTHING` only de-duplicates on `id`,
  // not on this OTHER unique constraint. An 8-hex-character seed fingerprint
  // keeps codes short while making cross-seed collisions astronomically
  // unlikely.
  const seedFingerprint = hashSeed(seed).toString(16).padStart(8, "0");

  for (let index = 0; index < profile.tenantCount; index++) {
    const tenantSeed = `${seed}:tenant:${index}`;
    const prng = createPrng(tenantSeed);
    const isNoisyNeighbor = index === profile.tenantCount - 1;
    const multiplier = isNoisyNeighbor ? profile.noisyNeighborMultiplier : 1;
    const indexLabel = index.toString().padStart(3, "0");

    tenants.push({
      tenantId: deterministicUuid(prng),
      tenantCode: `perf-${profile.id}-${seedFingerprint}-${indexLabel}`,
      tenantName: `Performance Fixture Tenant ${index}${isNoisyNeighbor ? " (noisy neighbor)" : ""}`,
      syncNodeId: deterministicUuid(prng),
      syncNodeCode: `perf-node-${seedFingerprint}-${indexLabel}`,
      isNoisyNeighbor,
      rowCounts: scaleRowCounts(profile.rowsPerTenant, multiplier)
    });
  }

  return { seed, profileId: profile.id, tenants };
}

function scaleRowCounts(
  counts: PerformanceScaleProfile["rowsPerTenant"],
  multiplier: number
): PerformanceScaleProfile["rowsPerTenant"] {
  return {
    auditEvents: Math.round(counts.auditEvents * multiplier),
    abacDecisionLogs: Math.round(counts.abacDecisionLogs * multiplier),
    visitorSessions: Math.round(counts.visitorSessions * multiplier),
    syncOutbox: Math.round(counts.syncOutbox * multiplier),
    objectSyncQueue: Math.round(counts.objectSyncQueue * multiplier),
    idempotencyKeys: Math.round(counts.idempotencyKeys * multiplier),
    blogPosts: Math.round(counts.blogPosts * multiplier)
  };
}

// ---------------------------------------------------------------------------
// Synthetic vocabularies (no real data, ever).
// ---------------------------------------------------------------------------

const MODULE_KEYS = [
  "identity_access",
  "profile_identity",
  "logging",
  "sync_storage",
  "workflow",
  "blog_content",
  "module_management"
] as const;

const AUDIT_ACTIONS = [
  "create",
  "update",
  "delete",
  "restore",
  "purge",
  "login",
  "assign",
  "export"
] as const;

const RESOURCE_TYPES = [
  "profile",
  "role",
  "access_assignment",
  "sync_conflict",
  "module_settings",
  "blog_post",
  "tenant_module"
] as const;

const SEVERITIES = ["info", "warning", "critical"] as const;
const DECISIONS = ["allow", "deny"] as const;
const AREAS = ["admin", "public", "api", "auth"] as const;
const DEVICE_TYPES = ["desktop", "mobile", "tablet"] as const;
const SYNC_EVENT_TYPES = [
  "profile.updated",
  "role.assigned",
  "blog_post.published",
  "sync.conflict.resolved"
] as const;
const AGGREGATE_TYPES = [
  "profile",
  "role",
  "blog_post",
  "sync_conflict"
] as const;
const OBJECT_QUEUE_STATUSES = ["pending", "sent", "failed"] as const;
const WORDS = [
  "lorem",
  "ipsum",
  "dolor",
  "sit",
  "amet",
  "tenant",
  "modular",
  "monolith",
  "fixture",
  "synthetic",
  "sample",
  "content",
  "report",
  "queue",
  "outbox"
] as const;

function synthesizeSentence(prng: Prng, wordCount: number): string {
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    words.push(prng.pick(WORDS));
  }
  return words.join(" ");
}

/** Timestamp spread deterministically over the last `spanDays` days relative to `anchor` (see `deriveDeterministicAnchor` — never real wall-clock time), giving a realistic keyset-pagination-cursor-shaped spread without ever depending on `Date.now()`. */
function syntheticTimestamp(prng: Prng, spanDays: number, anchor: Date): Date {
  const offsetMs = prng.nextInt(0, spanDays * 24 * 60 * 60 * 1000);
  return new Date(anchor.getTime() - offsetMs);
}

/**
 * Fixed reference instant — deliberately NOT `Date.now()`. Reviewer finding
 * on PR #775: the original implementation computed `anchor = new Date()`
 * at seed time, so the same `(scaleProfile, seed)` pair produced
 * DIFFERENT absolute row timestamps depending on which real day the suite
 * ran — the PRNG-derived offset was deterministic, but the anchor it was
 * relative to was not, contradicting this module's own "same seed always
 * produces the same fixture plan" guarantee (which
 * `performance-suite.md`'s "results can be compared between two releases/
 * commits" claim, and this file's own header comment, both depend on).
 */
const REFERENCE_EPOCH_MS = Date.parse("2026-01-01T00:00:00.000Z");
/** How far `deriveDeterministicAnchor` may shift the anchor away from `REFERENCE_EPOCH_MS`, in days — purely to give different seeds a visibly different (but each individually reproducible) "current time", never to reintroduce a wall-clock dependency. */
const ANCHOR_JITTER_DAYS = 60;

/**
 * The single deterministic "now" every `generate*` row-timestamp
 * calculation is relative to for one `(seed)` — a pure function of `seed`
 * alone, never of the real system clock. Exported so
 * `fixture-seeder.ts`/tests can derive (and assert on) the exact same
 * anchor a given seed will always produce.
 */
export function deriveDeterministicAnchor(seed: string): Date {
  const prng = createPrng(`${seed}:anchor`);
  const jitterMs =
    prng.nextInt(-ANCHOR_JITTER_DAYS, ANCHOR_JITTER_DAYS) * 24 * 60 * 60 * 1000;

  return new Date(REFERENCE_EPOCH_MS + jitterMs);
}

// ---------------------------------------------------------------------------
// Row generators — one per target table. Each takes the tenant's own PRNG
// sub-stream (`${seed}:tenant:${index}:${table}`) so tables are independent
// of each other and of generation order.
// ---------------------------------------------------------------------------

export type AuditEventFixtureRow = {
  tenantId: string;
  moduleKey: string;
  action: string;
  resourceType: string;
  resourceId: string;
  severity: string;
  message: string;
  correlationId: string;
  createdAt: Date;
};

export function generateAuditEvents(
  tenant: TenantFixturePlan,
  seed: string,
  anchor: Date
): AuditEventFixtureRow[] {
  const prng = createPrng(`${seed}:audit:${tenant.tenantId}`);
  const rows: AuditEventFixtureRow[] = [];

  for (let i = 0; i < tenant.rowCounts.auditEvents; i++) {
    rows.push({
      tenantId: tenant.tenantId,
      moduleKey: prng.pick(MODULE_KEYS),
      action: prng.pick(AUDIT_ACTIONS),
      resourceType: prng.pick(RESOURCE_TYPES),
      resourceId: deterministicUuid(prng),
      severity: prng.pick(SEVERITIES),
      message: `synthetic audit event: ${synthesizeSentence(prng, 6)}`,
      correlationId: deterministicUuid(prng),
      createdAt: syntheticTimestamp(prng, 400, anchor)
    });
  }

  return rows;
}

export type AbacDecisionLogFixtureRow = {
  tenantId: string;
  moduleKey: string;
  activityCode: string;
  action: string;
  resourceType: string;
  resourceId: string;
  decision: string;
  reason: string;
  matchedPolicy: string | null;
  createdAt: Date;
};

export function generateAbacDecisionLogs(
  tenant: TenantFixturePlan,
  seed: string,
  anchor: Date
): AbacDecisionLogFixtureRow[] {
  const prng = createPrng(`${seed}:abac:${tenant.tenantId}`);
  const rows: AbacDecisionLogFixtureRow[] = [];

  for (let i = 0; i < tenant.rowCounts.abacDecisionLogs; i++) {
    const decision = prng.pick(DECISIONS);
    rows.push({
      tenantId: tenant.tenantId,
      moduleKey: prng.pick(MODULE_KEYS),
      activityCode: prng.pick(RESOURCE_TYPES),
      action: prng.pick(AUDIT_ACTIONS),
      resourceType: prng.pick(RESOURCE_TYPES),
      resourceId: deterministicUuid(prng),
      decision,
      reason:
        decision === "allow"
          ? "role grants permission"
          : "default-deny: no matching allow policy",
      matchedPolicy: prng.chance(0.5) ? `policy-${prng.nextInt(1, 9)}` : null,
      createdAt: syntheticTimestamp(prng, 400, anchor)
    });
  }

  return rows;
}

export type VisitorSessionFixtureRow = {
  tenantId: string;
  visitorKeyHash: string;
  area: string;
  currentPath: string;
  isAuthenticated: boolean;
  isHuman: boolean;
  deviceType: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
};

export function generateVisitorSessions(
  tenant: TenantFixturePlan,
  seed: string,
  anchor: Date
): VisitorSessionFixtureRow[] {
  const prng = createPrng(`${seed}:analytics:${tenant.tenantId}`);
  const rows: VisitorSessionFixtureRow[] = [];

  for (let i = 0; i < tenant.rowCounts.visitorSessions; i++) {
    const firstSeenAt = syntheticTimestamp(prng, 400, anchor);
    rows.push({
      tenantId: tenant.tenantId,
      // A hash-shaped synthetic string, never a real visitor fingerprint.
      visitorKeyHash: prng.hex(64),
      area: prng.pick(AREAS),
      currentPath: `/synthetic/${prng.pick(WORDS)}/${prng.nextInt(1, 999)}`,
      isAuthenticated: prng.chance(0.3),
      isHuman: prng.chance(0.95),
      deviceType: prng.pick(DEVICE_TYPES),
      firstSeenAt,
      lastSeenAt: new Date(
        firstSeenAt.getTime() + prng.nextInt(0, 30 * 60 * 1000)
      )
    });
  }

  return rows;
}

export type SyncOutboxFixtureRow = {
  tenantId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payloadJson: Record<string, unknown>;
  status: "pending" | "delivered";
  createdAt: Date;
};

export function generateSyncOutbox(
  tenant: TenantFixturePlan,
  seed: string,
  anchor: Date
): SyncOutboxFixtureRow[] {
  const prng = createPrng(`${seed}:outbox:${tenant.tenantId}`);
  const rows: SyncOutboxFixtureRow[] = [];

  for (let i = 0; i < tenant.rowCounts.syncOutbox; i++) {
    rows.push({
      tenantId: tenant.tenantId,
      eventType: prng.pick(SYNC_EVENT_TYPES),
      aggregateType: prng.pick(AGGREGATE_TYPES),
      aggregateId: deterministicUuid(prng),
      payloadJson: { synthetic: true, note: synthesizeSentence(prng, 4) },
      status: prng.chance(0.7) ? "delivered" : "pending",
      createdAt: syntheticTimestamp(prng, 400, anchor)
    });
  }

  return rows;
}

export type ObjectSyncQueueFixtureRow = {
  tenantId: string;
  nodeId: string;
  objectKey: string;
  localPath: string;
  checksumSha256: string;
  byteSize: number;
  requiresUpload: boolean;
  status: (typeof OBJECT_QUEUE_STATUSES)[number];
  retryCount: number;
  nextRetryAt: Date | null;
  createdAt: Date;
};

export function generateObjectSyncQueue(
  tenant: TenantFixturePlan,
  seed: string,
  anchor: Date
): ObjectSyncQueueFixtureRow[] {
  const prng = createPrng(`${seed}:objectqueue:${tenant.tenantId}`);
  const rows: ObjectSyncQueueFixtureRow[] = [];

  for (let i = 0; i < tenant.rowCounts.objectSyncQueue; i++) {
    const status = prng.pick(OBJECT_QUEUE_STATUSES);
    rows.push({
      tenantId: tenant.tenantId,
      nodeId: tenant.syncNodeId,
      objectKey: `perf/${tenant.tenantCode}/object-${i}-${prng.hex(8)}`,
      localPath: `/tmp/perf-fixture/${tenant.tenantCode}/object-${i}`,
      checksumSha256: prng.hex(64),
      byteSize: prng.nextInt(128, 5_000_000),
      requiresUpload: prng.chance(0.5),
      status,
      retryCount: status === "failed" ? prng.nextInt(1, 5) : 0,
      nextRetryAt:
        status === "pending" || status === "failed"
          ? syntheticTimestamp(prng, 5, anchor)
          : null,
      createdAt: syntheticTimestamp(prng, 400, anchor)
    });
  }

  return rows;
}

export type IdempotencyKeyFixtureRow = {
  tenantId: string;
  requestScope: string;
  idempotencyKey: string;
  requestHash: string;
  responseStatus: number;
  responseBody: Record<string, unknown>;
  createdAt: Date;
};

export function generateIdempotencyKeys(
  tenant: TenantFixturePlan,
  seed: string,
  anchor: Date
): IdempotencyKeyFixtureRow[] {
  const prng = createPrng(`${seed}:idempotency:${tenant.tenantId}`);
  const rows: IdempotencyKeyFixtureRow[] = [];

  for (let i = 0; i < tenant.rowCounts.idempotencyKeys; i++) {
    rows.push({
      tenantId: tenant.tenantId,
      requestScope: "perf.synthetic.mutation",
      idempotencyKey: `perf-${tenant.tenantCode}-${i}-${prng.hex(12)}`,
      requestHash: prng.hex(64),
      responseStatus: prng.chance(0.9) ? 200 : 409,
      responseBody: { synthetic: true, index: i },
      createdAt: syntheticTimestamp(prng, 90, anchor)
    });
  }

  return rows;
}

export type BlogPostFixtureRow = {
  tenantId: string;
  authorTenantUserId: string;
  title: string;
  slug: string;
  excerpt: string;
  contentJson: Record<string, unknown>;
  contentText: string;
  status: string;
  visibility: string;
  locale: string;
  publishedAt: Date | null;
  createdAt: Date;
};

const BLOG_STATUSES = ["draft", "review", "published", "archived"] as const;

export function generateBlogPosts(
  tenant: TenantFixturePlan,
  seed: string,
  anchor: Date
): BlogPostFixtureRow[] {
  const prng = createPrng(`${seed}:blog:${tenant.tenantId}`);
  const rows: BlogPostFixtureRow[] = [];

  for (let i = 0; i < tenant.rowCounts.blogPosts; i++) {
    const status = prng.pick(BLOG_STATUSES);
    const title = `${synthesizeSentence(prng, 3)} ${i}`;
    const contentText = synthesizeSentence(prng, 40);
    const createdAt = syntheticTimestamp(prng, 400, anchor);

    rows.push({
      tenantId: tenant.tenantId,
      authorTenantUserId: deterministicUuid(prng),
      title,
      slug: `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${i}-${prng.hex(6)}`,
      excerpt: synthesizeSentence(prng, 10),
      contentJson: {
        synthetic: true,
        blocks: [{ type: "paragraph", text: contentText }]
      },
      contentText,
      status,
      visibility: "public",
      locale: "id",
      publishedAt: status === "published" ? createdAt : null,
      createdAt
    });
  }

  return rows;
}

/** Stable, non-cryptographic run identifier for correlating one fixture generation with its resulting report — derived from the same seed, never a source of entropy for the fixtures themselves. */
export function fixtureRunId(seed: string): string {
  return `perf-run-${hashSeed(seed).toString(16)}`;
}
