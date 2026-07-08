-- Issue #559 (epic #555, online public tenant routing) — closes the RLS
-- bootstrap gap flagged in `sql/031_awcms_mini_tenant_domain_schema.sql`'s
-- header comment (lines ~77-95): the public host resolver must discover
-- `tenant_id` from a hostname in `awcms_mini_tenant_domains` BEFORE any
-- tenant context (`app.current_tenant_id` GUC) exists, but that table is
-- intentionally `FORCE ROW LEVEL SECURITY` (it holds tenant-manageable
-- fields like `verification_token_hash`), so a plain `SELECT` from the
-- least-privilege `awcms_mini_app` role always returns zero rows without
-- `withTenant(...)`. This migration adds one narrowly-scoped `SECURITY
-- DEFINER` function as the single sanctioned bootstrap read path, exactly
-- as migration 031 recommended. `FORCE ROW LEVEL SECURITY` is NOT removed
-- from the table by this migration.
--
-- How/why this is safe (verified empirically against the running
-- migration-owner role before writing this file, not assumed from memory):
--   - Migrations execute as the schema-owning role (`POSTGRES_USER`,
--     `awcms-mini` in `docker-compose.yml`), which is created by the
--     official postgres image as an actual Postgres SUPERUSER
--     (`SELECT rolsuper FROM pg_roles WHERE rolname = 'awcms-mini'` ->
--     true). Superusers bypass row security unconditionally, regardless of
--     `FORCE ROW LEVEL SECURITY` (`FORCE` only removes the *table owner's*
--     default RLS exemption when the owner is a non-superuser role; it has
--     no effect on an actually-superuser owner). So a `SECURITY DEFINER`
--     function owned by this role executes with the same unconditional RLS
--     bypass as any other statement run by the definer, exactly like the
--     migration's own DDL/DML already does against every FORCE-RLS table
--     in this schema.
--   - Because the *role* running this function's body already has an
--     unconditional bypass, the safety of this mechanism does not come
--     from RLS/FORCE at all — it comes entirely from two narrower
--     guarantees this migration provides instead:
--       1. The function body is fixed, static SQL (no dynamic SQL / string
--          concatenation) that returns exactly eight non-sensitive columns
--          (see RETURNS TABLE below) for rows matching one parameterized
--          `normalized_hostname` argument and `deleted_at IS NULL`. It can
--          never be used to read `verification_token_hash`,
--          `verification_record_value`, `hostname` (raw/unnormalized), or
--          any other column/table.
--       2. `EXECUTE` on the function is revoked from `PUBLIC` and granted
--          only to `awcms_mini_app` — no other non-superuser role can even
--          invoke this bypass. `awcms_mini_app` still cannot query
--          `awcms_mini_tenant_domains` directly without `withTenant(...)`;
--          it can only go through this one fixed lookup shape.
--   - `SET search_path = public, pg_temp` pins name resolution inside the
--     function body so it cannot be redirected by a caller-controlled
--     `search_path` (standard `SECURITY DEFINER` hardening, defense in
--     depth alongside the schema already restricting `CREATE` on `public`
--     to non-superuser roles by default since PostgreSQL 15).
--   - `STABLE` (not `VOLATILE`): the function only reads, matching a plain
--     read-only `SELECT` in cost/planning behavior.
--
-- Security-review follow-up (PR review for Issue #559, fixed in the same
-- change before merge): the first version of this function returned only
-- `(tenant_id, status, is_primary, route_mode)`, and the TypeScript
-- resolver (`resolvePublicTenantByHost`) issued a SECOND query against
-- `awcms_mini_tenants` to confirm the tenant itself was `active`. That
-- created an observable timing side-channel: an unknown/unmapped hostname
-- returned after exactly one round trip, while a hostname mapped to an
-- active domain (even one whose tenant was inactive) always cost a second
-- round trip before returning the same `null` — different latency for the
-- same public response, distinguishing "no such mapping" from "mapping
-- exists, tenant just isn't active" purely by timing. Fixed by joining
-- `awcms_mini_tenants` into this same function and returning the tenant's
-- own status/code/name/locale alongside the domain row, so
-- `resolvePublicTenantByHost` needs exactly one query for every outcome
-- (unknown host, inactive domain, inactive tenant, or a full resolution).
-- This join does not widen the SECURITY DEFINER bypass in any way:
-- `awcms_mini_tenants` is already RLS-free by design (ADR-0003/migration
-- 013) and freely `SELECT`-able by `awcms_mini_app` with zero bypass
-- needed — `resolvePublicTenantByCode` already reads the exact same
-- columns directly, unprivileged. Joining it here only removes a round
-- trip; it exposes nothing that was not already unconditionally public.
--
-- Consumer: `src/lib/tenant/public-host-tenant-resolver.ts`'s
-- `resolvePublicTenantByHost()` (Issue #559). It still applies
-- `domain_status = 'active' AND tenant_status = 'active'` itself (this
-- function intentionally returns non-active, non-deleted domain rows too,
-- e.g. `pending_verification`/`suspended`/`failed`, and whatever the
-- joined tenant's status is, so the resolver layer — not this SQL layer —
-- decides and documents which combination resolves public traffic; today
-- only `active` + `active`, per the issue's acceptance criteria).

CREATE OR REPLACE FUNCTION awcms_mini_resolve_tenant_domain_lookup(
  p_normalized_hostname text
)
RETURNS TABLE (
  tenant_id uuid,
  domain_status text,
  is_primary boolean,
  route_mode text,
  tenant_status text,
  tenant_code text,
  tenant_name text,
  default_locale text
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $function$
  SELECT
    d.tenant_id,
    d.status AS domain_status,
    d.is_primary,
    d.route_mode,
    t.status AS tenant_status,
    t.tenant_code,
    t.tenant_name,
    t.default_locale
  FROM awcms_mini_tenant_domains AS d
  JOIN awcms_mini_tenants AS t ON t.id = d.tenant_id
  WHERE d.normalized_hostname = p_normalized_hostname
    AND d.deleted_at IS NULL;
$function$;

COMMENT ON FUNCTION awcms_mini_resolve_tenant_domain_lookup(text) IS
  'Issue #559: narrow SECURITY DEFINER bootstrap read for hostname -> tenant lookup before tenant context exists. Joins the (already RLS-free) awcms_mini_tenants row in the same call so the TypeScript resolver needs exactly one round trip regardless of outcome (avoids a timing side-channel between "unmapped host" and "mapped but inactive tenant"). Returns only tenant_id/domain_status/is_primary/route_mode/tenant_status/tenant_code/tenant_name/default_locale for non-deleted domain rows matching a normalized hostname. Never returns verification_token_hash, verification_record_value, or raw hostname. EXECUTE restricted to awcms_mini_app.';

-- Function EXECUTE privilege is a separate grant mechanism from the table
-- GRANTs migration 013's `ALTER DEFAULT PRIVILEGES` already covers (that
-- clause only applies to tables/sequences, not functions/routines) — this
-- explicit grant is required, it is not automatic. PostgreSQL grants
-- EXECUTE to PUBLIC by default on function creation; revoke that first so
-- only the least-privilege app role can call this bypass.
REVOKE ALL ON FUNCTION awcms_mini_resolve_tenant_domain_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION awcms_mini_resolve_tenant_domain_lookup(text) TO awcms_mini_app;
