---
"awcms-mini": minor
---

Add the LinkedIn organization-page social publishing adapter (Issue
#645, epic `social_publishing` #643-#647): the first real
`SocialProviderAdapter` implementation (`provider_key:
"linkedin_organization"`) registered into #643's foundation outbox.

Publishes eligible news-article posts to a connected LinkedIn
organization page. Every publish attempt performs two live LinkedIn
calls (never inside a DB transaction, per ADR-0006): an
`organizationAcls` check enforcing that the connected member currently
holds a supported organization role (`ADMINISTRATOR`/`CONTENT_ADMIN` —
ads-only `DIRECT_SPONSORED_CONTENT_POSTER` is rejected), then the
actual post-creation call. Verified R2 article images are attached via
LinkedIn's real Images API (`initializeUpload` -> fetch verified bytes
-> `PUT`) gated by a defense-in-depth re-check against
`NEWS_MEDIA_R2_PUBLIC_BASE_URL`; an untrusted/missing image, or any
upload failure, degrades gracefully to a link-share post rather than
blocking the publish. Every request sends the configured
`LinkedIn-Version` header (`LINKEDIN_API_VERSION`, format `YYYYMM`) and
`X-Restli-Protocol-Version: 2.0.0`. Token expiry (401 at any stage)
maps to `needs_reauth`; provider errors are normalized into safe
internal status/error codes, and every error message is redacted of
the literal bearer token before it can reach an audit/attempt row.

New config: `LINKEDIN_PROVIDER_ENABLED`, `LINKEDIN_CLIENT_ID`,
`LINKEDIN_CLIENT_SECRET_REFERENCE` (a secret-storage reference, never
the raw secret — validated by reusing `looksLikeRawSecretToken`
verbatim), `LINKEDIN_API_VERSION`, `LINKEDIN_OAUTH_REDIRECT_URI`,
`LINKEDIN_REQUIRED_SCOPES`. No interactive OAuth authorize/callback
flow is implemented — connect/disconnect/reauthorize continue to use
#643's existing generic `POST /api/v1/social-publishing/accounts`
(upsert), consistent with every other provider in this module; the new
config vars describe the LinkedIn App an operator registers manually
(app-review requirement), not a redirect this codebase drives itself.
`bun run config:validate`/`security:readiness` gain a matching
LinkedIn-specific config-completeness check (`checkLinkedInProviderConfig`/
`checkLinkedInProviderReadiness`), static/config-only — live
token/role/scope verification happens per publish attempt via the
adapter itself, not the deployment-wide readiness gate.

No new migration or AsyncAPI event: every "Account metadata" field the
issue describes (`organization_urn`, `organization_name`,
`token_expires_at`, `last_verified_at`) already maps onto #643's
existing generic account columns, and organization role/permissions are
checked live per attempt rather than persisted (a role revoked on
LinkedIn's side must never be trusted from a stale local snapshot).
