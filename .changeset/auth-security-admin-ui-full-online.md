---
"awcms-mini": minor
---

Add admin UI for full-online auth security policy (Issue #592, epic
#587-#593) — a new `/admin/security` page that surfaces and edits what
#587-#591 already built, without re-implementing any of their
enforcement. Consumes the existing admin CRUD API from #591
(`GET/PATCH /api/v1/identity/sso/policy`,
`GET/POST/PATCH/DELETE /api/v1/identity/sso/providers[/{id}]`) — no new
API endpoints were needed for this issue.

The page has two independent, server-side-enforced gates:

1. **Deployment gate** (`isFullOnlineSecurityActive(env)`, #587) — on
   every local/offline/LAN deployment (the default), the page renders
   ONLY an informational notice ("Full-online auth hardening is disabled
   for this deployment profile") and nothing else: no status summary, no
   policy form, no provider list/forms. This is checked in the page's own
   SSR frontmatter before any of that markup is even generated, not
   hidden with CSS.
2. **ABAC permission** (`identity_access.sso_policy.*`/`sso_providers.*`,
   migration 037, already seeded by #591) — when the gate is active but
   the caller holds neither permission, the page renders an
   access-denied notice instead of crashing or exposing a broken form.

When both are satisfied, the page shows: the shared gate's status plus
Turnstile/MFA/Google-login/SSO enabled+configured flags (new
`src/lib/auth/auth-security-status.ts`, a pure env-only aggregator — no
provider credential value is ever exposed, only `configured: true/false`
booleans built from each feature's own `*_REQUIRED_WHEN_ENABLED` env var
list); an editable tenant authentication policy form (password login
enabled, SSO enabled/required, auto-link-by-verified-email, allowed email
domains, break-glass local owners); and a tenant SSO provider
list/create/edit/soft-delete UI. Client secret fields are write-only —
never pre-filled or round-tripped from the API on edit.

Break-glass UX: the form always shows the break-glass requirement inline
next to `sso_required`/"disable password login", blocks an
obviously-doomed submit client-side (no break-glass identity selected at
all), and surfaces the server's authoritative `409 BREAK_GLASS_REQUIRED`
rejection through the same translated error-message banner every other
mutation on the page uses — the eligibility check itself is never
re-implemented client-side, only the server's own decision (#591's
`saveTenantAuthPolicy`) is trusted.

`StateNotice.astro` gains a third `kind="info"` variant (`role="status"`,
distinct from the existing `"denied"`/`"error"` kinds) for this
deployment-profile-disabled state — a neutral fact, not a permission
problem or a failure. `identity_access`'s module descriptor now declares
an admin navigation entry (`/admin/security`, gated on
`identity_access.sso_policy.read`) so the page appears in the admin
sidebar via the existing module-navigation registry, no `AdminLayout.astro`
changes needed.

New tests: `tests/unit/auth-security-status.test.ts` (the status
aggregator); `tests/integration/admin-security-ui.integration.test.ts`
(PATCH policy requires `sso_policy.update`, ABAC default-deny; a
successful policy update and provider create/delete each write their own
audit event; a break-glass-rejected policy update writes no audit event);
`tests/e2e/admin-security-disabled.e2e.ts` and
`tests/e2e/admin-security-enabled.e2e.ts` (Playwright — the two rendering
states, gate off vs gate on, seeded via a direct-SQL owner/tenant fixture
since `POST /setup/initialize` is a once-only singleton lock).

i18n: new `admin.layout.nav_security` and `admin.security.*` strings
(`en`/`id`) — no new error codes were needed, every code this page's
mutations can return (`BREAK_GLASS_REQUIRED`, `SSO_PROVIDER_KEY_CONFLICT`,
`SSO_MISCONFIGURED`, etc.) already had catalog entries from #591.

Docs updated: `src/modules/identity-access/README.md`, skill
`awcms-mini-auth-online-hardening`.
