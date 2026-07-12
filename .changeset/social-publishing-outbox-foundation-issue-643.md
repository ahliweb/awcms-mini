---
"awcms-mini": minor
---

Add the `social_publishing` module (Issue #643, epic `social_publishing`
#643-#647): a provider-neutral social auto-posting outbox and connector
foundation, full-online-only (`SOCIAL_PUBLISHING_ENABLED`/
`SOCIAL_PUBLISHING_PROFILE=full_online`, mirroring the established
`AUTH_ONLINE_SECURITY_*` gate pattern).

Adds six tenant-scoped, RLS-protected tables
(`sql/053_awcms_mini_social_publishing_schema.sql`): social account
connections (`awcms_mini_social_accounts`, secret tokens stored only as
an opaque `token_reference` pointer into external secret storage —
never plain text, rejected by a write-time heuristic if it looks like a
raw JWT/access token), publish rules (`awcms_mini_social_publish_rules`,
one per account/trigger-event with an optional approval gate), caption
templates (`awcms_mini_social_publish_templates`), an idempotent outbox
(`awcms_mini_social_publish_jobs`, unique per article/account/action via
a deterministic idempotency key), an append-only attempt audit trail
(`awcms_mini_social_publish_attempts`), and a per-tenant auto-posting
master switch (`awcms_mini_social_publishing_settings`).

Publishing jobs are created (idempotently, snapshotting title/excerpt/
canonical URL/verified R2 image) right after an eligible
(public+published, never draft/private/archived/soft-deleted) article
publishes — via a new `SocialPublishingPort` (`_shared/ports/`) that
`blog_content`'s publish route and scheduled-publish worker call, inside
the same DB transaction as the publish itself (plain outbox-row writes
only, no external call — ADR-0006 compliant). The actual provider call
happens later, entirely outside any transaction, via a new
claim/call/finalize dispatcher (`bun run social-publishing:dispatch`)
with per-provider circuit breaker, timeout, and exponential retry/
backoff to a terminal `failed` state; rate-limited and needs-reauth
outcomes are handled distinctly (the latter also flips the linked
account to `needs_reauth`).

This is a FOUNDATION issue: it ships a pluggable
`SocialProviderAdapter` interface and an empty provider registry — zero
real Meta/LinkedIn/Telegram HTTP calls exist anywhere in this module
(those are separate adapter issues #644/#645/#646). A new readiness
check (`checkSocialPublishingProviderReadiness`, critical) fails if any
tenant has a connected account whose provider has no adapter registered.

New admin UI (`/admin/social-publishing/{accounts,rules,jobs}`), REST
API (`/api/v1/social-publishing/**`, OpenAPI fragment
`openapi/modules/social-publishing.openapi.yaml`), and AsyncAPI domain
events (`awcms-mini.social-publishing.*`). ABAC default-deny with ten
new permissions (`social_publishing.{accounts,rules,jobs,logs}.*`);
`connect`/`disconnect` join `AccessAction`/`HIGH_RISK_ACTIONS`.
Connect/disconnect/approve/cancel/retry require `Idempotency-Key`.
