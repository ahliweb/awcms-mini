/**
 * `service_catalog` plan/offer persistence, lifecycle, events, and audit
 * (Issue #870, epic #868 SaaS control plane, ADR-0022). Same "not-found/
 * invalid-state is a discriminated union, never a thrown error" convention
 * `reference-data/application/value-set-directory.ts` uses.
 *
 * These tables are GLOBAL control-plane data (no `tenant_id`) — every function
 * still runs inside a `withTenant`-scoped transaction (the acting operator's
 * permission context); the acting tenant id + user id are recorded on domain
 * events / audit entries for traceability ("who changed the shared catalog"),
 * never as a column on the mutated row (ADR-0022 §3).
 *
 * Immutability: only a `draft` version's content is editable; publishing
 * freezes it (defence-in-depth DB triggers, sql/079). Corrections create a
 * NEW draft version — never an in-place edit of a published one.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  SERVICE_CATALOG_EVENT_VERSION,
  SERVICE_CATALOG_OFFER_PUBLISHED_EVENT_TYPE,
  SERVICE_CATALOG_OFFER_RETIRED_EVENT_TYPE
} from "../../domain-event-runtime/domain/event-type-registry";
import type { ServiceCatalogKeyRegistry } from "../domain/key-registry";
import { assertPublishable, assertRetirable } from "../domain/lifecycle";
import { buildOfferSnapshot } from "../domain/offer-snapshot";
import {
  validatePlanHeader,
  validateVersionContent,
  type CreatePlanInput,
  type FeatureGrantInput,
  type OfferVersionStatus,
  type PlanStatus,
  type PlanType,
  type PlanValidationError,
  type PriceInput,
  type PriceInterval,
  type PriceVisibility,
  type QuotaInput,
  type QuotaResetPolicy,
  type VersionContentInput
} from "../domain/plan";

const MODULE_KEY = "service_catalog";

// ---------------------------------------------------------------------------
// DTOs (camelCase, returned to the API/UI). The operator detail includes
// INTERNAL prices (the operator may see them); the tenant projection never
// does — that separation lives in `service-catalog-read-query.ts`.
// ---------------------------------------------------------------------------

export type ServiceCatalogFeatureDto = FeatureGrantInput;
export type ServiceCatalogQuotaDto = QuotaInput;
export type ServiceCatalogPriceDto = PriceInput;

export type ServiceCatalogVersionDto = {
  id: string;
  version: number;
  status: OfferVersionStatus;
  currency: string;
  market: string | null;
  trialEnabled: boolean;
  trialDays: number | null;
  availableFrom: string | null;
  availableTo: string | null;
  notes: string | null;
  offerHash: string | null;
  publishedAt: string | null;
  retiredAt: string | null;
  createdAt: string;
  updatedAt: string;
  features: ServiceCatalogFeatureDto[];
  quotas: ServiceCatalogQuotaDto[];
  prices: ServiceCatalogPriceDto[];
};

export type ServiceCatalogPlanSummaryDto = {
  planKey: string;
  name: string;
  description: string | null;
  planType: PlanType;
  status: PlanStatus;
  versionCount: number;
  latestVersion: number | null;
  latestVersionStatus: OfferVersionStatus | null;
  hasDraft: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ServiceCatalogPlanDetailDto = {
  planKey: string;
  name: string;
  description: string | null;
  planType: PlanType;
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
  versions: ServiceCatalogVersionDto[];
};

// ---------------------------------------------------------------------------
// DB row shapes + mappers
// ---------------------------------------------------------------------------

type PlanDbRow = {
  id: string;
  plan_key: string;
  name: string;
  description: string | null;
  plan_type: PlanType;
  status: PlanStatus;
  created_at: Date;
  updated_at: Date;
};

type VersionDbRow = {
  id: string;
  plan_id: string;
  version: number | string;
  status: OfferVersionStatus;
  currency: string;
  market: string | null;
  trial_enabled: boolean;
  trial_days: number | string | null;
  available_from: Date | null;
  available_to: Date | null;
  notes: string | null;
  offer_hash: string | null;
  published_at: Date | null;
  retired_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type FeatureDbRow = {
  version_id: string;
  feature_kind: "feature" | "module";
  feature_key: string;
  enabled: boolean;
  metadata: Record<string, unknown>;
};

type QuotaDbRow = {
  version_id: string;
  meter_key: string;
  is_unlimited: boolean;
  limit_value: number | string | null;
  unit: string;
  reset_policy: QuotaResetPolicy;
  metadata: Record<string, unknown>;
};

type PriceDbRow = {
  version_id: string;
  component_key: string;
  amount_minor: number | string;
  currency: string;
  interval: PriceInterval;
  visibility: PriceVisibility;
  metadata: Record<string, unknown>;
};

function toFeatureDto(row: FeatureDbRow): ServiceCatalogFeatureDto {
  return {
    featureKind: row.feature_kind,
    featureKey: row.feature_key,
    enabled: row.enabled,
    metadata: row.metadata
  };
}

function toQuotaDto(row: QuotaDbRow): ServiceCatalogQuotaDto {
  return {
    meterKey: row.meter_key,
    isUnlimited: row.is_unlimited,
    limitValue: row.limit_value === null ? null : Number(row.limit_value),
    unit: row.unit,
    resetPolicy: row.reset_policy,
    metadata: row.metadata
  };
}

function toPriceDto(row: PriceDbRow): ServiceCatalogPriceDto {
  return {
    componentKey: row.component_key,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    interval: row.interval,
    visibility: row.visibility,
    metadata: row.metadata
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type ListPlansFilter = {
  status?: PlanStatus;
  planType?: PlanType;
};

/** Bounded list (`LIMIT 200`), newest first, with a per-plan version summary. */
export async function listPlans(
  tx: Bun.SQL,
  filter: ListPlansFilter = {}
): Promise<ServiceCatalogPlanSummaryDto[]> {
  const rows = (await tx`
    SELECT
      p.plan_key, p.name, p.description, p.plan_type, p.status,
      p.created_at, p.updated_at,
      COUNT(v.id)::int AS version_count,
      MAX(v.version)::int AS latest_version,
      (SELECT v2.status FROM awcms_mini_service_catalog_plan_versions v2
         WHERE v2.plan_id = p.id ORDER BY v2.version DESC LIMIT 1) AS latest_version_status,
      bool_or(v.status = 'draft') AS has_draft
    FROM awcms_mini_service_catalog_plans p
    LEFT JOIN awcms_mini_service_catalog_plan_versions v ON v.plan_id = p.id
    WHERE (${filter.status ?? null}::text IS NULL OR p.status = ${filter.status ?? null})
      AND (${filter.planType ?? null}::text IS NULL OR p.plan_type = ${filter.planType ?? null})
    GROUP BY p.id, p.plan_key, p.name, p.description, p.plan_type, p.status, p.created_at, p.updated_at
    ORDER BY p.created_at DESC
    LIMIT 200
  `) as {
    plan_key: string;
    name: string;
    description: string | null;
    plan_type: PlanType;
    status: PlanStatus;
    created_at: Date;
    updated_at: Date;
    version_count: number;
    latest_version: number | null;
    latest_version_status: OfferVersionStatus | null;
    has_draft: boolean | null;
  }[];

  return rows.map((row) => ({
    planKey: row.plan_key,
    name: row.name,
    description: row.description,
    planType: row.plan_type,
    status: row.status,
    versionCount: Number(row.version_count),
    latestVersion:
      row.latest_version === null ? null : Number(row.latest_version),
    latestVersionStatus: row.latest_version_status,
    hasDraft: row.has_draft === true,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  }));
}

