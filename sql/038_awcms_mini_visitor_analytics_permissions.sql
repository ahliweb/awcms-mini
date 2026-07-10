-- Issue #617 (epic: visitor analytics #617-#624) — permission catalog seed
-- for the new `visitor_analytics` module descriptor
-- (src/modules/visitor-analytics/module.ts). Same shape as
-- `sql/032_awcms_mini_tenant_domain_permissions.sql` — extends the global
-- ABAC permission catalog only, no roles/access-assignments wired here, no
-- new tables (the visitor session/event/rollup schema lands in the next
-- issue, #618).
INSERT INTO awcms_mini_permissions (module_key, activity_code, action, description)
VALUES
  ('visitor_analytics', 'dashboard', 'read', 'Read the visitor analytics dashboard'),
  ('visitor_analytics', 'realtime', 'read', 'Read real-time/online visitor counts'),
  ('visitor_analytics', 'sessions', 'read', 'Read visitor session records'),
  ('visitor_analytics', 'events', 'read', 'Read visitor page-view/event records'),
  ('visitor_analytics', 'raw_detail', 'read', 'Read raw visitor detail (IP address, user-agent) separate from aggregate dashboard access'),
  ('visitor_analytics', 'settings', 'read', 'Read visitor analytics module settings'),
  ('visitor_analytics', 'settings', 'update', 'Update visitor analytics module settings'),
  ('visitor_analytics', 'retention', 'purge', 'Purge visitor analytics data past its retention window')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
