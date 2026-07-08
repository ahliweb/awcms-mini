/**
 * Tenant domain management data access (Issue #562, epic #555) over
 * `awcms_mini_tenant_domains` (migration 031). Every query here runs inside
 * a caller-provided tenant transaction (`withTenant`, RLS `FORCE`d on this
 * table since migration 031) — **not** the `SECURITY DEFINER` bootstrap
 * function from migration 033 (`awcms_mini_resolve_tenant_domain_lookup`),
 * which is reserved for the anonymous, pre-tenant-context public resolver
 * (Issue #559) per the epic's own binding rule (skill
 * `awcms-mini-tenant-domain-routing` §Aturan lintas-issue #10).
 *
 * `verification_token_hash` is deliberately never selected/returned by any
 * function in this file — Issue #562's acceptance criteria: API responses
 * must never expose provider token/secret values, and this column (an
 * internal bearer-token hash, migration 031) is exactly that kind of value
 * even though nothing in this issue ever writes it. The column list is
 * repeated literally at each query site (not factored into a shared
 * `sql.unsafe()` fragment) — same convention every other directory module
 * in this repo uses (e.g. `email-template-directory.ts`), so every query
 * stays a single self-contained tagged template.
 */
import type {
  CreateTenantDomainInput,
  UpdateTenantDomainInput
} from "../domain/tenant-domain-validation";
import type { KeysetCursor } from "../../_shared/keyset-pagination";

export const TENANT_DOMAIN_LIST_LIMIT = 100;

export type TenantDomainView = {
  id: string;
  tenantId: string;
  hostname: string;
  normalizedHostname: string;
  domainType: string;
  routeMode: string;
  status: string;
  isPrimary: boolean;
  redirectToPrimary: boolean;
  verificationMethod: string | null;
  verificationRecordName: string | null;
  verificationRecordValue: string | null;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
};

type TenantDomainRow = {
  id: string;
  tenant_id: string;
  hostname: string;
  normalized_hostname: string;
  domain_type: string;
  route_mode: string;
  status: string;
  is_primary: boolean;
  redirect_to_primary: boolean;
  verification_method: string | null;
  verification_record_name: string | null;
  verification_record_value: string | null;
  verified_at: Date | null;
  last_checked_at: Date | null;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  updated_by: string | null;
};

function toView(row: TenantDomainRow): TenantDomainView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    hostname: row.hostname,
    normalizedHostname: row.normalized_hostname,
    domainType: row.domain_type,
    routeMode: row.route_mode,
    status: row.status,
    isPrimary: row.is_primary,
    redirectToPrimary: row.redirect_to_primary,
    verificationMethod: row.verification_method,
    verificationRecordName: row.verification_record_name,
    verificationRecordValue: row.verification_record_value,
    verifiedAt: row.verified_at ? row.verified_at.toISOString() : null,
    lastCheckedAt: row.last_checked_at
      ? row.last_checked_at.toISOString()
      : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    createdBy: row.created_by,
    updatedBy: row.updated_by
  };
}

/**
 * Throws on a constraint violation — the route layer catches this and maps
 * `awcms_mini_tenant_domains_normalized_hostname_dedup` to a generic 409,
 * same pattern `createBlogPost`'s slug-dedup catch uses. The unique index
 * is global (not tenant-scoped, migration 031), so this can throw whether
 * the conflicting row belongs to this tenant or another one — the route
 * must not distinguish the two in its response (Issue #562 §Security
 * notes: never reveal whether a hostname belongs to another tenant).
 */
export async function createTenantDomain(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateTenantDomainInput
): Promise<TenantDomainView> {
  const rows = (await tx`
    INSERT INTO awcms_mini_tenant_domains
      (tenant_id, hostname, normalized_hostname, domain_type, route_mode,
       verification_method, verification_record_name, verification_record_value,
       redirect_to_primary, created_by, updated_by)
    VALUES (
      ${tenantId}, ${input.hostname}, ${input.normalizedHostname}, ${input.domainType},
      ${input.routeMode}, ${input.verificationMethod}, ${input.verificationRecordName},
      ${input.verificationRecordValue}, ${input.redirectToPrimary},
      ${actorTenantUserId}, ${actorTenantUserId}
    )
    RETURNING id, tenant_id, hostname, normalized_hostname, domain_type, route_mode, status,
      is_primary, redirect_to_primary, verification_method, verification_record_name,
      verification_record_value, verified_at, last_checked_at, created_at, updated_at,
      created_by, updated_by
  `) as TenantDomainRow[];

  return toView(rows[0]!);
}

/** Only non-deleted rows are readable — matches the base soft-delete convention (mirrors `fetchActiveEmailTemplate`). Tenant isolation is enforced twice, defense in depth: the explicit `tenant_id` filter here, and RLS `FORCE`d on the table (migration 031). */
export async function fetchActiveTenantDomain(
  tx: Bun.SQL,
  tenantId: string,
  id: string
): Promise<TenantDomainView | null> {
  const rows = (await tx`
    SELECT id, tenant_id, hostname, normalized_hostname, domain_type, route_mode, status,
      is_primary, redirect_to_primary, verification_method, verification_record_name,
      verification_record_value, verified_at, last_checked_at, created_at, updated_at,
      created_by, updated_by
    FROM awcms_mini_tenant_domains
    WHERE tenant_id = ${tenantId} AND id = ${id} AND deleted_at IS NULL
  `) as TenantDomainRow[];

  return rows[0] ? toView(rows[0]) : null;
}

