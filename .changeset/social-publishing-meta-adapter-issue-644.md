---
"awcms-mini": minor
---

Add the Meta (Facebook Page + Instagram Business) social publishing
adapter (Issue #644, epic `social_publishing` #643-#647) on top of the
#643 provider-neutral outbox foundation.

Registers two real adapters — `meta_facebook_page` (Graph API `POST
/{page-id}/feed` link posts) and `meta_instagram` (a 2-call
media-container-then-publish flow to a linked Instagram Business
Account, with best-effort permalink resolution) —
`src/modules/social-publishing/infrastructure/meta/`, into the
foundation's provider registry. Every Graph API call goes through an
injectable `MetaGraphClient` (fetch-based, timeout-bounded, mirroring
`email/infrastructure/mailketing-provider.ts`'s existing testable-client
pattern) — no real network call to Meta exists in this repo's test
suite.

Adapter-level config: `META_PROVIDER_ENABLED`, `META_APP_ID`,
`META_APP_SECRET_REFERENCE` (a secret-storage reference, never a raw
app secret — rejected at boot if it looks like one, reusing
`social-account-validation.ts`'s `looksLikeRawSecretToken` verbatim),
`META_GRAPH_API_VERSION`, `META_OAUTH_REDIRECT_URI`,
`META_REQUIRED_SCOPES` — independent of the foundation's
`SOCIAL_PUBLISHING_ENABLED`/`_PROFILE` deployment gate. New boot check
(`checkMetaSocialPublishingProviderConfig`, `bun run config:validate`)
and a new critical readiness check
(`checkMetaSocialPublishingAccountReadiness`, `bun run
security:readiness`) covering missing config, missing scopes, expired
token, and unsupported account type per connected Meta account.

New endpoint `POST /api/v1/social-publishing/accounts/{id}/verify` (any
provider, not Meta-specific in shape) calls the account's adapter's
`verifyCredentials` — for Meta, a live Graph API `debug_token` check —
entirely outside any DB transaction; a finding that the token/scopes are
no longer valid transitions the account to `needs_reauth` (`409
SOCIAL_ACCOUNT_NEEDS_REAUTH`), reusing the same transition path the
outbox dispatcher already uses. Tenant admin can trigger this from a new
"Verify connection" button on `/admin/social-publishing/accounts`.
Connect/disconnect of Meta accounts reuse the foundation's existing
generic account endpoints unchanged.

Content eligibility and R2 media re-verification are enforced before any
provider call: Facebook Page posts need a canonical URL + caption (no
image required — Facebook's own link-preview scraper supplies one);
Instagram posts require a verified R2 image URL and reject a URL that
doesn't match the deployment's configured `NEWS_MEDIA_R2_PUBLIC_BASE_URL`
origin exactly (defense-in-depth on top of the already-guaranteed
verified-media invariant from the job-creation pipeline). Provider
errors are normalized into a small fixed catalog of safe internal status/
error codes (`meta_oauth_exception_190`, `meta_rate_limited_32`, ...) —
Meta's own raw error message/trace id is never included in a stored
`errorMessage`, log line, or API response.
