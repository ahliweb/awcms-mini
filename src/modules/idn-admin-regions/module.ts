import { defineModule } from "../_shared/module-contract";

/**
 * `idn_admin_regions` (Issue #655, epic #654 — master data wilayah
 * administratif Indonesia dari `cahyadsn/wilayah`, Issue #655-#664).
 *
 * This descriptor is a SCAFFOLD ONLY (Issue #655's own scope): it
 * registers the module in the trusted code catalog so it syncs into
 * `awcms_mini_modules` via `bun run modules:sync`, and declares the five
 * permissions from migration
 * `sql/048_awcms_mini_idn_admin_regions_permissions.sql`. **No dataset
 * schema, no vendored source files, no parser/normalizer, no import
 * pipeline, no activation/rollback, no lookup API, and no admin UI yet**
 * — see `.claude/skills/awcms-mini-idn-admin-regions/SKILL.md` for the
 * full per-issue plan (#656-#664) and `README.md` for this module's own
 * scope-per-issue table.
 *
 * `type: "base"` (not `"domain"`): this is reusable reference/master data
 * infrastructure every derived application can depend on (administrative
 * region lookups), not a tenant-facing business feature of its own —
 * closer in spirit to how `logging`/`reporting` are shared platform
 * building blocks than to `blog_content`'s tenant-owned content.
 *
 * `status: "experimental"`: no schema, no API, and no UI exist yet — this
 * only becomes `"active"` once the epic's read-only lookup API (#662) and
 * admin UI (#663) land, following the same convention `blog_content`
 * followed (stayed `"experimental"` until its own epic #536 completed).
 */
export const idnAdminRegionsModule = defineModule({
  key: "idn_admin_regions",
  name: "Indonesia Administrative Regions",
  version: "0.1.0",
  status: "experimental",
  type: "base",
  description:
    "Reusable Indonesia administrative region (province/regency/district/village) master data for derived applications, sourced from the third-party community dataset https://github.com/cahyadsn/wilayah (MIT License) — NOT an official Kemendagri API or export; see README.md's official-reference caveat. Issue #655 (this descriptor) registers the module and its permission catalog only. Later issues in epic #654 add: vendored source metadata + license (#656), versioned PostgreSQL schema (#657), a SQL parser/normalizer (#658), a repository validation gate (#659), a PostgreSQL import pipeline (#660), activation/rollback/diff (#661), a read-only lookup API (#662), an admin UI (#663), and SOP/docs/security review (#664).",
  dependencies: ["identity_access", "logging", "module_management"],
  permissions: [
    {
      activityCode: "region",
      action: "read",
      description: "Read Indonesia administrative region records"
    },
    {
      activityCode: "dataset",
      action: "read",
      description: "Read Indonesia administrative region dataset metadata"
    },
    {
      activityCode: "dataset",
      action: "import",
      description: "Import a new Indonesia administrative region dataset"
    },
    {
      activityCode: "dataset",
      action: "activate",
      description:
        "Activate a validated Indonesia administrative region dataset"
    },
    {
      activityCode: "dataset",
      action: "rollback",
      description:
        "Roll back the active Indonesia administrative region dataset to the previously active one"
    }
  ]
});
