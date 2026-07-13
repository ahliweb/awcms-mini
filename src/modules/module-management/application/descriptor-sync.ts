/**
 * Descriptor sync service (Issue #513, epic #510). Reads the trusted,
 * in-process code registry (`listModules()`, `src/modules/index.ts`) and
 * upserts it into the database-backed registry (`awcms_mini_modules` +
 * `awcms_mini_module_dependencies`/`_navigation`/`_jobs`, migration 025).
 *
 * No network calls, no user-controlled path — the only input is the
 * trusted, statically-imported module descriptor list already running in
 * this process. Safe to call repeatedly: running with the same descriptors
 * twice in a row produces the same DB state both times (`unchanged` on the
 * second run), never a duplicate row or a second write of the same value.
 *
 * These tables are global/RLS-free (migration 025's own justification —
 * code-derived registry metadata, not tenant data), so this runs on the
 * plain app connection with no tenant context needed.
 *
 * ## Composition validation gate (Issue #740 security follow-up, PR #769
 * security-auditor BLOCKED finding)
 *
 * `syncModuleDescriptors` is the SINGLE choke point every real write path
 * to `awcms_mini_modules` goes through: `scripts/modules-sync.ts` (CLI),
 * `src/pages/api/v1/modules/sync.ts` (the live API endpoint), AND
 * `tenant-module-lifecycle.ts`'s `enableTenantModule`/`disableTenantModule`,
 * `module-settings.ts`'s `updateModuleSettings`, and `health-registry.ts`'s
 * `runModuleHealthCheck` — all four call `syncModuleDescriptors(tx)`
 * themselves as a side effect (`module-management/README.md`'s "sync
 * first" rule) before writing tenant-scoped rows with an FK to
 * `awcms_mini_modules`. Build-time composition validation
 * (`bun run modules:compose:check`,
 * `module-management/domain/module-composition.ts`) originally existed
 * ONLY as a standalone CI script — nothing on the actual write path ever
 * called it, so an invalid composed registry (e.g. an application module
 * whose `key` collides with a base module, `prohibited_base_override`)
 * could still reach `upsertModule`'s `INSERT ... ON CONFLICT (module_key)
 * DO UPDATE SET ...` and silently overwrite the base module's row with the
 * application module's data — the exact scenario `prohibited_base_override`
 * exists to prevent, reachable from six real call sites, not caught by any
 * of the ~120 tests that existed before this fix (all of them exercised
 * composition validation in isolation, or `syncModuleDescriptors` against
 * an already-valid registry, never the adversarial combination of both).
 *
 * The fix lives HERE, not only in the two most obvious callers
 * (`scripts/modules-sync.ts`/the API endpoint already gate on this too,
 * for a fast, clean pre-check before opening a DB transaction) — because
 * gating only those two would have left the four internal "sync first"
 * call sites above just as exposed, reproducing the same class of gap one
 * level removed. See `findDuplicateDescriptorKeys`/`ModuleCompositionInvalidError`
 * below.
 */
import { listBaseModules, listModules } from "../..";
import { applicationModuleRegistry } from "../../application-registry";
import type { ModuleDescriptor } from "../../_shared/module-contract";
import {
  planModuleSync,
  type ExistingModuleRow
} from "../domain/descriptor-diff";
import {
  composeModuleRegistry,
  formatModuleCompositionIssue
} from "../domain/module-composition";

export type DescriptorSyncResult = {
  created: string[];
  updated: string[];
  unchanged: string[];
  orphaned: string[];
};

/**
 * Thrown by `syncModuleDescriptors` when it refuses to write — checked
 * BEFORE `fetchExistingModules`/any upsert, so a rejected sync never
 * partially writes. `issues` are pre-formatted, human-readable,
 * secret-free strings (module keys/capability names/paths are static code
 * identifiers, same safety guarantee `formatModuleDependencyGraphIssue`
 * already documents) — safe to log or surface in an API error response
 * verbatim.
 */
export class ModuleCompositionInvalidError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(
      `Refusing to sync module registry — composition validation failed:\n${issues
        .map((issue) => `  - ${issue}`)
        .join("\n")}`
    );
    this.name = "ModuleCompositionInvalidError";
  }
}

