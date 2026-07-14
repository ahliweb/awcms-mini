/**
 * `ExchangeDescriptor.requiredPermission` enforcement (Issue #752;
 * security-auditor finding on PR #782, High: the field was typed and
 * documented — "owning module may require its OWN write permission beyond
 * the generic gate" — but never actually checked anywhere, a silent
 * authorization-bypass-in-waiting for the first real owning-module adapter
 * that sets it).
 *
 * Every route handler that resolves an `ExchangeDescriptor` (stage,
 * preview, commit, retry — the actions that touch or reveal the OWNING
 * module's data shape/content — and export-create, which READS the owning
 * module's data) calls `authorizeExchangeDescriptorPermission` AFTER the
 * generic `data_exchange.*` guard passes, BEFORE performing the action.
 * Default-deny: a descriptor with a malformed `requiredPermission` string
 * denies rather than silently skipping the check.
 *
 * Deliberately NOT applied to `imports` cancel/pause/resume or `exports`
 * cancel — none of those ever call an owning module's adapter (`commitRow`/
 * `fetchRowsPage`); they are pure `data_exchange`-internal state
 * transitions that never touch or reveal the owning module's actual data,
 * so the owning module's OWN extra permission gate has nothing to protect
 * there.
 */
import { fail } from "../../_shared/api-response";
import { authorizeInTransaction } from "../../identity-access/application/access-guard";
import type { AccessAction } from "../../identity-access/domain/access-control";
import type { ExchangeDescriptor } from "../../_shared/module-contract";

export type DescriptorPermissionCheck =
  { allowed: true } | { allowed: false; denied: Response };

/**
 * `descriptor` may be `null` (an unresolvable importKey/exportKey) — the
 * caller is expected to have already handled that as its own 404 before
 * reaching a data mutation; passing `null` here is treated as "nothing
 * additional to check" so callers can resolve-then-check in either order
 * without this function throwing.
 */
export async function authorizeExchangeDescriptorPermission(
  tx: Bun.SQL,
  tenantId: string,
  tokenHash: string,
  now: Date,
  descriptor: ExchangeDescriptor | null
): Promise<DescriptorPermissionCheck> {
  if (!descriptor || !descriptor.requiredPermission) {
    return { allowed: true };
  }

  const parts = descriptor.requiredPermission.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    // A malformed descriptor-declared permission fails CLOSED, never open
    // — never silently treated as "no extra requirement".
    return {
      allowed: false,
      denied: fail(
        500,
        "INTERNAL_ERROR",
        "Exchange descriptor's requiredPermission is malformed."
      )
    };
  }

  const [moduleKey, activityCode, action] = parts as [string, string, string];

  const auth = await authorizeInTransaction(tx, tenantId, tokenHash, now, {
    moduleKey,
    activityCode,
    action: action as AccessAction
  });

  if (!auth.allowed) {
    return { allowed: false, denied: auth.denied };
  }

  return { allowed: true };
}
