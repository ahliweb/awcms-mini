/**
 * Tenant authentication policy CRUD (Issue #591, epic: full-online auth
 * hardening) over `awcms_mini_tenant_auth_policies` (migration 036) — same
 * "one row per tenant, upsert, no `id` in the URL" shape as
 * `blog-settings-directory.ts`. `saveTenantAuthPolicy` is the ONE place
 * that enforces the issue's own acceptance criterion "`sso_required=true`
 * cannot be enabled unless at least one break-glass local owner remains
 * available" — checked here, at save time, against a fresh DB read of the
 * candidate break-glass identities' current status, never trusted from the
 * request body alone.
 */
import {
  evaluateBreakGlassRequirement,
  type UpdateTenantAuthPolicyInput
} from "../domain/tenant-sso-policy";

export type TenantAuthPolicyView = {
  tenantId: string;
  passwordLoginEnabled: boolean;
  ssoEnabled: boolean;
  ssoRequired: boolean;
  autoLinkVerifiedEmail: boolean;
  allowedEmailDomains: string[];
  breakGlassIdentityIds: string[];
  mfaRequired: boolean;
  updatedAt: string | null;
};

const DEFAULT_POLICY_VIEW: Omit<TenantAuthPolicyView, "tenantId"> = {
  passwordLoginEnabled: true,
  ssoEnabled: false,
  ssoRequired: false,
  autoLinkVerifiedEmail: false,
  allowedEmailDomains: [],
  breakGlassIdentityIds: [],
  mfaRequired: false,
  updatedAt: null
};

type TenantAuthPolicyRow = {
  password_login_enabled: boolean;
  sso_enabled: boolean;
  sso_required: boolean;
  auto_link_verified_email: boolean;
  allowed_email_domains: unknown;
  break_glass_identity_ids: unknown;
  mfa_required: boolean;
  updated_at: Date;
};

function toArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

/** Returns the tenant's policy, or the safe backward-compatible default (password login enabled, SSO disabled) when no row has ever been saved — every deployment that never touches this endpoint behaves exactly as it did before this issue. */
export async function getTenantAuthPolicy(
  tx: Bun.SQL,
  tenantId: string
): Promise<TenantAuthPolicyView> {
  const rows = (await tx`
    SELECT password_login_enabled, sso_enabled, sso_required,
           auto_link_verified_email, allowed_email_domains,
           break_glass_identity_ids, mfa_required, updated_at
    FROM awcms_mini_tenant_auth_policies
    WHERE tenant_id = ${tenantId}
  `) as TenantAuthPolicyRow[];
  const row = rows[0];

  if (!row) {
    return { tenantId, ...DEFAULT_POLICY_VIEW };
  }

  return {
    tenantId,
    passwordLoginEnabled: row.password_login_enabled,
    ssoEnabled: row.sso_enabled,
    ssoRequired: row.sso_required,
    autoLinkVerifiedEmail: row.auto_link_verified_email,
    allowedEmailDomains: toArray(row.allowed_email_domains),
    breakGlassIdentityIds: toArray(row.break_glass_identity_ids),
    mfaRequired: row.mfa_required,
    updatedAt: row.updated_at.toISOString()
  };
}

/**
 * Counts how many of `breakGlassIdentityIds` currently resolve to an
 * identity that can actually still complete a local password login in this
 * tenant: the identity exists, belongs to this tenant, `status = 'active'`,
 * and has an `active` `awcms_mini_tenant_users` membership. Every identity
 * row always has a `password_hash` (NOT NULL, migration 004 — there is no
 * "SSO-only identity" model in this schema), so this is a sufficient
 * eligibility check without inspecting `password_hash` itself.
 *
 * Exported (Issue #593) so `scripts/security-readiness.ts`'s
 * `checkSsoBreakGlassReady` can re-derive the SAME eligibility rule at
 * readiness/go-live time — a break-glass identity that was eligible when
 * `saveTenantAuthPolicy` last validated it can become ineligible later
 * (deactivated, membership revoked) without the policy row itself ever
 * being re-saved, so save-time validation alone cannot catch that drift.
 * Do not reimplement this query a second, divergent way elsewhere.
 */
export async function countEligibleBreakGlassIdentities(
  tx: Bun.SQL,
  tenantId: string,
  breakGlassIdentityIds: string[]
): Promise<number> {
  if (breakGlassIdentityIds.length === 0) {
    return 0;
  }

  const rows = (await tx`
    SELECT i.id
    FROM awcms_mini_identities i
    JOIN awcms_mini_tenant_users tu
      ON tu.tenant_id = i.tenant_id AND tu.identity_id = i.id
    WHERE i.tenant_id = ${tenantId}
      AND i.id = ANY(${tx.array(breakGlassIdentityIds, "uuid")})
      AND i.status = 'active'
      AND tu.status = 'active'
  `) as { id: string }[];

  return rows.length;
}

