import type { Translator } from "./translate";

/**
 * Maps the canonical error codes (doc 05 §Error code standard, plus the
 * lifecycle-specific codes some endpoints add — `AUTH_INVALID_CREDENTIALS`,
 * `RESOURCE_CONFLICT`, `PURGE_BLOCKED_BY_DEPENDENTS`,
 * `PURGE_REQUIRES_SOFT_DELETE`, and — Issue #563 — the tenant domain
 * management API's own `HOSTNAME_CONFLICT`/`INVALID_STATUS_TRANSITION`/
 * `CONCURRENT_UPDATE`, Issue #562) to i18n catalog keys under the `error.`
 * namespace. Used both server-side (SSR error panels) and to build the
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
  CONCURRENT_UPDATE: "error.concurrent_update"
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