/** Keyset pagination (`(created_at, id) DESC`), same shape as `fetchEmailMessageEntries` — bounded page size, opaque cursor, no `OFFSET`. */
export async function listTenantDomains(
  tx: Bun.SQL,
  tenantId: string,
  cursor?: KeysetCursor
): Promise<TenantDomainView[]> {
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;

  const rows = (await tx`
    SELECT id, tenant_id, hostname, normalized_hostname, domain_type, route_mode, status,
      is_primary, redirect_to_primary, verification_method, verification_record_name,
      verification_record_value, verified_at, last_checked_at, created_at, updated_at,
      created_by, updated_by
    FROM awcms_mini_tenant_domains
    WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (created_at, id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${TENANT_DOMAIN_LIST_LIMIT}
  `) as TenantDomainRow[];

  return rows.map(toView);
}

/**
 * Partial update. `hostname`/`normalized_hostname` are intentionally
 * immutable here (no field for either in `UpdateTenantDomainInput`) — a
 * domain's identity should not silently change under an existing mapping;
 * re-pointing a hostname to a different tenant means deleting the mapping
 * and creating a new one. `is_primary` is also never settable here — the
 * only path to becoming primary is the atomic `setPrimaryTenantDomain`
 * below (Issue #562's own acceptance criterion: set-primary must be
 * atomic, so it cannot also be reachable through this generic update).
 * `status` can only reach non-`active` values here — see
 * `UpdateTenantDomainInput`'s own docblock.
 */
export async function updateTenantDomain(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  id: string,
  input: UpdateTenantDomainInput
): Promise<TenantDomainView | null> {
  const rows = (await tx`
    UPDATE awcms_mini_tenant_domains
    SET domain_type = COALESCE(${input.domainType ?? null}, domain_type),
        route_mode = COALESCE(${input.routeMode ?? null}, route_mode),
        status = COALESCE(${input.status ?? null}, status),
        redirect_to_primary = COALESCE(${input.redirectToPrimary ?? null}, redirect_to_primary),
        verification_method = CASE
          WHEN ${input.verificationMethod === undefined} THEN verification_method
          ELSE ${input.verificationMethod ?? null}
        END,
        verification_record_name = CASE
          WHEN ${input.verificationRecordName === undefined} THEN verification_record_name
          ELSE ${input.verificationRecordName ?? null}
        END,
        verification_record_value = CASE
          WHEN ${input.verificationRecordValue === undefined} THEN verification_record_value
          ELSE ${input.verificationRecordValue ?? null}
        END,
        updated_by = ${actorTenantUserId},
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id} AND deleted_at IS NULL
    RETURNING id, tenant_id, hostname, normalized_hostname, domain_type, route_mode, status,
      is_primary, redirect_to_primary, verification_method, verification_record_name,
      verification_record_value, verified_at, last_checked_at, created_at, updated_at,
      created_by, updated_by
  `) as TenantDomainRow[];

  return rows[0] ? toView(rows[0]) : null;
}

/**
 * Soft delete only (Issue #562 acceptance criterion — never hard-delete).
 * Also clears `is_primary` so a soft-deleted row never lingers as a
 * tenant's "primary" (the partial unique index already excludes
 * `deleted_at IS NOT NULL` rows from the one-primary-per-tenant
 * constraint, so this is a cleanliness choice, not a constraint
 * requirement — a subsequent `create`/`set-primary` for a replacement
 * domain is unaffected either way).
 */
export async function softDeleteTenantDomain(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  id: string,
  reason: string
): Promise<boolean> {
  const rows = await tx`
    UPDATE awcms_mini_tenant_domains
    SET deleted_at = now(), deleted_by = ${actorTenantUserId}, delete_reason = ${reason},
        is_primary = false, updated_by = ${actorTenantUserId}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id} AND deleted_at IS NULL
    RETURNING id
  `;

  return rows.length > 0;
}

export type VerifyTenantDomainResult =
  | { outcome: "verified"; entry: TenantDomainView }
  | { outcome: "not_found" }
  | { outcome: "missing_verification_method" }
  | { outcome: "not_verifiable"; currentStatus: string };

/**
 * Manual-first verify (Issue #562 §Security notes — no outbound DNS/HTTP
 * call in this issue): flips `status` to `active` based purely on fields
 * already on the row. A domain with no `verification_method` configured
 * cannot be verified (nothing to attest). `active` is idempotent — calling
 * verify again just returns the current row, not an error, since the end
 * state is identical (also what makes a same-key idempotency replay and a
 * genuine second call with a fresh key behave the same way). `suspended`
 * is the one non-`active` status this refuses to transition out of via
 * verify — that state is an explicit operator/tenant pause, not something
 * a "yes, DNS is fine" attestation should silently override.
 */