type PlanWithVersions = {
  plan: PlanDbRow;
  versions: VersionDbRow[];
};

async function loadPlanWithVersions(
  tx: Bun.SQL,
  planKey: string
): Promise<PlanWithVersions | null> {
  const planRows = (await tx`
    SELECT id, plan_key, name, description, plan_type, status, created_at, updated_at
    FROM awcms_mini_service_catalog_plans WHERE plan_key = ${planKey}
  `) as PlanDbRow[];
  const plan = planRows[0];
  if (!plan) {
    return null;
  }

  const versions = (await tx`
    SELECT id, plan_id, version, status, currency, market, trial_enabled, trial_days,
      available_from, available_to, notes, offer_hash, published_at, retired_at,
      created_at, updated_at
    FROM awcms_mini_service_catalog_plan_versions
    WHERE plan_id = ${plan.id}
    ORDER BY version DESC
    LIMIT 200
  `) as VersionDbRow[];

  return { plan, versions };
}

/** Full operator detail: plan header + every version (history) with its features/quotas/prices. */
export async function fetchPlanDetail(
  tx: Bun.SQL,
  planKey: string
): Promise<ServiceCatalogPlanDetailDto | null> {
  const loaded = await loadPlanWithVersions(tx, planKey);
  if (!loaded) {
    return null;
  }
  const { plan, versions } = loaded;
  const versionIds = versions.map((v) => v.id);

  // Sequential (not Promise.all on the same tx — repo lesson
  // `promise-all-on-single-tx-hang`). Empty-array guards keep the ANY() valid.
  const features =
    versionIds.length === 0
      ? []
      : ((await tx`
          SELECT version_id, feature_kind, feature_key, enabled, metadata
          FROM awcms_mini_service_catalog_version_features
          WHERE version_id = ANY(${tx.array(versionIds, "uuid")})
          ORDER BY feature_kind, feature_key
        `) as FeatureDbRow[]);
  const quotas =
    versionIds.length === 0
      ? []
      : ((await tx`
          SELECT version_id, meter_key, is_unlimited, limit_value, unit, reset_policy, metadata
          FROM awcms_mini_service_catalog_version_quotas
          WHERE version_id = ANY(${tx.array(versionIds, "uuid")})
          ORDER BY meter_key
        `) as QuotaDbRow[]);
  const prices =
    versionIds.length === 0
      ? []
      : ((await tx`
          SELECT version_id, component_key, amount_minor, currency, interval, visibility, metadata
          FROM awcms_mini_service_catalog_version_prices
          WHERE version_id = ANY(${tx.array(versionIds, "uuid")})
          ORDER BY component_key
        `) as PriceDbRow[]);

  const featuresByVersion = groupBy(features, (r) => r.version_id);
  const quotasByVersion = groupBy(quotas, (r) => r.version_id);
  const pricesByVersion = groupBy(prices, (r) => r.version_id);

  return {
    planKey: plan.plan_key,
    name: plan.name,
    description: plan.description,
    planType: plan.plan_type,
    status: plan.status,
    createdAt: plan.created_at.toISOString(),
    updatedAt: plan.updated_at.toISOString(),
    versions: versions.map((v) => ({
      id: v.id,
      version: Number(v.version),
      status: v.status,
      currency: v.currency,
      market: v.market,
      trialEnabled: v.trial_enabled,
      trialDays: v.trial_days === null ? null : Number(v.trial_days),
      availableFrom: v.available_from?.toISOString() ?? null,
      availableTo: v.available_to?.toISOString() ?? null,
      notes: v.notes,
      offerHash: v.offer_hash,
      publishedAt: v.published_at?.toISOString() ?? null,
      retiredAt: v.retired_at?.toISOString() ?? null,
      createdAt: v.created_at.toISOString(),
      updatedAt: v.updated_at.toISOString(),
      features: (featuresByVersion.get(v.id) ?? []).map(toFeatureDto),
      quotas: (quotasByVersion.get(v.id) ?? []).map(toQuotaDto),
      prices: (pricesByVersion.get(v.id) ?? []).map(toPriceDto)
    }))
  };
}