/**
 * Provenance-agnostic structural check, used when a caller passes an
 * explicit (possibly synthetic/test) `descriptors` array that
 * `composeModuleRegistry` can't meaningfully validate (it can't tell which
 * entries would have been "base" vs "application" for such an array).
 * `awcms_mini_modules.module_key` is `upsertModule`'s own `ON CONFLICT`
 * target, so two descriptors sharing a key — regardless of source — would
 * otherwise let whichever one this function's `Map` construction processes
 * last silently win, overwriting whichever row already existed. A flat
 * duplicate is unsafe to write no matter how it got here.
 */
function findDuplicateDescriptorKeys(
  descriptors: readonly ModuleDescriptor[]
): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const descriptor of descriptors) {
    if (seen.has(descriptor.key)) {
      duplicates.add(descriptor.key);
    }
    seen.add(descriptor.key);
  }

  return [...duplicates];
}

/**
 * Exported (Issue #697, epic #679) so `scripts/modules-sync.ts`'s
 * `--dry-run` mode can compute the exact same `planModuleSync` diff a real
 * run would act on — using this SAME read function, not a re-derived one —
 * while never calling `syncModuleDescriptors` itself (which would mutate).
 */
export async function fetchExistingModules(
  sql: Bun.SQL
): Promise<ExistingModuleRow[]> {
  const rows = (await sql`
    SELECT module_key, module_name, version, description, lifecycle_status, module_type, is_core
    FROM awcms_mini_modules
  `) as {
    module_key: string;
    module_name: string;
    version: string;
    description: string | null;
    lifecycle_status: string;
    module_type: string | null;
    is_core: boolean;
  }[];

  return rows.map((row) => ({
    moduleKey: row.module_key,
    moduleName: row.module_name,
    version: row.version,
    description: row.description,
    lifecycleStatus: row.lifecycle_status,
    moduleType: row.module_type,
    isCore: row.is_core
  }));
}

async function upsertModule(
  sql: Bun.SQL,
  descriptor: ModuleDescriptor
): Promise<void> {
  await sql`
    INSERT INTO awcms_mini_modules
      (module_key, module_name, status, version, description, module_type,
       lifecycle_status, is_core, updated_at)
    VALUES (
      ${descriptor.key}, ${descriptor.name}, ${descriptor.status},
      ${descriptor.version}, ${descriptor.description ?? null},
      ${descriptor.type ?? null}, ${descriptor.status},
      ${descriptor.isCore ?? false}, now()
    )
    ON CONFLICT (module_key) DO UPDATE SET
      module_name = EXCLUDED.module_name,
      status = EXCLUDED.status,
      version = EXCLUDED.version,
      description = EXCLUDED.description,
      module_type = EXCLUDED.module_type,
      lifecycle_status = EXCLUDED.lifecycle_status,
      is_core = EXCLUDED.is_core,
      updated_at = now()
  `;
}

/** Full replace, not a diff — cheap at this scale (a handful of rows per module) and guarantees the stored set can never silently drift from the descriptor's declared set. */
async function replaceDependencies(
  sql: Bun.SQL,
  descriptor: ModuleDescriptor
): Promise<void> {
  await sql`
    DELETE FROM awcms_mini_module_dependencies WHERE module_key = ${descriptor.key}
  `;

  for (const dependsOn of descriptor.dependencies) {
    await sql`
      INSERT INTO awcms_mini_module_dependencies (module_key, depends_on_module_key)
      VALUES (${descriptor.key}, ${dependsOn})
      ON CONFLICT (module_key, depends_on_module_key) DO NOTHING
    `;
  }
}

async function replaceNavigation(
  sql: Bun.SQL,
  descriptor: ModuleDescriptor
): Promise<void> {
  await sql`
    DELETE FROM awcms_mini_module_navigation WHERE module_key = ${descriptor.key}
  `;

  for (const entry of descriptor.navigation ?? []) {
    await sql`
      INSERT INTO awcms_mini_module_navigation
        (module_key, label_key, path, icon, sort_order, nav_group, required_permission)
      VALUES (
        ${descriptor.key}, ${entry.labelKey}, ${entry.path}, ${entry.icon ?? null},
        ${entry.order ?? 0}, ${entry.group ?? null}, ${entry.requiredPermission ?? null}
      )
    `;
  }
}

