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
 * Authorizes one descriptor-declared permission key (`module.activity.
 * action`) against the caller. A malformed key fails CLOSED (500), never
 * open — a declaration the base cannot parse is never silently downgraded
 * to "no requirement". Shared by `requiredPermission` (the descriptor-level
 * gate below) and `sensitiveFields.rawValuePermission` (the raw-value gate
 * in `imports/[id]/preview.ts`), so both enforce the SAME semantics from
 * one place (Issue #820 Cacat 2: `rawValuePermission` had zero enforcement
 * sites and the route hardcoded a broader permission instead).
 */
export async function authorizeDescriptorPermissionKey(
  tx: Bun.SQL,
  tenantId: string,
  tokenHash: string,
  now: Date,
  permissionKey: string,
  malformedMessage: string
): Promise<DescriptorPermissionCheck> {
  const parts = permissionKey.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    return {
      allowed: false,
      denied: fail(500, "INTERNAL_ERROR", malformedMessage)
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

/**
 * `descriptor` is deliberately NON-nullable (Issue #820 Cacat 3). It used
 * to accept `null` — an importKey/exportKey resolving to nothing, which
 * happens when the owning module is disabled/removed via `module_management`
 * AFTER a batch was staged — and treat it as "nothing additional to check",
 * returning `{ allowed: true }`. That directly contradicted this file's own
 * fail-closed contract: an unregistered key skipped the descriptor gate
 * entirely, so a batch became MORE open once its owning module was switched
 * off.
 *
 * Fail-open is now unrepresentable rather than merely discouraged: every
 * caller must decide what an unresolvable descriptor means for ITS route
 * before it can call this at all (`imports`/`exports` create and `imports`
 * retry answer 404 for an unknown key/batch; `imports/[id]/preview` denies
 * — see each call site). `requiredPermission === undefined` — a resolvable
 * descriptor that genuinely declares no extra requirement — remains a
 * legitimate allow, and is now a strictly separate, unrelated branch.
 */
export async function authorizeExchangeDescriptorPermission(
  tx: Bun.SQL,
  tenantId: string,
  tokenHash: string,
  now: Date,
  descriptor: ExchangeDescriptor
): Promise<DescriptorPermissionCheck> {
  if (!descriptor.requiredPermission) {
    return { allowed: true };
  }

  return authorizeDescriptorPermissionKey(
    tx,
    tenantId,
    tokenHash,
    now,
    descriptor.requiredPermission,
    "Exchange descriptor's requiredPermission is malformed."
  );
}