function groupBy<T>(
  items: readonly T[],
  key: (item: T) => string
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const existing = map.get(k);
    if (existing) {
      existing.push(item);
    } else {
      map.set(k, [item]);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Write helpers (child collections)
// ---------------------------------------------------------------------------

async function insertVersionChildren(
  tx: Bun.SQL,
  versionId: string,
  content: VersionContentInput
): Promise<void> {
  for (const feature of content.features) {
    await tx`
      INSERT INTO awcms_mini_service_catalog_version_features
        (version_id, feature_kind, feature_key, enabled, metadata)
      VALUES (${versionId}, ${feature.featureKind}, ${feature.featureKey}, ${feature.enabled}, ${feature.metadata}::jsonb)
    `;
  }
  for (const quota of content.quotas) {
    await tx`
      INSERT INTO awcms_mini_service_catalog_version_quotas
        (version_id, meter_key, is_unlimited, limit_value, unit, reset_policy, metadata)
      VALUES (${versionId}, ${quota.meterKey}, ${quota.isUnlimited}, ${quota.limitValue}, ${quota.unit}, ${quota.resetPolicy}, ${quota.metadata}::jsonb)
    `;
  }
  for (const price of content.prices) {
    await tx`
      INSERT INTO awcms_mini_service_catalog_version_prices
        (version_id, component_key, amount_minor, currency, interval, visibility, metadata)
      VALUES (${versionId}, ${price.componentKey}, ${price.amountMinor}, ${price.currency}, ${price.interval}, ${price.visibility}, ${price.metadata}::jsonb)
    `;
  }
}

async function loadVersionContent(
  tx: Bun.SQL,
  versionId: string,
  version: VersionDbRow
): Promise<VersionContentInput> {
  const features = (await tx`
    SELECT version_id, feature_kind, feature_key, enabled, metadata
    FROM awcms_mini_service_catalog_version_features WHERE version_id = ${versionId}
    ORDER BY feature_kind, feature_key
  `) as FeatureDbRow[];
  const quotas = (await tx`
    SELECT version_id, meter_key, is_unlimited, limit_value, unit, reset_policy, metadata
    FROM awcms_mini_service_catalog_version_quotas WHERE version_id = ${versionId}
    ORDER BY meter_key
  `) as QuotaDbRow[];
  const prices = (await tx`
    SELECT version_id, component_key, amount_minor, currency, interval, visibility, metadata
    FROM awcms_mini_service_catalog_version_prices WHERE version_id = ${versionId}
    ORDER BY component_key
  `) as PriceDbRow[];

  return {
    currency: version.currency,
    market: version.market,
    trialEnabled: version.trial_enabled,
    trialDays: version.trial_days === null ? null : Number(version.trial_days),
    availableFrom: version.available_from?.toISOString() ?? null,
    availableTo: version.available_to?.toISOString() ?? null,
    notes: version.notes,
    features: features.map(toFeatureDto),
    quotas: quotas.map(toQuotaDto),
    prices: prices.map(toPriceDto)
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export type CreatePlanResult =
  | { ok: true; plan: ServiceCatalogPlanDetailDto }
  | { ok: false; reason: "validation"; errors: PlanValidationError[] }
  | { ok: false; reason: "duplicate_key" };

export async function createPlan(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreatePlanInput,
  registry: ServiceCatalogKeyRegistry,
  correlationId?: string
): Promise<CreatePlanResult> {
  const errors = [
    ...validatePlanHeader(
      input.planKey,
      input.name,
      input.description,
      input.planType
    ),
    ...validateVersionContent(input.content, registry)
  ];
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const existing = (await tx`
    SELECT id FROM awcms_mini_service_catalog_plans WHERE plan_key = ${input.planKey}
  `) as { id: string }[];
  if (existing.length > 0) {
    return { ok: false, reason: "duplicate_key" };
  }

  const planRows = (await tx`
    INSERT INTO awcms_mini_service_catalog_plans
      (plan_key, name, description, plan_type, created_by, updated_by)
    VALUES (${input.planKey}, ${input.name}, ${input.description}, ${input.planType}, ${actorTenantUserId}, ${actorTenantUserId})
    RETURNING id
  `) as { id: string }[];
  const planId = planRows[0]!.id;

  const versionRows = (await tx`
    INSERT INTO awcms_mini_service_catalog_plan_versions
      (plan_id, version, status, currency, market, trial_enabled, trial_days,
       available_from, available_to, notes, created_by, updated_by)
    VALUES (${planId}, 1, 'draft', ${input.content.currency}, ${input.content.market},
       ${input.content.trialEnabled}, ${input.content.trialDays},
       ${input.content.availableFrom}, ${input.content.availableTo}, ${input.content.notes},
       ${actorTenantUserId}, ${actorTenantUserId})
    RETURNING id
  `) as { id: string }[];
  await insertVersionChildren(tx, versionRows[0]!.id, input.content);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "create",
    resourceType: "service_catalog_plan",
    resourceId: planId,
    severity: "info",
    message: `Service catalog plan "${input.planKey}" created (draft version 1).`,
    attributes: { planKey: input.planKey, planType: input.planType },
    correlationId
  });

  const detail = await fetchPlanDetail(tx, input.planKey);
  return { ok: true, plan: detail! };
}

// ---------------------------------------------------------------------------
// Update draft (plan metadata + the single draft version's content)
// ---------------------------------------------------------------------------

/** PATCH semantics: an absent field is KEPT, a provided one REPLACES. Child collections are replaced only when present (never reset to empty by omission — repo lesson `patch-default-in-parse-resets-omitted-fields`). */
export type UpdatePlanDraftInput = {
  name?: string;
  description?: string | null;
  planType?: PlanType;
  content?: {
    currency?: string;
    market?: string | null;
    trialEnabled?: boolean;
    trialDays?: number | null;
    availableFrom?: string | null;
    availableTo?: string | null;
    notes?: string | null;
    features?: FeatureGrantInput[];
    quotas?: QuotaInput[];
    prices?: PriceInput[];
  };
};

export type UpdatePlanDraftResult =
  | { ok: true; plan: ServiceCatalogPlanDetailDto }
  | { ok: false; reason: "validation"; errors: PlanValidationError[] }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "no_draft_version" };

export async function updatePlanDraft(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  planKey: string,
  input: UpdatePlanDraftInput,
  registry: ServiceCatalogKeyRegistry,
  correlationId?: string
): Promise<UpdatePlanDraftResult> {
  const loaded = await loadPlanWithVersions(tx, planKey);
  if (!loaded) {
    return { ok: false, reason: "not_found" };
  }
  const draft = loaded.versions.find((v) => v.status === "draft");
  if (!draft) {
    return { ok: false, reason: "no_draft_version" };
  }

  // Merge the current draft content with the provided partial (absent = keep).
  const current = await loadVersionContent(tx, draft.id, draft);
  const mergedContent: VersionContentInput = {
    currency: input.content?.currency ?? current.currency,
    market:
      input.content && "market" in input.content
        ? (input.content.market ?? null)
        : current.market,
    trialEnabled: input.content?.trialEnabled ?? current.trialEnabled,
    trialDays:
      input.content && "trialDays" in input.content
        ? (input.content.trialDays ?? null)
        : current.trialDays,
    availableFrom:
      input.content && "availableFrom" in input.content
        ? (input.content.availableFrom ?? null)
        : current.availableFrom,
    availableTo:
      input.content && "availableTo" in input.content
        ? (input.content.availableTo ?? null)
        : current.availableTo,
    notes:
      input.content && "notes" in input.content
        ? (input.content.notes ?? null)
        : current.notes,
    features: input.content?.features ?? current.features,
    quotas: input.content?.quotas ?? current.quotas,
    prices: input.content?.prices ?? current.prices
  };

  const mergedPlanType = input.planType ?? loaded.plan.plan_type;
  const mergedName = input.name ?? loaded.plan.name;
  const mergedDescription =
    "description" in input
      ? (input.description ?? null)
      : loaded.plan.description;

  const errors = [
    ...validatePlanHeader(
      planKey,
      mergedName,
      mergedDescription,
      mergedPlanType
    ),
    ...validateVersionContent(mergedContent, registry)
  ];
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  await tx`
    UPDATE awcms_mini_service_catalog_plans
    SET name = ${mergedName}, description = ${mergedDescription}, plan_type = ${mergedPlanType},
        updated_by = ${actorTenantUserId}, updated_at = now()
    WHERE plan_key = ${planKey}
  `;

  await tx`
    UPDATE awcms_mini_service_catalog_plan_versions
    SET currency = ${mergedContent.currency}, market = ${mergedContent.market},
        trial_enabled = ${mergedContent.trialEnabled}, trial_days = ${mergedContent.trialDays},
        available_from = ${mergedContent.availableFrom}, available_to = ${mergedContent.availableTo},
        notes = ${mergedContent.notes}, updated_by = ${actorTenantUserId}, updated_at = now()
    WHERE id = ${draft.id}
  `;

  // Replace child collections that were provided in this request only.
  if (input.content?.features !== undefined) {
    await tx`DELETE FROM awcms_mini_service_catalog_version_features WHERE version_id = ${draft.id}`;
  }
  if (input.content?.quotas !== undefined) {
    await tx`DELETE FROM awcms_mini_service_catalog_version_quotas WHERE version_id = ${draft.id}`;
  }
  if (input.content?.prices !== undefined) {
    await tx`DELETE FROM awcms_mini_service_catalog_version_prices WHERE version_id = ${draft.id}`;
  }
  await insertVersionChildren(tx, draft.id, {
    ...mergedContent,
    features: input.content?.features ?? [],
    quotas: input.content?.quotas ?? [],
    prices: input.content?.prices ?? []
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "update",
    resourceType: "service_catalog_plan_version",
    resourceId: draft.id,
    severity: "info",
    message: `Service catalog plan "${planKey}" draft version ${Number(draft.version)} updated.`,
    attributes: { planKey, version: Number(draft.version) },
    correlationId
  });

  const detail = await fetchPlanDetail(tx, planKey);
  return { ok: true, plan: detail! };
}

// ---------------------------------------------------------------------------
// Create a new draft version (for corrections after publish)
// ---------------------------------------------------------------------------

export type CreateDraftVersionResult =
  | { ok: true; plan: ServiceCatalogPlanDetailDto; version: number }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "draft_exists" }
  | { ok: false; reason: "validation"; errors: PlanValidationError[] };