async function replaceJobs(
  sql: Bun.SQL,
  descriptor: ModuleDescriptor
): Promise<void> {
  await sql`
    DELETE FROM awcms_mini_module_jobs WHERE module_key = ${descriptor.key}
  `;

  for (const job of descriptor.jobs ?? []) {
    await sql`
      INSERT INTO awcms_mini_module_jobs
        (module_key, command, purpose, recommended_schedule, environment_notes, safe_in_offline_lan)
      VALUES (
        ${descriptor.key}, ${job.command}, ${job.purpose},
        ${job.recommendedSchedule ?? null}, ${job.environmentNotes ?? null},
        ${job.safeInOfflineLan ?? false}
      )
    `;
  }
}

/**
 * Orphaned modules (registered in the DB previously, no longer in
 * `listModules()`) are marked `lifecycle_status = 'disabled'` — never
 * deleted, and never touching their dependencies/navigation/jobs rows,
 * which stay as a historical record. `#511`'s own contract note applies
 * here: a module absent from code is, by definition, globally disabled.
 */
async function markOrphaned(sql: Bun.SQL, moduleKey: string): Promise<void> {
  await sql`
    UPDATE awcms_mini_modules
    SET lifecycle_status = 'disabled', updated_at = now()
    WHERE module_key = ${moduleKey} AND lifecycle_status <> 'disabled'
  `;
}

export async function syncModuleDescriptors(
  sql: Bun.SQL,
  descriptors: readonly ModuleDescriptor[] = listModules()
): Promise<DescriptorSyncResult> {
  // `listModules()` always returns the same stable, module-level array
  // reference (computed once at import time, `src/modules/index.ts`) — so
  // this reference check reliably identifies "the caller is syncing the
  // real, global effective registry" (every real call site: the CLI
  // script, the API endpoint, and all four internal "sync first" callers)
  // vs. "the caller passed an explicit/synthetic array" (this repo's own
  // diff/orphan-detection tests). Only the former can be resolved back to
  // known base-vs-application provenance, so only it gets the FULL
  // composition rule set (capability bindings, migration namespace,
  // deployment profiles, prohibited base override, etc.) with rich
  // diagnostics; the latter still gets the cheaper, provenance-agnostic
  // duplicate-key check, which is the one structural invariant that must
  // hold unconditionally for ANY descriptor list about to be upserted.
  if (descriptors === listModules()) {
    const compositionResult = composeModuleRegistry({
      base: listBaseModules(),
      application: applicationModuleRegistry
    });

    if (!compositionResult.valid) {
      throw new ModuleCompositionInvalidError(
        compositionResult.issues.map(formatModuleCompositionIssue)
      );
    }
  } else {
    const duplicateKeys = findDuplicateDescriptorKeys(descriptors);

    if (duplicateKeys.length > 0) {
      throw new ModuleCompositionInvalidError(
        duplicateKeys.map(
          (key) => `Module key "${key}" is declared more than once.`
        )
      );
    }
  }

  const existingRows = await fetchExistingModules(sql);
  const plan = planModuleSync(descriptors, existingRows);

  const result: DescriptorSyncResult = {
    created: [],
    updated: [],
    unchanged: [],
    orphaned: plan.orphanedModuleKeys
  };

  const descriptorsByKey = new Map(
    descriptors.map((descriptor) => [descriptor.key, descriptor] as const)
  );

  // Pass 1: upsert every module row first. A module can declare a
  // dependency on one that appears *later* in `descriptors` (e.g.
  // `reporting` depends on `email`, which is registered after it) — the
  // dependency FK requires the target row to already exist, so all module
  // rows must land before any dependency row is written (pass 2 below).
  for (const entry of plan.entries) {
    const descriptor = descriptorsByKey.get(entry.moduleKey)!;

    if (entry.action === "unchanged") {
      result.unchanged.push(entry.moduleKey);
    } else {
      await upsertModule(sql, descriptor);
      (entry.action === "create" ? result.created : result.updated).push(
        entry.moduleKey
      );
    }
  }

  // Pass 2: now that every module row exists, dependency/navigation/job
  // rows can be safely (re)written for each module.
  for (const entry of plan.entries) {
    const descriptor = descriptorsByKey.get(entry.moduleKey)!;

    await replaceDependencies(sql, descriptor);
    await replaceNavigation(sql, descriptor);
    await replaceJobs(sql, descriptor);
  }

  for (const moduleKey of plan.orphanedModuleKeys) {
    await markOrphaned(sql, moduleKey);
  }

  return result;
}
