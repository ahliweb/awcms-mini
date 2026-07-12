/**
 * Telegram channel adapter configuration boundary (Issue #646, epic
 * `social_publishing` #643-#647). Pure — no `process.env` reads except the
 * default parameter value, same split every other conditional-provider
 * config file in this repo uses (`social-publishing/domain/
 * social-publishing-config.ts`, `email/domain/email-config.ts`).
 *
 * `TELEGRAM_PROVIDER_ENABLED` is a SECOND, provider-specific gate layered on
 * top of the outer `SOCIAL_PUBLISHING_ENABLED`/`SOCIAL_PUBLISHING_PROFILE`
 * deployment gate (`social-publishing-config.ts`) — the outer gate can be
 * "on" for a deployment running Meta/LinkedIn while Telegram itself is
 * still being provisioned (or intentionally never enabled). The adapter
 * (`../infrastructure/telegram-provider-adapter.ts`) checks BOTH before ever
 * calling `api.telegram.org` — registration in `social-provider-registry.ts`
 * happens unconditionally (registration just wires the code up; it makes no
 * network call by itself), enablement is what actually allows an outbound
 * call.
 *
 * `TELEGRAM_BOT_TOKEN_SECRET_REFERENCE` mirrors `EMAIL_MAILKETING_ACCOUNT_ID`'s
 * role (see `email/infrastructure/mailketing-provider.ts`'s header comment):
 * kept primarily as an operator-facing deployment-readiness signal ("has
 * this deployment actually provisioned a Telegram bot integration") rather
 * than a literal runtime API parameter — the adapter resolves the REAL bot
 * token per-connected-account from that account's own `token_reference`
 * (passed into `publish()`/`verifyCredentials()` by the dispatcher/route),
 * using the identical `env:VAR_NAME` indirection convention. A deployment
 * that runs one shared bot across every tenant's channel would typically set
 * every connected account's `token_reference` to the SAME `env:...` value as
 * this deployment-level default; a deployment where different tenants use
 * their own bot would set each account's `token_reference` to point at that
 * tenant's own env var instead. Either way this variable's job is limited to
 * `config:validate`/`security:readiness` — "is Telegram configured at all
 * for this deployment" — never a hidden fallback silently substituted into a
 * per-account resolution.
 */
export function isTelegramProviderEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.TELEGRAM_PROVIDER_ENABLED === "true";
}

export const DEFAULT_TELEGRAM_REQUEST_TIMEOUT_MS = 10_000;

export function resolveTelegramRequestTimeoutMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = Number(env.TELEGRAM_REQUEST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_TELEGRAM_REQUEST_TIMEOUT_MS;
}

/**
 * Known-safe reference PREFIX only (matches
 * `social-account-validation.ts`'s `KNOWN_SECRET_REFERENCE_PREFIX_PATTERN`
 * shape) — validated by `checkTelegramProviderConfig`
 * (`scripts/validate-env.ts`) and reused by the adapter's own resolution
 * helper (`telegram-provider-adapter.ts`'s `resolveTelegramBotToken`).
 */
export function resolveTelegramBotTokenSecretReference(
  env: NodeJS.ProcessEnv = process.env
): string {
  return env.TELEGRAM_BOT_TOKEN_SECRET_REFERENCE?.trim() ?? "";
}

/**
 * Telegram supports 3 parse modes historically; legacy `"Markdown"` is
 * deliberately EXCLUDED from the known set (Telegram's own docs mark it
 * deprecated in favor of `MarkdownV2`, and its escaping rules are
 * inconsistent/incomplete in ways `MarkdownV2` fixed) — only `"MarkdownV2"`
 * and `"HTML"` are accepted. Anything else (unset, empty string, `"Markdown"`,
 * garbage) resolves to `undefined`, meaning "send with no `parse_mode` at
 * all" — Telegram then treats the entire message as 100% literal text, no
 * formatting/link/mention syntax is ever interpreted, regardless of what
 * characters the message contains. This fail-safe default is exactly the
 * acceptance criterion "Markdown/HTML parse mode is sanitized or disabled by
 * default to avoid formatting injection" — see
 * `telegram-message-formatting.ts` for the escaping applied when a tenant
 * (deployment operator, since this is an env-level config per the issue's
 * own "Configuration" field list, not a per-tenant DB column) explicitly
 * opts into one of the two supported modes.
 */
export const KNOWN_TELEGRAM_PARSE_MODES = ["MarkdownV2", "HTML"] as const;

export type TelegramParseMode = (typeof KNOWN_TELEGRAM_PARSE_MODES)[number];

export function isKnownTelegramParseMode(
  value: string | undefined
): value is TelegramParseMode {
  return (KNOWN_TELEGRAM_PARSE_MODES as readonly string[]).includes(
    value ?? ""
  );
}

/** `undefined` (plain text, safe default) unless explicitly set to a known, supported value. Never throws on an unrecognized value — treats it the same as unset. */
export function resolveTelegramDefaultParseMode(
  env: NodeJS.ProcessEnv = process.env
): TelegramParseMode | undefined {
  const raw = env.TELEGRAM_DEFAULT_PARSE_MODE;
  return isKnownTelegramParseMode(raw) ? raw : undefined;
}
