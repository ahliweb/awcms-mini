/**
 * repo-inventory-generate.ts — `bun run repo:inventory:generate`.
 *
 * Issue #688 (epic #679 platform-hardening). A 2026-07-11 static repo audit
 * found real docs/reality drift (a GitHub snapshot claiming 6 open issues
 * while 33+ were actually open; stale module names in `AGENTS.md`; a wrong
 * Docker Compose service name in `CONTRIBUTING.md`). Several of those were
 * hand-fixed in the same PR that added this script, but hand-fixing does not
 * prevent the NEXT drift. This script generates a single, deterministic
 * inventory of facts that are cheap to compute from the repo itself
 * (modules, migrations, tables/RLS, tests) so they never have to be
 * hand-counted again — same reasoning as `scripts/api-docs-generate.ts`
 * (Issue #700) and `scripts/github-snapshot-refresh.ts` (Issue #464).
 *
 * ## Scope: what this generates vs. what stays separate
 *
 *  - **Modules** — from `listModules()` (the same registry
 *    `bun run modules:sync`/`modules:dag:check` use). No I/O beyond
 *    importing the registry.
 *  - **Migrations** — every `sql/*.sql` file, sorted by filename (which is
 *    the enforced `NNN_awcms_mini_<area>_<desc>.sql` numbering).
 *  - **Tables & Row-Level Security** — parses `CREATE TABLE` blocks and
 *    `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` statements out of every
 *    migration file. This is a best-effort STATIC heuristic on top of the
 *    real enforcement (ADR-0003, migration `013`'s `FORCE ROW LEVEL
 *    SECURITY` + least-privilege app role) — it does not replace
 *    `security:readiness` or a live RLS test, it just makes the *inventory*
 *    of which tables are tenant-scoped and whether they have an `ENABLE ROW
 *    LEVEL SECURITY` statement somewhere reviewable without re-reading 47
 *    migration files by hand.
 *  - **Tests** — file counts per `tests/` subdirectory, by the project's
 *    established naming convention (`*.test.ts`, `*.test.mjs`, `*.e2e.ts`).
 *  - **Routes/operations** — a read-only SUMMARY (path/operation counts)
 *    sourced from the already-bundled, already-validated OpenAPI contract.
 *    Route<->OpenAPI parity itself is a separate, already-existing gate
 *    (`checkRouteParity` in `scripts/api-spec-check.ts`, Issue #685/#695) —
 *    this script does not duplicate that enforcement, it only surfaces the
 *    resulting counts for human review.
 *  - **GitHub issue/label/milestone snapshot** — intentionally NOT
 *    regenerated here. `scripts/github-snapshot-refresh.ts` (Issue #464)
 *    already owns that, and it reaches out to the live GitHub API via `gh`
 *    — a network dependency doc 20 deliberately keeps out of CI. This
 *    document links to that snapshot instead of duplicating it; run
 *    `bun run github:snapshot:refresh` separately before a release/audit.
 *
 * ## Freshness design (no embedded wall-clock timestamp)
 *
 * Unlike `docs/awcms-mini/github/` (which stamps a literal snapshot
 * timestamp because it reflects a point-in-time live API call),
 * everything this script generates is a pure, deterministic function of
 * files already committed in the working tree — same category as
 * `scripts/api-docs-generate.ts`. Embedding a wall-clock "generated at"
 * timestamp INSIDE the diffed content would make every regeneration
 * produce a spurious diff even when nothing meaningful changed, which is
 * exactly what would defeat `repo-inventory-check.ts`'s regenerate-and-diff
 * gate. Freshness is instead enforced structurally: the generated document
 * always describes the repository state AT THE COMMIT IT IS COMMITTED IN
 * (same convention `docs/awcms-mini/api-reference.md` documents), and
 * `bun run repo:inventory:check` (part of `bun run check`) fails the build
 * the moment the committed file stops matching a fresh regeneration.
 *
 * Local/offline only: no network access, no external CLI — filesystem
 * reads plus the in-repo module registry and YAML parser already used by
 * `scripts/api-docs-generate.ts`.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import prettier from "prettier";
import { parseDocument } from "yaml";

import { listModules } from "../src/modules";
import type { ModuleDescriptor } from "../src/modules/_shared/module-contract";
import { BASE_MODULE_MIGRATION_NAMESPACE } from "../src/modules/module-management/domain/module-composition";
import { bundleOpenApi } from "./openapi-bundle";

export const REPO_INVENTORY_PATH = "docs/awcms-mini/repo-inventory.md";
export const SQL_DIR = "sql";
export const TESTS_DIR = "tests";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

/**
 * Reviewed allow-list of tables that are intentionally global (no
 * `tenant_id`-scoped RLS) — same "one file everyone reviews" pattern as
 * `ROUTE_PARITY_EXEMPTIONS` (`scripts/api-spec-check.ts`, Issue #695) and
 * `CONFIG_EXEMPTIONS` (Issue #689). Every entry cites the doc that already
 * documents the exemption; add a new entry (with a citation) in the same PR
 * that adds a genuinely global table, never to silently quiet a real gap.
 */
