-- Issue #932 (epic #868, blocks the data-lifecycle half of #930) — make the
-- payment-gateway webhook evidence tables RETAINABLE.
--
-- ## The defect this fixes
--
-- Four tables in migration 093 carry a `BEFORE UPDATE OR DELETE` trigger whose
-- function raises unconditionally on DELETE. The consequence was not "the app
-- role may not delete" (which is the intended boundary and stays) but "NO role
-- may delete, including the migration owner" — verified empirically on a fresh
-- database:
--
--   >>> DELETE attempt as SUPERUSER / table owner:
--   ERROR:  payment_gateway: webhook inbox is append-only (no DELETE)
--   CONTEXT: PL/pgSQL function awcms_mini_payment_gateway_guard_webhook_inbox_forward()
--
-- So no retention period could be enforced on stored provider webhook evidence,
-- a legal hold had nothing to override, and no contractual/data-subject erasure
-- was possible — on the module's highest-volume table, which grows with real
-- provider traffic and could never shrink.
--
-- ## What changes, and what deliberately does NOT
--
-- The triggers are narrowed from `BEFORE UPDATE OR DELETE` to `BEFORE UPDATE`.
-- Every in-place-edit protection they enforce is UNCHANGED: the webhook inbox
-- still permits exactly one `received -> normalized` forward advance and freezes
-- every other column, and the three append-only tables still reject any UPDATE
-- whatsoever. Nothing about what a row may become is relaxed.
--
-- The DELETE boundary moves from "impossible" to "grants", which is exactly the
-- shape `usage_metering` — the one control-plane module with a working retention
-- purge — already uses for the identical tension (migration 087: `REVOKE DELETE`
-- from the app role, `GRANT SELECT, DELETE` to `awcms_mini_worker`, with
-- `purgeExpiredUsageEvents` as the single audited path; its own immutability
-- trigger is `BEFORE UPDATE` only, `awcms_mini_usage_events_no_update`).
--
-- After this migration:
--   - `awcms_mini_app` (every request path) still CANNOT delete — the
--     `REVOKE DELETE` from migration 093 is untouched and re-asserted below.
--   - `awcms_mini_worker` (unattended jobs only, no web surface) CAN delete,
--     and the only code that does is `payment-gateway/application/
--     retention-purge.ts`: bounded batches, FK-safe order, legal-hold aware,
--     audited.
--
-- `awcms_mini_payment_gateway_guard_webhook_inbox_forward()` keeps its
-- `IF TG_OP = 'DELETE' THEN RAISE` branch on purpose even though the trigger no
-- longer fires on DELETE. It is now dead code that becomes live again the moment
-- anyone re-attaches this function to a DELETE event, i.e. it documents the
-- invariant and makes the TRIGGER DEFINITION the single, explicit lever.
-- `awcms_mini_payment_gateway_guard_append_only()` is replaced only to correct
-- its message, which would otherwise say "no UPDATE/DELETE" while DELETE is
-- permitted; all three tables using it are UPDATE-only after this migration.
--
-- ## Indexes
--
-- Each purge pass is `WHERE tenant_id = $1 AND <age column> < cutoff ORDER BY
-- <age column> LIMIT n`, plus a `NOT EXISTS` probe for a surviving child row
-- (the FK-safe ordering). Both shapes need index support that does not exist:
-- the current indexes lead with `(tenant_id, status, ...)` or
-- `(tenant_id, intent_id, ...)`, and neither child FK column is indexed at all
-- (also a plain FK-index gap, doc 04). `processing_attempts` already got
-- `(tenant_id, created_at DESC)` in migration 101 and is not duplicated here.

-- 1. Narrow the four guards to UPDATE. Same functions, same UPDATE behaviour.
DROP TRIGGER IF EXISTS awcms_mini_payment_gateway_webhook_inbox_append_only
  ON awcms_mini_payment_gateway_webhook_inbox;
CREATE TRIGGER awcms_mini_payment_gateway_webhook_inbox_append_only
  BEFORE UPDATE ON awcms_mini_payment_gateway_webhook_inbox
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_payment_gateway_guard_webhook_inbox_forward();

