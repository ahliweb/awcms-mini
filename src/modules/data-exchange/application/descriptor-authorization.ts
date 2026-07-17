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
import { resolveModuleEnabled } from "../../identity-access/application/auth-context";
import type { AccessAction } from "../../identity-access/domain/access-control";
import type { ExchangeDescriptor } from "../../_shared/module-contract";

export type DescriptorPermissionCheck =
  { allowed: true } | { allowed: false; denied: Response };

/**
 * The same decision as `authorizeDescriptorPermissionKey` below, for a caller
 * that has an already-resolved permission set instead of a bearer token — the
 * SSR admin screens, whose `Astro.locals.ssrContext` carries the caller's
 * granted permission keys (`src/lib/auth/ssr-session.ts` builds it with the
 * very same `fetchGrantedPermissionKeys` the bearer-token guard uses) and
 * which have no token to authorize with.
 *
 * It exists because `src/pages/admin/data-exchange/imports/[id].astro` does
 * NOT go through the preview route — it queries and projects staged rows
 * itself (see that page's own note) — and so needs its own call site for the
 * descriptor gates. PR #839's security review found the page had replicated
 * the raw-value decision but never made the `requiredPermission` one at all:
 * a descriptor requiring, say, `hr.payroll.read` was enforced by all six API
 * routes and by nothing in the UI, so a holder of the generic
 * `data_exchange.imports.read` could read the owning module's staged content
 * (natural keys, validation errors, reconciliation) straight off the page.
 *
 * Takes `tx`/`tenantId` and resolves tenant module state ITSELF rather than
 * accepting a plain permission set, because a permission set is NOT the whole
 * route decision and reviewing it as if it were is what went wrong the first
 * time. `authorizeInTransaction` denies `403 MODULE_DISABLED` on
 * `resolveModuleEnabled` BEFORE it ever evaluates RBAC, and
 * `fetchGrantedPermissionKeys` does not filter disabled modules out of its
 * result — so a subject keeps every permission key of a module that has been
 * switched off for their tenant. Checking only `permissions.has(key)` made
 * the SSR page LOOSER than the API on that axis: with the owning module
 * disabled, preview/commit answered 403 while the page still rendered the
 * staged rows. Same parity failure as the original finding, different axis;
 * the module check is therefore inside this function, where neither caller
 * can forget it, and in the same order as the route (module, then RBAC).
 *
 * Fails closed identically to the route path: a malformed key is `false`,
 * never "no requirement". `undefined` — a descriptor genuinely declaring no
 * extra requirement — is a legitimate allow, exactly as in
 * `authorizeExchangeDescriptorPermission` (there is no module to resolve for
 * a requirement that was never declared; the page's generic
 * `data_exchange.*` gate is a separate matter — see this file's footer note).
 */
export async function isDescriptorPermissionGranted(
  tx: Bun.SQL,
  tenantId: string,
  permissions: ReadonlySet<string>,
  permissionKey: string | undefined
): Promise<boolean> {
  if (permissionKey === undefined) {
    return true;
  }

  const parts = permissionKey.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    return false;
  }

  const [moduleKey] = parts as [string, string, string];

  // Module state first, exactly as `authorizeInTransaction` orders it: a
  // permission key belonging to a module this tenant has disabled grants
  // nothing, however the key itself was obtained.
  if (!(await resolveModuleEnabled(tx, tenantId, moduleKey))) {
    return false;
  }

  return permissions.has(permissionKey);
}

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