export const RLS_EXEMPT_TABLES: Readonly<Record<string, string>> = {
  awcms_mini_schema_migrations:
    "Migration ledger — infra bookkeeping, not tenant data.",
  awcms_mini_tenants:
    "The tenant registry itself — root table other tables' tenant_id references; endpoints scope with an explicit WHERE id = <tenantId> instead (doc note: CHANGELOG 0.23.5 §Settings management).",
  awcms_mini_setup_state:
    "Singleton (id boolean PRIMARY KEY) setup-wizard state — one row for the whole deployment, not per-tenant data, despite an optional tenant_id FK kept for provenance.",
  awcms_mini_permissions:
    "Permission catalog — global, RLS-free (doc 16 §Registry global, RLS-free).",
  awcms_mini_modules:
    "Module registry — global catalog synced from listModules(), same for every tenant (doc 16 §Registry global, RLS-free).",
  awcms_mini_module_dependencies:
    "Module registry — global catalog (doc 16 §Registry global, RLS-free).",
  awcms_mini_module_navigation:
    "Module registry — global catalog (doc 16 §Registry global, RLS-free).",
  awcms_mini_module_jobs:
    "Module registry — global catalog (doc 16 §Registry global, RLS-free).",
  awcms_mini_module_health_checks:
    "Module registry — global catalog (doc 16 §Registry global, RLS-free).",
  awcms_mini_idn_region_datasets:
    "Indonesia administrative region dataset metadata (cahyadsn/wilayah) — global reference data, identical for every tenant (doc 04 §Master Data — Indonesia Administrative Regions, Issue #657).",
  awcms_mini_idn_admin_regions:
    "Indonesia administrative region records (cahyadsn/wilayah) — global reference data, identical for every tenant (doc 04 §Master Data — Indonesia Administrative Regions, Issue #657).",
  awcms_mini_reference_value_sets:
    "Reference value-set catalog — global baseline, identical for every tenant by design (doc 04 §Reference Data, Issue #750, ADR-0021 §8).",
  awcms_mini_reference_codes:
    "Reference code baseline within a value set — global, identical for every tenant (doc 04 §Reference Data, Issue #750, ADR-0021 §8).",
  awcms_mini_reference_code_translations:
    "Localized labels for global baseline reference codes (doc 04 §Reference Data, Issue #750, ADR-0021 §8).",
  awcms_mini_reference_imports:
    "Reference data import batch history for the global baseline (doc 04 §Reference Data, Issue #750, ADR-0021 §8)."
};

type TableInfo = {
  name: string;
  file: string;
  hasTenantId: boolean;
};

function extractTables(sqlContent: string, fileLabel: string): TableInfo[] {
  const lines = sqlContent.split("\n");
  const tables: TableInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(
      /^CREATE TABLE(?: IF NOT EXISTS)? ([a-zA-Z0-9_.]+)\s*\(/
    );
    if (!match) continue;
    const name = match[1]!;

    let depth = 0;
    const bodyLines: string[] = [];
    let j = i;
    for (; j < lines.length; j++) {
      const line = lines[j]!;
      for (const ch of line) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
      }
      bodyLines.push(line);
      if (depth <= 0) break;
    }

    tables.push({
      name,
      file: fileLabel,
      hasTenantId: /\btenant_id\b/.test(bodyLines.join("\n"))
    });
    i = j;
  }

  return tables;
}

/**
 * Strips `--` line comments before RLS-statement matching so a
 * commented-out `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` (e.g. left
 * behind while debugging a migration) isn't counted as actually enabling
 * RLS — reviewer finding on PR #722: the previous version matched against
 * raw file content, so a disabled statement was indistinguishable from a
 * live one. `extractTables`'s `CREATE TABLE` match is already per-line
 * anchored (`^CREATE TABLE`) and unaffected by this same class of bug.
 */
