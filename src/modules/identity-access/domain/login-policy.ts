export type IdentityStatus = "active" | "inactive" | "locked";
export type TenantUserStatus = "active" | "inactive";

export function isAccountLocked(lockedUntil: Date | null, now: Date): boolean {
  return lockedUntil !== null && lockedUntil.getTime() > now.getTime();
}

export function shouldLockAccount(
  failedLoginCount: number,
  maxFailedAttempts: number
): boolean {
  return failedLoginCount >= maxFailedAttempts;
}

export function computeLockedUntil(now: Date, lockoutMinutes: number): Date {
  return new Date(now.getTime() + lockoutMinutes * 60_000);
}

export type LoginIdentitySnapshot = {
  status: IdentityStatus;
  failedLoginCount: number;
  lockedUntil: Date | null;
};

export type LoginAttemptInput = {
  now: Date;
  tenantStatus: string | null;
  identity: LoginIdentitySnapshot | null;
  tenantUserStatus: TenantUserStatus | null;
  passwordMatches: boolean;
  maxFailedAttempts: number;
  lockoutMinutes: number;
  /**
   * Issue #591 (epic: full-online auth hardening) — `true` when the
   * tenant's `awcms_mini_tenant_auth_policies.password_login_enabled` is
   * `false` AND this identity is not one of the tenant's configured
   * break-glass identities. Callers must only ever compute this when
   * `isSsoRequired(env)` is active (`login.ts`) — every local/offline/LAN
   * deployment leaves this `false` and this check is a complete no-op,
   * preserving today's login behavior exactly.
   */
  passwordLoginDisabled?: boolean;
};

export type LoginDenyReason =
  | "tenant_inactive"
  | "locked"
  | "password_login_disabled"
  | "invalid_credentials";

export type LoginAttemptResult =
  | { outcome: "allow" }
  | {
      outcome: "deny";
      reason: LoginDenyReason;
      failedLoginCount?: number;
      lockedUntil?: Date | null;
    };

export function evaluateLoginAttempt(
  input: LoginAttemptInput
): LoginAttemptResult {
  if (input.tenantStatus !== "active") {
    return { outcome: "deny", reason: "tenant_inactive" };
  }

  if (
    input.identity &&
    (input.identity.status === "locked" ||
      isAccountLocked(input.identity.lockedUntil, input.now))
  ) {
    return { outcome: "deny", reason: "locked" };
  }

  if (input.identity && input.passwordLoginDisabled) {
    return { outcome: "deny", reason: "password_login_disabled" };
  }

  const isValid =
    input.identity !== null &&
    input.identity.status === "active" &&
    input.tenantUserStatus === "active" &&
    input.passwordMatches;

  if (isValid) {
    return { outcome: "allow" };
  }

  if (!input.identity) {
    return { outcome: "deny", reason: "invalid_credentials" };
  }

  const failedLoginCount = input.identity.failedLoginCount + 1;
  const locked = shouldLockAccount(failedLoginCount, input.maxFailedAttempts);

  return {
    outcome: "deny",
    reason: "invalid_credentials",
    failedLoginCount,
    lockedUntil: locked
      ? computeLockedUntil(input.now, input.lockoutMinutes)
      : null
  };
}