/** Starts version N+1 as a draft, seeded from the latest version's content so the operator edits a copy rather than a blank offer. */
export async function createDraftVersion(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  planKey: string,
  registry: ServiceCatalogKeyRegistry,
  correlationId?: string
): Promise<CreateDraftVersionResult> {
  const loaded = await loadPlanWithVersions(tx, planKey);
  if (!loaded) {
    return { ok: false, reason: "not_found" };
  }
  if (loaded.versions.some((v) => v.status === "draft")) {
    return { ok: false, reason: "draft_exists" };
  }

  // A plan always has >= 1 version (created with version 1 by `createPlan`),
  // so `latest` is always present here (N2: no invented USD default offer).
  const latest = loaded.versions[0]; // ORDER BY version DESC
  if (!latest) {
    return { ok: false, reason: "not_found" };
  }

  const seedContent = await loadVersionContent(tx, latest.id, latest);

  const errors = validateVersionContent(seedContent, registry);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const nextVersion = Number(latest.version) + 1;
  const versionRows = (await tx`
    INSERT INTO awcms_mini_service_catalog_plan_versions
      (plan_id, version, status, currency, market, trial_enabled, trial_days,
       available_from, available_to, notes, created_by, updated_by)
    VALUES (${loaded.plan.id}, ${nextVersion}, 'draft', ${seedContent.currency}, ${seedContent.market},
       ${seedContent.trialEnabled}, ${seedContent.trialDays},
       ${seedContent.availableFrom}, ${seedContent.availableTo}, ${seedContent.notes},
       ${actorTenantUserId}, ${actorTenantUserId})
    RETURNING id
  `) as { id: string }[];
  await insertVersionChildren(tx, versionRows[0]!.id, seedContent);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "update",
    resourceType: "service_catalog_plan_version",
    resourceId: versionRows[0]!.id,
    severity: "info",
    message: `Service catalog plan "${planKey}" new draft version ${nextVersion} created.`,
    attributes: { planKey, version: nextVersion },
    correlationId
  });

  const detail = await fetchPlanDetail(tx, planKey);
  return { ok: true, plan: detail!, version: nextVersion };
}