export type SaveTenantAuthPolicyResult =
  | { outcome: "saved"; policy: TenantAuthPolicyView }
  | { outcome: "break_glass_required" };

export async function saveTenantAuthPolicy(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: UpdateTenantAuthPolicyInput
): Promise<SaveTenantAuthPolicyResult> {
  const current = await getTenantAuthPolicy(tx, tenantId);

  const passwordLoginEnabled =
    input.passwordLoginEnabled ?? current.passwordLoginEnabled;
  const ssoEnabled = input.ssoEnabled ?? current.ssoEnabled;
  const ssoRequired = input.ssoRequired ?? current.ssoRequired;
  const autoLinkVerifiedEmail =
    input.autoLinkVerifiedEmail ?? current.autoLinkVerifiedEmail;
  const allowedEmailDomains =
    input.allowedEmailDomains ?? current.allowedEmailDomains;
  const breakGlassIdentityIds =
    input.breakGlassIdentityIds ?? current.breakGlassIdentityIds;

  const eligibleBreakGlassCount = await countEligibleBreakGlassIdentities(
    tx,
    tenantId,
    breakGlassIdentityIds
  );

  const breakGlassEvaluation = evaluateBreakGlassRequirement({
    passwordLoginEnabled,
    ssoRequired,
    breakGlassIdentityIds,
    eligibleBreakGlassCount
  });

  if (breakGlassEvaluation.outcome === "invalid") {
    return { outcome: "break_glass_required" };
  }

  const rows = (await tx`
    INSERT INTO awcms_mini_tenant_auth_policies
      (tenant_id, password_login_enabled, sso_enabled, sso_required,
       auto_link_verified_email, allowed_email_domains,
       break_glass_identity_ids, updated_by)
    VALUES (
      ${tenantId}, ${passwordLoginEnabled}, ${ssoEnabled}, ${ssoRequired},
      ${autoLinkVerifiedEmail}, ${allowedEmailDomains},
      ${breakGlassIdentityIds}, ${actorTenantUserId}
    )
    ON CONFLICT (tenant_id) DO UPDATE SET
      password_login_enabled = ${passwordLoginEnabled},
      sso_enabled = ${ssoEnabled},
      sso_required = ${ssoRequired},
      auto_link_verified_email = ${autoLinkVerifiedEmail},
      allowed_email_domains = ${allowedEmailDomains},
      break_glass_identity_ids = ${breakGlassIdentityIds},
      updated_at = now(),
      updated_by = ${actorTenantUserId}
    RETURNING password_login_enabled, sso_enabled, sso_required,
              auto_link_verified_email, allowed_email_domains,
              break_glass_identity_ids, mfa_required, updated_at
  `) as TenantAuthPolicyRow[];
  const row = rows[0]!;

  return {
    outcome: "saved",
    policy: {
      tenantId,
      passwordLoginEnabled: row.password_login_enabled,
      ssoEnabled: row.sso_enabled,
      ssoRequired: row.sso_required,
      autoLinkVerifiedEmail: row.auto_link_verified_email,
      allowedEmailDomains: toArray(row.allowed_email_domains),
      breakGlassIdentityIds: toArray(row.break_glass_identity_ids),
      mfaRequired: row.mfa_required,
      updatedAt: row.updated_at.toISOString()
    }
  };
}

/**
 * Login-time enforcement (issue's own acceptance criterion: "Existing
 * password login remains available unless tenant policy explicitly
 * restricts it and break-glass is valid"). Returns `true` only when
 * password login should be REJECTED for this specific identity: the
 * tenant's policy has `password_login_enabled = false` AND this identity is
 * not one of the configured break-glass identities. Deliberately a single
 * cheap read (no join/eligibility re-check — an identity already listed as
 * break-glass is trusted here; `saveTenantAuthPolicy` is what guarantees
 * the list contains at least one currently-eligible identity at save time).
 * Callers (`login.ts`) must gate this behind `isSsoRequired(env)` — a
 * deployment that never enables the #591 feature must never run this extra
 * query or change login behavior at all.
 */
export async function isPasswordLoginDisabledForIdentity(
  tx: Bun.SQL,
  tenantId: string,
  identityId: string
): Promise<boolean> {
  const rows = (await tx`
    SELECT password_login_enabled, break_glass_identity_ids
    FROM awcms_mini_tenant_auth_policies
    WHERE tenant_id = ${tenantId}
  `) as {
    password_login_enabled: boolean;
    break_glass_identity_ids: unknown;
  }[];
  const row = rows[0];

  if (!row || row.password_login_enabled) {
    return false;
  }

  const breakGlassIds = toArray(row.break_glass_identity_ids);
  return !breakGlassIds.includes(identityId);
}
