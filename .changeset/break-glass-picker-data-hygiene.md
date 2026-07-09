---
"awcms-mini": patch
---

Fix two non-blocking UX-integrity gaps around tenant auth policy break-glass
identity selection (Issue #605, follow-up from the security-auditor review
of PR #604/Issue #592). Neither was a bypassable security boundary —
`saveTenantAuthPolicy` (Issue #591) has always re-validated break-glass
eligibility via a fresh database read before allowing `sso_required=true`/
`password_login_enabled=false` to persist.

- `src/pages/admin/security.astro`'s break-glass checkbox picker now filters
  candidates to `tenant_user.status === 'active' && identity.status ===
  'active'` before rendering, instead of listing every tenant user
  (including suspended/inactive ones) as a selectable break-glass owner —
  an admin no longer discovers a doomed selection only after submitting.
  `fetchTenantUsersWithRoles` itself is unchanged (shared with
  `admin/access-users.astro`, which does need the full list); the filter
  is applied at the point of use.
- `saveTenantAuthPolicy` (`src/modules/identity-access/application/tenant-auth-policy.ts`)
  now persists only the ids confirmed eligible right now, never the
  submitted list verbatim. Previously it only checked that *at least one*
  submitted id was eligible before allowing the save — a submission of "1
  valid + N garbage/typo'd/nonexistent ids" (possible via the admin UI's
  manual free-text fallback for admins without `user_management.read`, or
  a direct API call) would silently persist all of them. `break_glass_identity_ids`
  is now self-cleaning on every save.
- `countEligibleBreakGlassIdentities` is now a thin wrapper around a new
  `fetchEligibleBreakGlassIdentityIds` (returns the actual eligible ids, not
  just a count) so the filtering and the count check share one query
  instead of two divergent implementations. `scripts/security-readiness.ts`'s
  `checkSsoBreakGlassReady` (Issue #593) is unaffected — its call site's
  signature is unchanged.

New regression test in `tests/integration/tenant-sso-flow.integration.test.ts`:
"break-glass hygiene: saving policy with 1 valid + N garbage/ineligible ids
persists ONLY the valid one" — submits one real identity id alongside two
syntactically-valid-but-nonexistent UUIDs and confirms only the real one is
ever persisted, verified via a fresh re-read of the policy.