// ---------------------------------------------------------------------------
// Validate (non-mutating)
// ---------------------------------------------------------------------------

export type ValidateVersionResult =
  | { ok: true; valid: true }
  | { ok: true; valid: false; errors: PlanValidationError[] }
  | { ok: false; reason: "not_found" };

export async function validateVersion(
  tx: Bun.SQL,
  planKey: string,
  version: number,
  registry: ServiceCatalogKeyRegistry
): Promise<ValidateVersionResult> {
  const found = await loadVersionByPlanKey(tx, planKey, version);
  if (!found) {
    return { ok: false, reason: "not_found" };
  }
  const content = await loadVersionContent(tx, found.id, found);
  const errors = validateVersionContent(content, registry);
  return errors.length === 0
    ? { ok: true, valid: true }
    : { ok: true, valid: false, errors };
}

async function loadVersionByPlanKey(
  tx: Bun.SQL,
  planKey: string,
  version: number
): Promise<VersionDbRow | null> {
  const rows = (await tx`
    SELECT v.id, v.plan_id, v.version, v.status, v.currency, v.market, v.trial_enabled,
      v.trial_days, v.available_from, v.available_to, v.notes, v.offer_hash, v.published_at,
      v.retired_at, v.created_at, v.updated_at
    FROM awcms_mini_service_catalog_plan_versions v
    JOIN awcms_mini_service_catalog_plans p ON p.id = v.plan_id
    WHERE p.plan_key = ${planKey} AND v.version = ${version}
  `) as VersionDbRow[];
  return rows[0] ?? null;
}