function stripSqlLineComments(sqlContent: string): string {
  return sqlContent
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

export function extractRlsEnabledTables(sqlContent: string): Set<string> {
  const enabled = new Set<string>();
  const pattern =
    /ALTER TABLE (?:IF EXISTS )?([a-zA-Z0-9_.]+) ENABLE ROW LEVEL SECURITY/g;
  for (const match of stripSqlLineComments(sqlContent).matchAll(pattern)) {
    enabled.add(match[1]!);
  }
  return enabled;
}

async function listSqlFiles(rootDir: string): Promise<string[]> {
  const dir = path.join(rootDir, SQL_DIR);
  const entries = await readdir(dir);
  return entries.filter((f) => f.endsWith(".sql")).sort();
}

/**
 * Issue #740 security follow-up (PR #769 security-auditor Medium finding):
 * this repository's OWN `sql/` directory must never contain a migration
 * numbered above `BASE_MODULE_MIGRATION_NAMESPACE.rangeEnd` — that range is
 * reserved for a derived repository's own separately-numbered migrations
 * (`module-composition.ts`'s own doc comment). A base migration
 * accidentally numbered `900` or higher would silently violate that
 * reservation for every derived repository relying on it, without
 * `bun run modules:compose:check` (which never reads `sql/*.sql`) ever
 * catching it. This is the real, filesystem-backed half of that
 * guarantee — `module-composition.ts` stays pure/I-O-free and only
 * compares DECLARED ranges against each other.
 *
 * Deliberately narrow: only checks THIS repository's own files against
 * THIS repository's own reserved range — it has no visibility into (and
 * makes no claim about) a derived repository's separate `sql/` directory,
 * which must verify its own files against its own declared
 * `migrationNamespace` using the same reasoning, in its own repo.
 */
export function findMigrationNamespaceViolations(
  sqlFiles: readonly string[]
): string[] {
  return sqlFiles.filter((file) => {
    const num = Number(file.match(/^(\d+)_/)?.[1]);
    return (
      Number.isFinite(num) && num > BASE_MODULE_MIGRATION_NAMESPACE.rangeEnd
    );
  });
}

const TEST_FILE_PATTERN = /\.(test\.ts|test\.mjs|e2e\.ts)$/;

async function countTestFiles(
  dir: string
): Promise<{ file: number; dirCounts: Map<string, number> }> {
  const dirCounts = new Map<string, number>();
  let total = 0;

  async function walk(current: string, topLevel: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, topLevel === "" ? entry.name : topLevel);
      } else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
        total++;
        const key = topLevel === "" ? "(root)" : topLevel;
        dirCounts.set(key, (dirCounts.get(key) ?? 0) + 1);
      }
    }
  }

  await walk(dir, "");
  return { file: total, dirCounts };
}

