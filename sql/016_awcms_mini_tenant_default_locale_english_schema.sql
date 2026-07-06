-- Issue #433 (i18n) — flip the tenant default locale to English.
--
-- Migration 002 set `awcms_mini_tenants.default_locale DEFAULT 'id'`. Doc 14
-- §Internationalization now specifies English as the base's default
-- language (minimum en+id, ready for ms/ar) — this only changes what NEW
-- tenants get from here on; it deliberately does NOT touch existing rows'
-- values (an operator who already set a tenant to 'id' keeps that choice —
-- changing a column DEFAULT is not a data migration).
ALTER TABLE awcms_mini_tenants ALTER COLUMN default_locale SET DEFAULT 'en';