/**
 * Same lookup, but takes a `FOR UPDATE` row lock on the version row only
 * (`FOR UPDATE OF v`, Issue #870 review Fix 2 / Codex-C). Used by
 * publish/retire so concurrent operators (and a concurrent draft PATCH, which
 * always UPDATEs the version row) serialize on this lock — the caller then
 * reads children AFTER the lock and transitions status with a status-predicate,
 * so the projection/offer-hash are built from the final locked state, never a
 * stale pre-lock read.
 */
async function loadVersionByPlanKeyForUpdate(
  tx: Bun.SQL,
  planKey: string,
  version: number
): Promise<VersionDbRow | null> {
  const rows = (await tx`
    SELECT v.id, v.plan_id, v.version, v.status, v.currency, v.market, v.trial_enabled,
      v.trial_days, v.available_from, v.available_to, v.notes, v.offer_hash, v.published_at,
      v.retired_at, v.created_at, v.updated_at
    FROM awcms_mini_service_catalog_plan_versions v
    JOIN awcms_mini_service_catalog_plans p ON p.id = v.plan_id
    WHERE p.plan_key = ${planKey} AND v.version = ${version}
    FOR UPDATE OF v
  `) as VersionDbRow[];
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Publish (draft -> published; immutable; projects the tenant-readable offer)
// ---------------------------------------------------------------------------

export type PublishVersionResult =
  | { ok: true; planKey: string; version: number; offerHash: string }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_draft"; message: string }
  | { ok: false; reason: "validation"; errors: PlanValidationError[] };

export async function publishVersion(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  planKey: string,
  version: number,
  registry: ServiceCatalogKeyRegistry,
  correlationId?: string
): Promise<PublishVersionResult> {
  // Fix 2 / Codex-C: take the version-row lock FIRST, so two concurrent
  // publishers (different Idempotency-Keys) — and a concurrent draft PATCH
  // (which always UPDATEs the version row) — serialize here. A concurrent
  // loser blocks until the winner commits, then re-reads status='published'
  // and returns a clean 409 (`not_draft`) with NO second projection/event/
  // audit. Everything below reads the FINAL locked state.
  const found = await loadVersionByPlanKeyForUpdate(tx, planKey, version);
  if (!found) {
    return { ok: false, reason: "not_found" };
  }

  // Any non-draft status (published — incl. the concurrent loser — retired, or
  // archived) is not publishable: deterministic 409, no idempotent re-publish
  // (route-level Idempotency-Key covers a true same-key retry; a NEW key on an
  // already-published version is a conflict, matching immutability).
  const transition = assertPublishable(found.status);
  if (transition) {
    return { ok: false, reason: "not_draft", message: transition.message };
  }

  // Children read AFTER the lock (Codex-C) — the snapshot/offer-hash reflect the
  // final locked draft state, never a stale pre-lock read racing a PATCH.
  const content = await loadVersionContent(tx, found.id, found);
  const errors = validateVersionContent(content, registry);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const plan = (await tx`
    SELECT name, plan_type FROM awcms_mini_service_catalog_plans WHERE plan_key = ${planKey}
  `) as { name: string; plan_type: PlanType }[];

  const snapshot = buildOfferSnapshot(planKey, version, content);

  // Status-predicated UPDATE (Fix 2): under the lock this always affects the
  // one row; the `AND status = 'draft'` predicate is the belt-and-suspenders
  // guard — 0 rows means the draft was concurrently transitioned, so treat it
  // as a clean conflict rather than proceeding to a stale INSERT.
  const updated = (await tx`
    UPDATE awcms_mini_service_catalog_plan_versions
    SET status = 'published', offer_hash = ${snapshot.offerHash}, published_at = now(),
        published_by = ${actorTenantUserId}, updated_by = ${actorTenantUserId}, updated_at = now()
    WHERE id = ${found.id} AND status = 'draft'
    RETURNING id
  `) as { id: string }[];
  if (updated.length === 0) {
    return {
      ok: false,
      reason: "not_draft",
      message: "This version was concurrently transitioned out of draft."
    };
  }

  await tx`
    INSERT INTO awcms_mini_service_catalog_published_offers
      (plan_version_id, plan_key, plan_name, plan_type, version, currency, market,
       trial_enabled, trial_days, effective_from, effective_to, features, quotas, prices,
       offer_hash, published_by)
    VALUES (
      ${found.id}, ${planKey}, ${plan[0]!.name}, ${plan[0]!.plan_type}, ${version},
      ${content.currency}, ${content.market}, ${content.trialEnabled}, ${content.trialDays},
      ${content.availableFrom}, ${content.availableTo},
      ${snapshot.features}::jsonb, ${snapshot.quotas}::jsonb, ${snapshot.publicPrices}::jsonb,
      ${snapshot.offerHash}, ${actorTenantUserId}
    )
  `;

  await appendDomainEvent(tx, tenantId, {
    eventType: SERVICE_CATALOG_OFFER_PUBLISHED_EVENT_TYPE,
    eventVersion: SERVICE_CATALOG_EVENT_VERSION,
    aggregateType: "service_catalog_offer",
    aggregateId: found.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: {
      planKey,
      version,
      offerHash: snapshot.offerHash,
      currency: content.currency
    }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "publish",
    resourceType: "service_catalog_offer",
    resourceId: found.id,
    severity: "warning",
    message: `Service catalog offer "${planKey}" v${version} published (immutable; affects the GLOBAL catalog).`,
    attributes: { planKey, version, offerHash: snapshot.offerHash },
    correlationId
  });

  return { ok: true, planKey, version, offerHash: snapshot.offerHash };
}

// ---------------------------------------------------------------------------
// Retire (published -> retired; offer stays readable)
// ---------------------------------------------------------------------------

export type RetireVersionResult =
  | { ok: true; planKey: string; version: number }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_published"; message: string };

export async function retireVersion(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  planKey: string,
  version: number,
  correlationId?: string
): Promise<RetireVersionResult> {
  // Fix 2: version-row lock first — two concurrent retires serialize here; the
  // loser blocks, re-reads status='retired', and returns a clean 409 with no
  // second event/audit (route Idempotency-Key covers a true same-key retry).
  const found = await loadVersionByPlanKeyForUpdate(tx, planKey, version);
  if (!found) {
    return { ok: false, reason: "not_found" };
  }

  const transition = assertRetirable(found.status);
  if (transition) {
    return { ok: false, reason: "not_published", message: transition.message };
  }

  const updated = (await tx`
    UPDATE awcms_mini_service_catalog_plan_versions
    SET status = 'retired', retired_at = now(), retired_by = ${actorTenantUserId},
        updated_by = ${actorTenantUserId}, updated_at = now()
    WHERE id = ${found.id} AND status = 'published'
    RETURNING id
  `) as { id: string }[];
  if (updated.length === 0) {
    return {
      ok: false,
      reason: "not_published",
      message: "This version was concurrently transitioned out of published."
    };
  }
  await tx`
    UPDATE awcms_mini_service_catalog_published_offers
    SET retired_at = now()
    WHERE plan_version_id = ${found.id}
  `;

  await appendDomainEvent(tx, tenantId, {
    eventType: SERVICE_CATALOG_OFFER_RETIRED_EVENT_TYPE,
    eventVersion: SERVICE_CATALOG_EVENT_VERSION,
    aggregateType: "service_catalog_offer",
    aggregateId: found.id,
    producerModule: MODULE_KEY,
    correlationId,
    actorTenantUserId,
    payload: { planKey, version }
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "retire",
    resourceType: "service_catalog_offer",
    resourceId: found.id,
    severity: "warning",
    message: `Service catalog offer "${planKey}" v${version} retired.`,
    attributes: { planKey, version },
    correlationId
  });

  return { ok: true, planKey, version };
}