export async function verifyTenantDomain(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  id: string
): Promise<VerifyTenantDomainResult> {
  const existingRows = (await tx`
    SELECT status, verification_method
    FROM awcms_mini_tenant_domains
    WHERE tenant_id = ${tenantId} AND id = ${id} AND deleted_at IS NULL
  `) as { status: string; verification_method: string | null }[];

  const existing = existingRows[0];

  if (!existing) {
    return { outcome: "not_found" };
  }

  if (!existing.verification_method) {
    return { outcome: "missing_verification_method" };
  }

  if (existing.status === "active") {
    const rows = (await tx`
      SELECT id, tenant_id, hostname, normalized_hostname, domain_type, route_mode, status,
        is_primary, redirect_to_primary, verification_method, verification_record_name,
        verification_record_value, verified_at, last_checked_at, created_at, updated_at,
        created_by, updated_by
      FROM awcms_mini_tenant_domains
      WHERE tenant_id = ${tenantId} AND id = ${id} AND deleted_at IS NULL
    `) as TenantDomainRow[];

    return { outcome: "verified", entry: toView(rows[0]!) };
  }

  if (
    existing.status !== "pending_verification" &&
    existing.status !== "failed"
  ) {
    return { outcome: "not_verifiable", currentStatus: existing.status };
  }

  const rows = (await tx`
    UPDATE awcms_mini_tenant_domains
    SET status = 'active', verified_at = now(), last_checked_at = now(),
        updated_by = ${actorTenantUserId}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id} AND deleted_at IS NULL
    RETURNING id, tenant_id, hostname, normalized_hostname, domain_type, route_mode, status,
      is_primary, redirect_to_primary, verification_method, verification_record_name,
      verification_record_value, verified_at, last_checked_at, created_at, updated_at,
      created_by, updated_by
  `) as TenantDomainRow[];

  return { outcome: "verified", entry: toView(rows[0]!) };
}

export type SetPrimaryTenantDomainResult =
  | { outcome: "set"; entry: TenantDomainView }
  | { outcome: "not_found" }
  | { outcome: "not_active"; currentStatus: string }
  | { outcome: "conflict" };

/**
 * Atomically makes `id` this tenant's primary domain, unsetting any
 * previous primary. "Atomic" here means: the caller already runs this
 * inside `withTenant`'s single `sql.begin(...)` transaction (Issue #562's
 * route layer), and this function performs both UPDATEs against that same
 * `tx` in a fixed order — unset the old primary (if any) FIRST, set the
 * new primary SECOND — so the partial unique index
 * (`awcms_mini_tenant_domains_primary_dedup`, `tenant_id WHERE is_primary
 * AND deleted_at IS NULL`, migration 031) is never violated mid-transaction
 * for a *sequential* swap (a tenant that already has a primary). Only an
 * `active` (i.e. verified) domain can become primary — an unverified domain
 * becoming the canonical redirect target would defeat the point of
 * verification.
 *
 * Race case this does NOT prevent structurally (post-review finding,
 * security audit of Issue #562): a tenant with **no** existing primary yet,
 * hit by two concurrent `set-primary` calls for two different domains. Both
 * transactions' "unset old primary" UPDATE matches zero rows (nothing to
 * unset), so neither blocks the other, and both proceed to the "set new
 * primary" UPDATE — one of the two loses to the unique index
 * (`awcms_mini_tenant_domains_primary_dedup`) at commit time. That's caught
 * here and mapped to `{ outcome: "conflict" }` (route maps it to a generic
 * 409) instead of letting the raw constraint-violation error surface,
 * mirroring `createTenantDomain`'s catch for the hostname-dedup index.
 */
export async function setPrimaryTenantDomain(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  id: string
): Promise<SetPrimaryTenantDomainResult> {
  const existingRows = (await tx`
    SELECT status
    FROM awcms_mini_tenant_domains
    WHERE tenant_id = ${tenantId} AND id = ${id} AND deleted_at IS NULL
  `) as { status: string }[];

  const existing = existingRows[0];

  if (!existing) {
    return { outcome: "not_found" };
  }

  if (existing.status !== "active") {
    return { outcome: "not_active", currentStatus: existing.status };
  }

  await tx`
    UPDATE awcms_mini_tenant_domains
    SET is_primary = false, updated_by = ${actorTenantUserId}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND is_primary = true AND deleted_at IS NULL AND id <> ${id}
  `;

  let rows: TenantDomainRow[];

  try {
    rows = (await tx`
      UPDATE awcms_mini_tenant_domains
      SET is_primary = true, updated_by = ${actorTenantUserId}, updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${id} AND deleted_at IS NULL
      RETURNING id, tenant_id, hostname, normalized_hostname, domain_type, route_mode, status,
        is_primary, redirect_to_primary, verification_method, verification_record_name,
        verification_record_value, verified_at, last_checked_at, created_at, updated_at,
        created_by, updated_by
    `) as TenantDomainRow[];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("awcms_mini_tenant_domains_primary_dedup")) {
      return { outcome: "conflict" };
    }

    throw error;
  }

  return { outcome: "set", entry: toView(rows[0]!) };
}
