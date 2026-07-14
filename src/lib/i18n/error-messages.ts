import type { Translator } from "./translate";

/**
 * Maps the canonical error codes (doc 05 §Error code standard, plus the
 * lifecycle-specific codes some endpoints add — `AUTH_INVALID_CREDENTIALS`,
 * `RESOURCE_CONFLICT`, `PURGE_BLOCKED_BY_DEPENDENTS`,
 * `PURGE_REQUIRES_SOFT_DELETE`, and — Issue #563 — the tenant domain
 * management API's own `HOSTNAME_CONFLICT`/`INVALID_STATUS_TRANSITION`/
 * `CONCURRENT_UPDATE`, Issue #562 — Issue #588's Cloudflare Turnstile
 * gate's own `TURNSTILE_REQUIRED`/`TURNSTILE_INVALID` — and Issue #589's
 * MFA/TOTP codes: `MFA_REQUIRED`/`MFA_DISABLED`/`MFA_ALREADY_ACTIVE`/
 * `MFA_NOT_ACTIVE`/`MFA_ENROLLMENT_NOT_FOUND`/`MFA_INVALID_CODE`/
 * `MFA_CHALLENGE_INVALID`/`MFA_MISCONFIGURED` — and Issue #590's Google
 * OIDC codes: `GOOGLE_LOGIN_DISABLED`/`GOOGLE_OAUTH_STATE_INVALID`/
 * `GOOGLE_TOKEN_EXCHANGE_FAILED`/`GOOGLE_ID_TOKEN_INVALID`/
 * `GOOGLE_ACCOUNT_NOT_LINKED`/`GOOGLE_ALREADY_LINKED`/`GOOGLE_NOT_LINKED`/
 * `GOOGLE_MISCONFIGURED` — and Issue #591's generic tenant OIDC SSO codes:
 * `SSO_DISABLED`/`SSO_PROVIDER_NOT_FOUND`/`SSO_PROVIDER_DISABLED`/
 * `SSO_PROVIDER_UNAVAILABLE`/`SSO_OAUTH_STATE_INVALID`/
 * `SSO_TOKEN_EXCHANGE_FAILED`/`SSO_ID_TOKEN_INVALID`/
 * `SSO_ACCOUNT_NOT_LINKED`/`SSO_ALREADY_LINKED`/`SSO_NOT_LINKED`/
 * `SSO_MISCONFIGURED`/`SSO_PROVIDER_KEY_CONFLICT`/`BREAK_GLASS_REQUIRED`/
 * `PASSWORD_LOGIN_DISABLED`/Issue #638's `AD_PLACEMENT_REFERENCE_INVALID`)
 * and Issue #640's content quality checklist code
 * (`CONTENT_QUALITY_CHECKLIST_BLOCKED`) and Issue #644's
 * `SOCIAL_ACCOUNT_UNSUPPORTED_TYPE` (connect-time AND dispatch-time
 * rejection of a `providerAccountType` the submitted `providerKey`'s
 * registered adapter doesn't support, e.g. a Meta account connected as
 * `"profile"`) to i18n catalog keys under the `error.` namespace. Used
 * both server-side (SSR error panels)
 * and to build the
 * client-string JSON blob admin pages inline for their fetch-based action
 * banners (see `AdminLayout.astro`'s client i18n script pattern).
 */