export function mdEscape(value: string): string {
  // Escape backslashes FIRST, then pipes (same CodeQL "incomplete string
  // escaping" class already fixed once in api-docs-generate.ts, Issue #700
  // PR #717): escaping only `|` leaves a literal backslash already in a
  // module key/version/status/dependency string untouched, so a value
  // ending in `\` immediately before a template-inserted `|` cell delimiter
  // could merge with the escape and desync the table.
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/**
 * Builds the raw, unformatted Markdown. Column widths in the tables below
 * are not hand-aligned — `buildRepoInventoryMarkdown` runs this through the
 * project's own Prettier config so the generated artifact already satisfies
 * `bun run lint` (same reasoning `scripts/api-docs-generate.ts` documents
 * for its own raw->Prettier step; without it, every regeneration would need
 * a separate manual `bun run format` pass, and the committed file would
 * drift from what `repo-inventory-check.ts` regenerates in memory).
 */
async function buildRawRepoInventoryMarkdown(
  rootDir = process.cwd(),
  // Issue #740 (epic #738): defaults to the real, effective registry
  // (`listModules()` — base, or base+application when a derived
  // repository has replaced `src/modules/application-registry.ts`).
  // Callers (e.g. composed-fixture tests) may pass a different composed
  // list explicitly, without this script's own CLI entry point behavior
  // changing at all.
  moduleList: readonly ModuleDescriptor[] = listModules()
): Promise<string> {
  // Modules
  const modules = [...moduleList].sort((a, b) => a.key.localeCompare(b.key));

  // Migrations
  const sqlFiles = await listSqlFiles(rootDir);
  const migrationNamespaceViolations =
    findMigrationNamespaceViolations(sqlFiles);

  // Tables & RLS
  const allTables: TableInfo[] = [];
  const allRlsEnabled = new Set<string>();
  for (const file of sqlFiles) {
    const content = await readFile(path.join(rootDir, SQL_DIR, file), "utf8");
    allTables.push(...extractTables(content, file));
    for (const table of extractRlsEnabledTables(content)) {
      allRlsEnabled.add(table);
    }
  }
  const tenantScoped = allTables.filter((t) => t.hasTenantId);
  const violations = tenantScoped.filter(
    (t) => !allRlsEnabled.has(t.name) && !(t.name in RLS_EXEMPT_TABLES)
  );
  const exemptPresent = allTables.filter((t) => t.name in RLS_EXEMPT_TABLES);

  // Tests
  const { file: totalTests, dirCounts } = await countTestFiles(
    path.join(rootDir, TESTS_DIR)
  );

  // Routes/operations (read-only summary from the already-bundled contract)
  const bundledYaml = await bundleOpenApi(rootDir);
  const openApi = parseDocument(bundledYaml).toJS() as {
    info?: { version?: string };
    paths?: Record<string, Record<string, unknown>>;
  };
  const paths = openApi.paths ?? {};
  const pathCount = Object.keys(paths).length;
  let operationCount = 0;
  for (const pathItem of Object.values(paths)) {
    for (const method of HTTP_METHODS) {
      if (pathItem && typeof pathItem === "object" && method in pathItem) {
        operationCount++;
      }
    }
  }

  const lines: string[] = [];
  lines.push("# AWCMS-Mini Repository Inventory (generated)");
  lines.push("");
  lines.push(
    "> **GENERATED FILE — do not edit by hand.** Produced by " +
      "`bun run repo:inventory:generate` (`scripts/repo-inventory-generate.ts`, " +
      "Issue #688, epic #679) from the repository's own module registry, " +
      "`sql/*.sql` migrations, `tests/`, and the bundled OpenAPI contract — " +
      "never edit it directly. `bun run repo:inventory:check` (part of " +
      "`bun run check`) fails the build if this file is stale relative to a " +
      "fresh regeneration."
  );
  lines.push("");
  lines.push(
    "**Freshness.** This document has no embedded generation timestamp on " +
      "purpose (a wall-clock stamp would make every regeneration diff even " +
      "when nothing meaningful changed). It always describes the repository " +
      "state **at the commit it is committed in** — check out any tag/commit " +
      "and this file (or a fresh `bun run repo:inventory:generate`) describes " +
      "that state, never a different one. GitHub issue/label/milestone state " +
      "is tracked separately in [`docs/awcms-mini/github/`](github/README.md) " +
      "(refreshed on demand via `bun run github:snapshot:refresh` — a live " +
      "network call, deliberately kept out of `bun run check`, doc 20 " +
      "§Batasan)."
  );
  lines.push("");

  // Modules
  lines.push("## Modules");
  lines.push("");
  lines.push(
    `${modules.length} modules registered in \`src/modules/index.ts\` \`listModules()\`.`
  );
  lines.push("");
  lines.push("| Key | Version | Status | Type | Dependencies |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const m of modules) {
    lines.push(
      `| \`${mdEscape(m.key)}\` | \`${mdEscape(m.version)}\` | \`${mdEscape(m.status)}\` | \`${mdEscape(m.type ?? "-")}\` | ${
        m.dependencies.length > 0
          ? m.dependencies.map((d) => `\`${mdEscape(d)}\``).join(", ")
          : "-"
      } |`
    );
  }
  lines.push("");

  // Migrations
  lines.push("## Migrations");
  lines.push("");
  lines.push(
    `${sqlFiles.length} migration files in \`sql/\` (\`${sqlFiles[0] ?? "-"}\` .. \`${sqlFiles.at(-1) ?? "-"}\`). Reserved base migration namespace (Issue #740, ADR-0014): \`${BASE_MODULE_MIGRATION_NAMESPACE.rangeStart}-${BASE_MODULE_MIGRATION_NAMESPACE.rangeEnd}\` — a derived repository's own migrations start numbering at \`${BASE_MODULE_MIGRATION_NAMESPACE.rangeEnd + 1}\` or above.`
  );
  lines.push("");
  if (migrationNamespaceViolations.length > 0) {
    lines.push(
      `> **${migrationNamespaceViolations.length} POSSIBLE GAP** — migration file(s) numbered above this repository's own reserved namespace (\`${BASE_MODULE_MIGRATION_NAMESPACE.rangeEnd}\`), encroaching on the range reserved for a derived repository's own migrations:`
    );
    lines.push("");
    for (const file of migrationNamespaceViolations) {
      lines.push(`- \`${mdEscape(file)}\``);
    }
    lines.push("");
  }
  lines.push("| # | File |");
  lines.push("| --- | --- |");
  for (const file of sqlFiles) {
    const num = file.match(/^(\d+)_/)?.[1] ?? "-";
    lines.push(`| ${num} | \`${mdEscape(file)}\` |`);
  }
  lines.push("");

  // Tables & RLS
  lines.push("## Tables & Row-Level Security");
  lines.push("");
  lines.push(
    `${allTables.length} tables created across all migrations; ${tenantScoped.length} carry a \`tenant_id\` column; ${allRlsEnabled.size} have an \`ENABLE ROW LEVEL SECURITY\` statement; ${exemptPresent.length} are on the reviewed RLS-exempt allow-list.`
  );
  lines.push("");
  if (violations.length > 0) {
    lines.push(
      `> **${violations.length} POSSIBLE GAP** — tenant-scoped table(s) with no ` +
        "`ENABLE ROW LEVEL SECURITY` statement found and not on the reviewed " +
        "exempt allow-list below. This is a static heuristic, not a live " +
        "database check (run `bun run security:readiness` for the real, live " +
        "RLS enforcement gate) — verify manually before treating this as a " +
        "confirmed gap:"
    );
    lines.push("");
    for (const v of violations) {
      lines.push(`- \`${mdEscape(v.name)}\` (${mdEscape(v.file)})`);
    }
    lines.push("");
  } else {
    lines.push(
      "No gap found: every tenant-scoped table has an `ENABLE ROW LEVEL " +
        "SECURITY` statement, or is on the reviewed exempt allow-list below."
    );
    lines.push("");
  }
  lines.push(
    "**Reviewed RLS-exempt allow-list** (see also doc 16 §Registry global, RLS-free):"
  );
  lines.push("");
  lines.push("| Table | Reason |");
  lines.push("| --- | --- |");
  for (const [table, reason] of Object.entries(RLS_EXEMPT_TABLES)) {
    const present = allTables.some((t) => t.name === table);
    lines.push(
      `| \`${mdEscape(table)}\`${present ? "" : " *(not found in sql/ — stale entry, review)*"} | ${mdEscape(reason)} |`
    );
  }
  lines.push("");

  // Tests
  lines.push("## Tests");
  lines.push("");
  lines.push(
    `${totalTests} test files under \`tests/\` (\`*.test.ts\`, \`*.test.mjs\`, \`*.e2e.ts\`).`
  );
  lines.push("");
  lines.push("| Directory | Test files |");
  lines.push("| --- | --- |");
  for (const [dir, count] of [...dirCounts.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    lines.push(`| \`${mdEscape(dir)}\` | ${count} |`);
  }
  lines.push("");

  // Routes / operations
  lines.push("## Routes / Operations (summary)");
  lines.push("");
  lines.push(
    `${pathCount} OpenAPI paths, ${operationCount} operations, contract \`info.version\` \`${openApi.info?.version ?? "-"}\` — sourced from the bundled contract (\`bun run openapi:bundle\`). Route<->contract parity itself is already enforced by \`bun run api:spec:check\`'s route-parity check (Issue #685/#695); this is a read-only summary, not a separate enforcement.`
  );
  lines.push("");

  // GitHub snapshot cross-reference
  lines.push("## GitHub issue/label/milestone snapshot");
  lines.push("");
  lines.push(
    "Tracked separately at [`docs/awcms-mini/github/`](github/README.md) — " +
      "refreshed on demand via `bun run github:snapshot:refresh` (live `gh` " +
      "API calls, not part of `bun run check`; see that script's own header " +
      "comment for why). Regenerate it before every release/audit, not on a " +
      "fixed schedule."
  );
  lines.push("");

  return lines.join("\n");
}

export async function buildRepoInventoryMarkdown(
  rootDir = process.cwd(),
  moduleList: readonly ModuleDescriptor[] = listModules()
): Promise<string> {
  const raw = await buildRawRepoInventoryMarkdown(rootDir, moduleList);
  const filepath = path.join(rootDir, REPO_INVENTORY_PATH);
  const config = (await prettier.resolveConfig(filepath)) ?? {};

  return prettier.format(raw, { ...config, filepath, parser: "markdown" });
}

if (import.meta.main) {
  const { writeFile } = await import("node:fs/promises");
  const markdown = await buildRepoInventoryMarkdown();
  await writeFile(REPO_INVENTORY_PATH, markdown, "utf8");
  console.log(
    `Diperbarui: ${REPO_INVENTORY_PATH}. Jalankan \`bun run format\` lalu \`bun run check:docs\`.`
  );
}
