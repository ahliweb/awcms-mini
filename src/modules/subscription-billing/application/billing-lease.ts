/**
 * Cooperative per-(tenant, job_kind) lease for the scheduled billing workers
 * (Issue #876, pattern #872). A worker CLAIMS by upserting the lease row then
 * atomically taking it only if it is free or EXPIRED (a crashed worker's lease
 * expires so another safely resumes — AC worker-restart/lease). The heartbeat
 * extends the lease during a long batch; release clears the holder. All calls
 * run inside the caller's already tenant-scoped `tx`.
 */
import type { JobKind } from "../domain/job-kinds";

export const DEFAULT_LEASE_TTL_MS = 5 * 60_000;

export type LeaseGrant = {
  granted: boolean;
  holder: string | null;
  expiresAt: string | null;
  attempts: number;
};

/**
 * Claim the lease for `(tenantId, jobKind)`. Returns `{ granted: true }` iff the
 * caller `holder` now holds it (it was free or expired). Idempotent under
 * concurrency: exactly one concurrent claimant wins because the UPDATE predicate
 * (`holder IS NULL OR expires_at <= now()`) plus the row lock the UPDATE takes
 * serialize the take.
 */
export async function claimLease(
  tx: Bun.SQL,
  tenantId: string,
  jobKind: JobKind,
  holder: string,
  now: Date,
  ttlMs: number = DEFAULT_LEASE_TTL_MS
): Promise<LeaseGrant> {
  // Ensure a lease row exists (no-op if present).
  await tx`
    INSERT INTO awcms_mini_subscription_billing_job_leases (tenant_id, job_kind)
    VALUES (${tenantId}, ${jobKind})
    ON CONFLICT (tenant_id, job_kind) DO NOTHING
  `;
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const rows = (await tx`
    UPDATE awcms_mini_subscription_billing_job_leases
    SET holder = ${holder},
        leased_at = ${now.toISOString()},
        heartbeat_at = ${now.toISOString()},
        expires_at = ${expiresAt},
        attempts = attempts + 1,
        updated_at = now()
    WHERE tenant_id = ${tenantId}
      AND job_kind = ${jobKind}
      AND (holder IS NULL OR expires_at IS NULL OR expires_at <= ${now.toISOString()})
    RETURNING holder, expires_at, attempts
  `) as { holder: string; expires_at: string; attempts: number }[];
  if (rows[0]) {
    return {
      granted: true,
      holder: rows[0].holder,
      expiresAt: rows[0].expires_at,
      attempts: Number(rows[0].attempts)
    };
  }
  const held = (await tx`
    SELECT holder, expires_at, attempts
    FROM awcms_mini_subscription_billing_job_leases
    WHERE tenant_id = ${tenantId} AND job_kind = ${jobKind}
  `) as {
    holder: string | null;
    expires_at: string | null;
    attempts: number;
  }[];
  return {
    granted: false,
    holder: held[0]?.holder ?? null,
    expiresAt: held[0]?.expires_at ?? null,
    attempts: Number(held[0]?.attempts ?? 0)
  };
}

/** Extend the lease if still held by `holder`. Returns true iff extended. */
export async function heartbeatLease(
  tx: Bun.SQL,
  tenantId: string,
  jobKind: JobKind,
  holder: string,
  now: Date,
  ttlMs: number = DEFAULT_LEASE_TTL_MS
): Promise<boolean> {
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const rows = (await tx`
    UPDATE awcms_mini_subscription_billing_job_leases
    SET heartbeat_at = ${now.toISOString()}, expires_at = ${expiresAt}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND job_kind = ${jobKind} AND holder = ${holder}
    RETURNING id
  `) as { id: string }[];
  return rows.length > 0;
}

/** Release the lease held by `holder` (clears the holder). Optionally records the last error. */
export async function releaseLease(
  tx: Bun.SQL,
  tenantId: string,
  jobKind: JobKind,
  holder: string,
  lastError: string | null = null
): Promise<void> {
  await tx`
    UPDATE awcms_mini_subscription_billing_job_leases
    SET holder = NULL, expires_at = NULL, last_error = ${lastError}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND job_kind = ${jobKind} AND holder = ${holder}
  `;
}
