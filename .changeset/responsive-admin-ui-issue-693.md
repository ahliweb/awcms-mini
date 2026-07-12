---
"awcms-mini": minor
---

Add responsive admin navigation and a reusable admin component library
(Issue #693, epic #679 platform-hardening).

**Responsive sidebar/drawer** (`src/layouts/AdminLayout.astro`): below
`--bp-md` (768px) the previously-static, always-visible sidebar becomes an
off-canvas drawer toggled by a new hamburger button (`#admin-nav-toggle`).
Opening it moves focus to the first nav link, traps Tab/Shift+Tab within
the drawer, adds a click-to-close scrim, closes on `Escape` with focus
returned to the toggle button, and marks the rest of the page `inert`
while it's open. Desktop (`--bp-md`+) is unchanged: sidebar always visible,
toggle hidden. The pre-existing skip link and `aria-current="page"` active-
route marking are untouched. Also fixed the active-nav-link fill to use
`--color-primary-strong` instead of the plain token (Issue #434's own AA
contrast fix, missed on this one selector).

**New `src/components/ui` primitives**: `DataTable` (scrollable table
shell + accessible caption + standard empty row), `Pagination` (keyset
prev/next, dispatches `awcms:paginate`), `FilterBar` (labelled filter
toolbar), `ActionBanner` (extracted from a `<div id="action-banner">` block
duplicated across most admin pages), `ConfirmDialog` (native `<dialog>` +
new `src/lib/ui/confirm-dialog-client.ts` helper — replaces
`window.confirm`/`window.prompt` for destructive actions with a real focus-
trapped, Escape-closing, optionally reason-required dialog), `FormField`
(label+control+hint+error wrapper), and `StatusBadge` (generalizes the
`.status-pill` pattern, `-strong` fill tokens for AA contrast).

**`TenantBadge.astro` replaces `TenantSwitcher.astro`**: the previous
component rendered a `<select disabled>` styled like a real dropdown —
exactly the "authorization decision relies on hidden/disabled UI alone"
shape this issue's acceptance criteria forbid. `TenantBadge` renders a
plain non-interactive badge on single-tenant deployments (today's only
real case — `awcms_mini_identities.tenant_id` has no cross-tenant identity
linking) and only renders a real `<select>` switcher when a new
`availableTenants` prop — which must be computed server-side from real
authorization data — is non-empty.

**Two representative large-page migrations** to the new primitives (no
full redesign): `src/pages/admin/access-users.astro` (1011 lines — two
`DataTable`s, `StatusBadge`, `ActionBanner`, `FormField`, and
`ConfirmDialog` for role deletion) and `src/pages/admin/tenant/domains.astro`
(1076 lines — chosen for its three separate confirm-then-act flows: verify,
set-primary, delete-with-reason, all previously bare `window.confirm`/
`window.prompt`, now one shared `ConfirmDialog`). Both keep their existing
SSR-read-direct / mutation-through-API split unchanged.

New i18n catalog entries (en + id): `admin.layout.nav_toggle_aria_label`,
`common.confirm_button`, `common.cancel_button`,
`common.reason_required_error`, `admin.access_users.delete_role_confirm_title`,
`admin.access_users.delete_role_confirm_body`,
`admin.tenant_domain.verify_confirm_title`,
`admin.tenant_domain.set_primary_confirm_title`,
`admin.tenant_domain.delete_confirm_title`.

New `--z-drawer` design token (`src/styles/tokens.css`, between `--z-nav`
and `--z-dropdown`) for the mobile sidebar drawer + its scrim.

New E2E specs (`tests/e2e/`, Playwright + Bun): `admin-responsive-nav.e2e.ts`
(drawer open/close/focus/Escape/skip-link across mobile and desktop
viewports), `admin-access-users-migrated.e2e.ts` and
`admin-tenant-domains-migrated.e2e.ts` (ConfirmDialog flows end to end
against the real API), and `admin-a11y-smoke.e2e.ts` (new devDependency
`@axe-core/playwright` — automated WCAG 2.2 AA smoke test across the admin
shell and both migrated pages, including a 320px viewport with the drawer
open).

Docs: `docs/awcms-mini/14_ui_ux_design_system.md` (component library table,
responsive drawer + tenant badge policy, new `--z-drawer` token, §Migrated
reference pages) and skills `awcms-mini-ui-screen`/`awcms-mini-browser-test`
updated to reference the new primitives and specs.