export const ERROR_CODE_KEYS: Record<string, string> = {
  VALIDATION_ERROR: "error.validation_error",
  AUTH_REQUIRED: "error.auth_required",
  AUTH_INVALID_CREDENTIALS: "error.auth_invalid_credentials",
  TOKEN_EXPIRED: "error.token_expired",
  ACCESS_DENIED: "error.access_denied",
  TENANT_REQUIRED: "error.tenant_required",
  RESOURCE_NOT_FOUND: "error.resource_not_found",
  RESOURCE_DELETED: "error.resource_deleted",
  RESOURCE_CONFLICT: "error.resource_conflict",
  IDEMPOTENCY_REQUIRED: "error.idempotency_required",
  IDEMPOTENCY_CONFLICT: "error.idempotency_conflict",
  WORKFLOW_APPROVAL_REQUIRED: "error.workflow_approval_required",
  STOCK_NOT_AVAILABLE: "error.stock_not_available",
  SYNC_CONFLICT: "error.sync_conflict",
  DATABASE_BUSY: "error.database_busy",
  PROVIDER_ERROR: "error.provider_error",
  INTERNAL_ERROR: "error.internal_error",
  PURGE_BLOCKED_BY_DEPENDENTS: "error.purge_blocked_by_dependents",
  PURGE_REQUIRES_SOFT_DELETE: "error.purge_requires_soft_delete",
  HOSTNAME_CONFLICT: "error.hostname_conflict",
  INVALID_STATUS_TRANSITION: "error.invalid_status_transition",
  CONCURRENT_UPDATE: "error.concurrent_update",
  TURNSTILE_REQUIRED: "error.turnstile_required",
  TURNSTILE_INVALID: "error.turnstile_invalid",
  MFA_REQUIRED: "error.mfa_required",
  MFA_DISABLED: "error.mfa_disabled",
  MFA_ALREADY_ACTIVE: "error.mfa_already_active",
  MFA_NOT_ACTIVE: "error.mfa_not_active",
  MFA_ENROLLMENT_NOT_FOUND: "error.mfa_enrollment_not_found",
  MFA_INVALID_CODE: "error.mfa_invalid_code",
  MFA_CHALLENGE_INVALID: "error.mfa_challenge_invalid",
  MFA_MISCONFIGURED: "error.mfa_misconfigured",
  GOOGLE_LOGIN_DISABLED: "error.google_login_disabled",
  GOOGLE_OAUTH_STATE_INVALID: "error.google_oauth_state_invalid",
  GOOGLE_TOKEN_EXCHANGE_FAILED: "error.google_token_exchange_failed",
  GOOGLE_ID_TOKEN_INVALID: "error.google_id_token_invalid",
  GOOGLE_ACCOUNT_NOT_LINKED: "error.google_account_not_linked",
  GOOGLE_ALREADY_LINKED: "error.google_already_linked",
  GOOGLE_NOT_LINKED: "error.google_not_linked",
  GOOGLE_MISCONFIGURED: "error.google_misconfigured",
  SSO_DISABLED: "error.sso_disabled",
  SSO_PROVIDER_NOT_FOUND: "error.sso_provider_not_found",
  SSO_PROVIDER_DISABLED: "error.sso_provider_disabled",
  SSO_PROVIDER_UNAVAILABLE: "error.sso_provider_unavailable",
  SSO_OAUTH_STATE_INVALID: "error.sso_oauth_state_invalid",
  SSO_TOKEN_EXCHANGE_FAILED: "error.sso_token_exchange_failed",
  SSO_ID_TOKEN_INVALID: "error.sso_id_token_invalid",
  SSO_ACCOUNT_NOT_LINKED: "error.sso_account_not_linked",
  SSO_ALREADY_LINKED: "error.sso_already_linked",
  SSO_NOT_LINKED: "error.sso_not_linked",
  SSO_MISCONFIGURED: "error.sso_misconfigured",
  SSO_PROVIDER_KEY_CONFLICT: "error.sso_provider_key_conflict",
  SSO_PROVIDER_LIMIT_EXCEEDED: "error.sso_provider_limit_exceeded",
  BREAK_GLASS_REQUIRED: "error.break_glass_required",
  PASSWORD_LOGIN_DISABLED: "error.password_login_disabled",
  NEWS_MEDIA_REFERENCE_INVALID: "error.news_media_reference_invalid",
  HOMEPAGE_SECTION_REFERENCE_INVALID:
    "error.homepage_section_reference_invalid",
  HOMEPAGE_SECTION_KEY_CONFLICT: "error.homepage_section_key_conflict",
  AD_PLACEMENT_REFERENCE_INVALID: "error.ad_placement_reference_invalid",
  CONTENT_QUALITY_CHECKLIST_BLOCKED: "error.content_quality_checklist_blocked",
  SOCIAL_ACCOUNT_UNSUPPORTED_TYPE: "error.social_account_unsupported_type",
  // Issue #752 (data_exchange): PAYLOAD_TOO_LARGE is the shared code
  // `bodyTooLargeResponse` (`src/lib/security/request-body-limit.ts`)
  // already returns for every endpoint using it -- previously unmapped
  // repo-wide; added here as this module's own first consumer that
  // surfaces it directly to an admin-UI error banner. INVALID_STATE and
  // CHECKSUM_MISMATCH are this module's own codes (staged-batch/export-job
  // status-transition guard and intake checksum verification).
  PAYLOAD_TOO_LARGE: "error.payload_too_large",
  INVALID_STATE: "error.invalid_state",
  CHECKSUM_MISMATCH: "error.checksum_mismatch",
  // Reviewer finding on PR #782 (High): media-type verification was
  // documented as done but never implemented -- UNSUPPORTED_MEDIA_TYPE is
  // its real error code, added alongside the fix.
  UNSUPPORTED_MEDIA_TYPE: "error.unsupported_media_type"
};

/**
 * Translates a `{ code, message }` API error into a safe, localized string.
 * Falls back to the server's raw `message` for a code with no catalog entry
 * — better to show *something* than nothing, and the server's fallback
 * messages are themselves written to be safe (doc 10 guardrail: no stack
 * traces / internal detail).
 */
export function translateErrorCode(
  t: Translator,
  code: string,
  fallbackMessage: string
): string {
  const key = ERROR_CODE_KEYS[code];

  if (!key) {
    return fallbackMessage;
  }

  const translated = t(key);

  return translated === key ? fallbackMessage : translated;
}

/**
 * Builds the `{ code: translatedMessage }` map a client-side `<script>` can
 * use to localize fetch-response error banners without needing its own
 * catalog access (the `.po` files are read server-side via `Bun.file`, not
 * shipped to the browser). See `AdminLayout.astro`'s client i18n script.
 */
export function buildClientErrorMessages(
  t: Translator
): Record<string, string> {
  const entries = Object.entries(ERROR_CODE_KEYS).map(([code, key]) => [
    code,
    t(key)
  ]);

  return Object.fromEntries(entries);
}
