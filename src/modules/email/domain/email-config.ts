/**
 * Email configuration boundary (Issue #493, epic #492). Pure — no
 * `process.env` reads here; `scripts/validate-env.ts` and (from Issue #495
 * onward) the provider resolver both pass in whatever `env` they were
 * given, the same split `checkSyncConfig`/`checkR2Config` already use.
 *
 * Naming: every real variable here is namespaced `EMAIL_*` /
 * `EMAIL_MAILKETING_*` — deliberately distinct from the `MAILKETING_ENABLED`
 * / `MAILKETING_API_TOKEN` rows in doc 18 §Provider CRM (opsional), which
 * are domain-illustrative example content for a retail/POS "email receipt"
 * feature (historical issue #390, closed `not planned`). This module is
 * generic infrastructure (password reset, system announcements, workflow
 * notifications — Issues #496/#497) that happens to also use Mailketing as
 * its one shipped adapter; the distinct prefix keeps the two from ever
 * being confused as the same flag. See `../README.md` §Relationship to
 * historical issue #390.
 */

export const KNOWN_EMAIL_PROVIDERS = ["mailketing"] as const;

export type EmailProviderKind = (typeof KNOWN_EMAIL_PROVIDERS)[number];

export function isKnownEmailProvider(
  value: string | undefined
): value is EmailProviderKind {
  return (KNOWN_EMAIL_PROVIDERS as readonly string[]).includes(value ?? "");
}

export const DEFAULT_EMAIL_SEND_TIMEOUT_MS = 10_000;
export const DEFAULT_EMAIL_SEND_MAX_RETRIES = 5;
export const DEFAULT_EMAIL_FROM_NAME = "AWCMS-Mini";

/** Env var names required when `EMAIL_ENABLED=true`, regardless of provider. */
export const EMAIL_REQUIRED_WHEN_ENABLED = ["EMAIL_FROM_ADDRESS"] as const;

/** Env var names required when `EMAIL_ENABLED=true` and `EMAIL_PROVIDER=mailketing`. */
export const EMAIL_MAILKETING_REQUIRED_WHEN_SELECTED = [
  "EMAIL_MAILKETING_ACCOUNT_ID",
  "EMAIL_MAILKETING_API_TOKEN",
  "EMAIL_MAILKETING_API_BASE_URL"
] as const;

export function resolveEmailSendTimeoutMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = Number(env.EMAIL_SEND_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_EMAIL_SEND_TIMEOUT_MS;
}

export function resolveEmailSendMaxRetries(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = Number(env.EMAIL_SEND_MAX_RETRIES);
  return Number.isFinite(raw) && raw >= 0
    ? raw
    : DEFAULT_EMAIL_SEND_MAX_RETRIES;
}