CREATE OR REPLACE FUNCTION awcms_mini_payment_gateway_guard_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payment_gateway: % is append-only (no UPDATE)', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_mini_payment_gateway_normalized_events_append_only
  ON awcms_mini_payment_gateway_normalized_events;
CREATE TRIGGER awcms_mini_payment_gateway_normalized_events_append_only
  BEFORE UPDATE ON awcms_mini_payment_gateway_normalized_events
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_payment_gateway_guard_append_only();

DROP TRIGGER IF EXISTS awcms_mini_payment_gateway_processing_attempts_append_only
  ON awcms_mini_payment_gateway_processing_attempts;
CREATE TRIGGER awcms_mini_payment_gateway_processing_attempts_append_only
  BEFORE UPDATE ON awcms_mini_payment_gateway_processing_attempts
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_payment_gateway_guard_append_only();

DROP TRIGGER IF EXISTS awcms_mini_payment_gateway_reconciliations_append_only
  ON awcms_mini_payment_gateway_reconciliations;
CREATE TRIGGER awcms_mini_payment_gateway_reconciliations_append_only
  BEFORE UPDATE ON awcms_mini_payment_gateway_reconciliations
  FOR EACH ROW
  EXECUTE FUNCTION awcms_mini_payment_gateway_guard_append_only();

-- 2. Grants. The request-path role keeps NO delete rights (re-asserted, not
-- newly granted); only the unattended worker role gains them.
REVOKE DELETE ON awcms_mini_payment_gateway_webhook_inbox FROM awcms_mini_app;
REVOKE DELETE ON awcms_mini_payment_gateway_normalized_events FROM awcms_mini_app;
REVOKE DELETE ON awcms_mini_payment_gateway_processing_attempts FROM awcms_mini_app;
REVOKE DELETE ON awcms_mini_payment_gateway_reconciliations FROM awcms_mini_app;

-- `awcms_mini_worker` already holds SELECT on normalized_events /
-- processing_attempts / reconciliations (migration 093, for the outbox
-- dispatcher and reconciliation engine) — only DELETE is added for those.
-- The webhook inbox was never granted to this role at all, so it needs both.
GRANT SELECT, DELETE ON awcms_mini_payment_gateway_webhook_inbox TO awcms_mini_worker;
GRANT DELETE ON awcms_mini_payment_gateway_normalized_events TO awcms_mini_worker;
GRANT DELETE ON awcms_mini_payment_gateway_processing_attempts TO awcms_mini_worker;
GRANT DELETE ON awcms_mini_payment_gateway_reconciliations TO awcms_mini_worker;

-- The legal-hold read (`awcms_mini_data_lifecycle_legal_holds`) and the audit
-- write (`awcms_mini_audit_events`) this purge needs are ALREADY granted to
-- `awcms_mini_worker` by migrations 057/013 for the other purge jobs — not
-- re-granted here.

-- 3. Retention-scan indexes (age-ordered per tenant).
CREATE INDEX IF NOT EXISTS awcms_mini_payment_gateway_webhook_inbox_retention_idx
  ON awcms_mini_payment_gateway_webhook_inbox (tenant_id, received_at);

CREATE INDEX IF NOT EXISTS awcms_mini_payment_gateway_normalized_events_retention_idx
  ON awcms_mini_payment_gateway_normalized_events (tenant_id, created_at);

CREATE INDEX IF NOT EXISTS awcms_mini_payment_gateway_reconciliations_retention_idx
  ON awcms_mini_payment_gateway_reconciliations (tenant_id, created_at);

-- 4. Child-FK indexes for the "does a surviving child still reference this row?"
-- probe that keeps the purge FK-safe (and for the FK itself).
CREATE INDEX IF NOT EXISTS awcms_mini_payment_gateway_normalized_events_inbox_idx
  ON awcms_mini_payment_gateway_normalized_events (webhook_inbox_id);

CREATE INDEX IF NOT EXISTS awcms_mini_payment_gateway_processing_attempts_event_idx
  ON awcms_mini_payment_gateway_processing_attempts (normalized_event_id);
