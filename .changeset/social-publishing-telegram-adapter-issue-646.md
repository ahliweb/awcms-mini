---
"awcms-mini": minor
---

Add the Telegram channel publishing adapter (Issue #646, epic
`social_publishing` #643-#647) — the first real provider adapter
registered into the `social_publishing` outbox foundation's provider
registry (`provider_key: "telegram_channel"`).

Configuration is gated by a second, provider-specific flag
(`TELEGRAM_PROVIDER_ENABLED`) layered on top of the outer
`SOCIAL_PUBLISHING_ENABLED`/`SOCIAL_PUBLISHING_PROFILE` gate. The bot
token is stored only as a secret-storage reference
(`TELEGRAM_BOT_TOKEN_SECRET_REFERENCE`, and per-connected-account
`token_reference`) — reuses the existing write-time
`looksLikeRawSecretToken` heuristic rather than a new one.

Publishing sends a safe `sendMessage` link post (title, excerpt,
canonical URL) with `parse_mode` omitted by default — plain text, so no
Telegram Markdown/HTML formatting can ever be interpreted out of
user-authored article titles/excerpts. An operator can opt into
`MarkdownV2`/`HTML` (`TELEGRAM_DEFAULT_PARSE_MODE`), in which case every
interpolated field is escaped per Telegram's own escaping rules
(`telegram-message-formatting.ts`) before being sent. Provider errors
(missing channel permission, invalid channel, invalid bot token, rate
limiting) are normalized into safe internal outcomes
(`failed`/`needs_reauth`/`rate_limited`) without ever leaking the bot
token — which Telegram's Bot API embeds directly in the request URL path
— into a log line, error message, or audit record.

Adds a new, provider-neutral `POST
/api/v1/social-publishing/accounts/{id}/verify` endpoint (permission
`social_publishing.accounts.verify`, migration
`054_awcms_mini_social_publishing_verify_permission.sql`) so an admin can
confirm a bot can post to its target channel before enabling
auto-posting; a new critical readiness check
(`checkTelegramProviderReadiness`) flags any auto-publishing
`telegram_channel` account that has never been verified.
