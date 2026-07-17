/**
 * Module health/readiness service (Issue #520, epic #510). Every signal is
 * cheap and bounded (a handful of lightweight queries + a couple of small
 * file reads, all already cached-friendly at this scale) — this is meant
 * to be safe to call from an admin request, never a long-running or
 * business-transaction-blocking operation. The one exception —
 * `checkEmailProviderHealth`'s real network call — is only ever invoked
 * from the explicit `POST .../health/check` action (Issue #520's own
 * "provider checks are explicit" requirement), never from the passive
 * `GET .../health` read.
 *
 * Every catch below logs the real error server-side (via `log()`, doc 10
 * §Logger redaction) but only ever puts a fixed, generic string in the
 * signal `detail` returned to the caller — never a raw error message,
 * stack trace, or `DATABASE_URL`.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";

import { log } from "../../../lib/logging/logger";
import { listModules } from "../..";
import type { ModuleDescriptor } from "../../_shared/module-contract";
import {
  buildModulePermissionSyncReport,
  fetchCatalogPermissionsByModule
} from "./permission-sync";
import {
  buildModuleSettingsView,
  fetchTenantSettingsRowsByModule,
  type ModuleSettingsRow
} from "./module-settings";
import type { CatalogPermission } from "../domain/permission-sync";
import { fetchModuleJobs } from "./job-registry";
import { syncModuleDescriptors } from "./descriptor-sync";
import { validateJobDescriptor } from "../domain/job-registry";
import {
  classifyHealthStatus,
  type HealthStatus,
  type ReadinessSignal
} from "../domain/health-registry";
import { resolveEmailProvider } from "../../email/infrastructure/email-provider-resolver";

export type ModuleHealthReport = {
  moduleKey: string;
  status: HealthStatus;
  signals: ReadinessSignal[];
  generatedAt: string;
};

function findDescriptor(moduleKey: string): ModuleDescriptor | null {
  return listModules().find((d) => d.key === moduleKey) ?? null;
}

/**
 * Deliberately a minimal, local re-listing of `sql/*.sql` filenames — not
 * an import of `scripts/db-migrate.ts`'s own `discoverMigrationFiles`
 * (that would be a backwards dependency, `src/` on `scripts/`, and drags
 * in checksum/transaction-control validation this read-only check doesn't
 * need). Just enough to compare "files on disk" vs. "rows already applied".
 *
 * Cached for the life of the process on first success, same promise-caching
 * shape as `readYamlCached` below (Issue #824): `sql/*.sql` is build-time
 * content that cannot change under a running server, so re-`readdir`-ing it on
 * every health signal was pure waste. Caching the in-flight promise (not the
 * resolved value) means concurrent callers join one `readdir` instead of each
 * starting their own — see `readYamlCached`'s note on why that distinction
 * matters. Failures are deliberately NOT cached: unlike a missing spec file, a
 * filesystem error here is plausibly transient and must not pin
 * `migrations_applied` to `fail` for the rest of the process's life.
 */
let migrationFileNamesCache: Promise<string[]> | null = null;

function listMigrationFileNames(): Promise<string[]> {
  if (!migrationFileNamesCache) {
    const pending = (async () => {
      const migrationsDir = path.resolve(process.cwd(), "sql");
      const entries = await readdir(migrationsDir, { withFileTypes: true });

      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
        .map((entry) => entry.name);
    })();

    migrationFileNamesCache = pending;
    pending.catch(() => {
      if (migrationFileNamesCache === pending) {
        migrationFileNamesCache = null;
      }
    });
  }

  return migrationFileNamesCache;
}

async function migrationsAppliedSignal(
  tx: Bun.SQL,
  correlationId?: string
): Promise<ReadinessSignal> {
  try {
    const fileNames = await listMigrationFileNames();
    const appliedRows = (await tx`
      SELECT migration_name FROM awcms_mini_schema_migrations
    `) as { migration_name: string }[];
    const appliedNames = new Set(appliedRows.map((row) => row.migration_name));
    const pending = fileNames.filter((name) => !appliedNames.has(name));

    return {
      name: "migrations_applied",
      status: pending.length === 0 ? "pass" : "fail",
      detail:
        pending.length > 0
          ? `${pending.length} migration file(s) not yet applied.`
          : undefined
    };
  } catch (error) {
    log("error", "health-registry: migrations_applied check failed", {
      moduleKey: "module_management",
      correlationId,
      error: error instanceof Error ? error.message : String(error)
    });

    return {
      name: "migrations_applied",
      status: "fail",
      detail: "Could not check migration state."
    };
  }
}

/**
 * Every DB-backed input the generic signals need, fetched ONCE per render
 * rather than once per module (Issue #824). Before this existed, each of the
 * 23 registered modules independently ran its own registry lookup, migration
 * scan, permission-catalog query and settings lookup — ≈92 queries to answer a
 * single admin screen, growing linearly with every module added, which
 * saturated the connection pool and made `fetchModuleMatrix` time out under
 * load. All four inputs are small, whole-table (or whole-tenant) reads at this
 * scale, so batching them costs nothing and makes the fan-out O(1).
 *
 * A `null` map means that batch query itself failed; the signal it feeds then
 * reports `fail` with the same generic detail string the old per-module
 * `catch` produced, preserving the "never leak a raw error" guarantee.
 */
export type ModuleHealthContext = {
  /** Module-invariant by construction — `migrationsAppliedSignal` takes no module key, so all modules share one answer. */
  migrations: ReadinessSignal;
  registryStatusByKey: Map<string, string> | null;
  permissionsByModuleKey: Map<string, CatalogPermission[]> | null;
  settingsRowByModuleKey: Map<string, ModuleSettingsRow> | null;
};

async function fetchRegistryStatuses(
  tx: Bun.SQL,
  correlationId?: string
): Promise<Map<string, string> | null> {
  try {
    const rows = (await tx`
      SELECT module_key, lifecycle_status FROM awcms_mini_modules
    `) as { module_key: string; lifecycle_status: string }[];

    return new Map(rows.map((row) => [row.module_key, row.lifecycle_status]));
  } catch (error) {
    log("error", "health-registry: db_registry_synced check failed", {
      moduleKey: "module_management",
      correlationId,
      error: error instanceof Error ? error.message : String(error)
    });

    return null;
  }
}

async function fetchPermissionCatalog(
  tx: Bun.SQL,
  correlationId?: string
): Promise<Map<string, CatalogPermission[]> | null> {
  try {
    return await fetchCatalogPermissionsByModule(tx);
  } catch (error) {
    log("error", "health-registry: permission_catalog_synced check failed", {
      moduleKey: "module_management",
      correlationId,
      error: error instanceof Error ? error.message : String(error)
    });

    return null;
  }
}

async function fetchTenantSettingsRows(
  tx: Bun.SQL,
  tenantId: string,
  correlationId?: string
): Promise<Map<string, ModuleSettingsRow> | null> {
  try {
    return await fetchTenantSettingsRowsByModule(tx, tenantId);
  } catch (error) {
    log("error", "health-registry: settings_valid check failed", {
      moduleKey: "module_management",
      correlationId,
      error: error instanceof Error ? error.message : String(error)
    });

    return null;
  }
}

/**
 * Four queries + one (cached) `readdir` — the whole DB cost of a health render,
 * no matter how many modules are then resolved against it. Share one context
 * across every module of a single render; never cache it across requests (the
 * registry/settings state it snapshots is live data).
 */
export async function prepareModuleHealthContext(
  tx: Bun.SQL,
  tenantId: string,
  correlationId?: string
): Promise<ModuleHealthContext> {
  const [
    migrations,
    registryStatusByKey,
    permissionsByModuleKey,
    settingsRowByModuleKey
  ] = await Promise.all([
    migrationsAppliedSignal(tx, correlationId),
    fetchRegistryStatuses(tx, correlationId),
    fetchPermissionCatalog(tx, correlationId),
    fetchTenantSettingsRows(tx, tenantId, correlationId)
  ]);

  return {
    migrations,
    registryStatusByKey,
    permissionsByModuleKey,
    settingsRowByModuleKey
  };
}

function dbRegistrySyncedSignal(
  descriptor: ModuleDescriptor,
  context: ModuleHealthContext
): ReadinessSignal {
  if (!context.registryStatusByKey) {
    return {
      name: "db_registry_synced",
      status: "fail",
      detail: "Could not query the module registry."
    };
  }

  const lifecycleStatus = context.registryStatusByKey.get(descriptor.key);

  if (lifecycleStatus === undefined) {
    return {
      name: "db_registry_synced",
      status: "fail",
      detail: "No database registry row yet — run the descriptor sync."
    };
  }

  return {
    name: "db_registry_synced",
    status: lifecycleStatus === descriptor.status ? "pass" : "fail",
    detail:
      lifecycleStatus === descriptor.status
        ? undefined
        : "Database registry status is stale — run the descriptor sync."
  };
}

function permissionCatalogSyncedSignal(
  moduleKey: string,
  context: ModuleHealthContext,
  correlationId?: string
): ReadinessSignal {
  if (!context.permissionsByModuleKey) {
    return {
      name: "permission_catalog_synced",
      status: "fail",
      detail: "Could not check the permission catalog."
    };
  }

  try {
    const report = buildModulePermissionSyncReport(
      moduleKey,
      context.permissionsByModuleKey.get(moduleKey) ?? []
    );
    const unsynced = (report?.entries ?? []).filter(
      (entry) =>
        entry.status === "missing" || entry.status === "mismatched_description"
    );

    return {
      name: "permission_catalog_synced",
      status: unsynced.length === 0 ? "pass" : "fail",
      detail:
        unsynced.length > 0
          ? `${unsynced.length} declared permission(s) missing or mismatched in the catalog.`
          : undefined
    };
  } catch (error) {
    log("error", "health-registry: permission_catalog_synced check failed", {
      moduleKey,
      correlationId,
      error: error instanceof Error ? error.message : String(error)
    });

    return {
      name: "permission_catalog_synced",
      status: "fail",
      detail: "Could not check the permission catalog."
    };
  }
}

function settingsValidSignal(
  moduleKey: string,
  context: ModuleHealthContext,
  correlationId?: string
): ReadinessSignal {
  if (!context.settingsRowByModuleKey) {
    return {
      name: "settings_valid",
      status: "fail",
      detail: "Could not resolve effective module settings."
    };
  }

  try {
    buildModuleSettingsView(
      moduleKey,
      context.settingsRowByModuleKey.get(moduleKey) ?? null
    );
    return { name: "settings_valid", status: "pass" };
  } catch (error) {
    log("error", "health-registry: settings_valid check failed", {
      moduleKey,
      correlationId,
      error: error instanceof Error ? error.message : String(error)
    });

    return {
      name: "settings_valid",
      status: "fail",
      detail: "Could not resolve effective module settings."
    };
  }
}

function jobsDocumentedSignal(moduleKey: string): ReadinessSignal {
  const jobs = fetchModuleJobs(moduleKey) ?? [];

  if (jobs.length === 0) {
    return { name: "jobs_documented", status: "not_applicable" };
  }

  const invalid = jobs.filter((job) => !validateJobDescriptor(job).valid);

  return {
    name: "jobs_documented",
    status: invalid.length === 0 ? "pass" : "fail",
    detail:
      invalid.length > 0
        ? `${invalid.length} job descriptor(s) have an invalid shape.`
        : undefined
  };
}

/**
 * Caches the in-flight PROMISE, not the resolved document — deliberately, and
 * this is the single biggest win in Issue #824.
 *
 * The previous version only populated the cache AFTER its `await`, so every
 * concurrent caller missed. 22 of the 23 modules declare the very same
 * `openapi/awcms-mini-public-api.openapi.yaml` (~1 MB), and a health render
 * resolves them all in one `Promise.all` — so that one file was read and
 * YAML-parsed 22 times in parallel, ~5.6s of pure CPU, a textbook cache
 * stampede. Storing the promise synchronously before the first `await` means
 * the 21 later callers join the first parse instead of starting their own,
 * which is what actually collapses a cold render from ~5.6s to ~6ms.
 *
 * A parse failure resolves (and caches) `null` exactly as before — spec files
 * are build-time content, so a missing/broken one is a permanent fact, not a
 * transient error worth retrying per request.
 */
const yamlDocumentCache = new Map<string, Promise<unknown | null>>();

function readYamlCached(relativePath: string): Promise<unknown | null> {
  const cached = yamlDocumentCache.get(relativePath);

  if (cached) {
    return cached;
  }

  const pending = (async () => {
    try {
      const source = await readFile(
        path.resolve(process.cwd(), relativePath),
        "utf8"
      );
      return parseDocument(source).toJSON() as unknown;
    } catch {
      return null;
    }
  })();

  yamlDocumentCache.set(relativePath, pending);

  return pending;
}

async function openApiDocumentedSignal(
  descriptor: ModuleDescriptor
): Promise<ReadinessSignal> {
  if (!descriptor.api) {
    return { name: "openapi_documented", status: "not_applicable" };
  }

  const document = (await readYamlCached(descriptor.api.openApiPath)) as {
    paths?: Record<string, unknown>;
  } | null;
  const paths = document?.paths ? Object.keys(document.paths) : [];
  const hasBasePathEntry = paths.some((p) =>
    p.startsWith(descriptor.api!.basePath)
  );

  return {
    name: "openapi_documented",
    status: document && hasBasePathEntry ? "pass" : "fail",
    detail:
      document && hasBasePathEntry
        ? undefined
        : "No OpenAPI path found under the module's declared basePath."
  };
}

async function asyncApiDocumentedSignal(
  descriptor: ModuleDescriptor
): Promise<ReadinessSignal> {
  const publishes = descriptor.events?.publishes ?? [];

  if (publishes.length === 0) {
    return { name: "asyncapi_documented", status: "not_applicable" };
  }

  const document = (await readYamlCached(
    descriptor.events!.asyncApiPath ?? ""
  )) as { channels?: Record<string, unknown> } | null;
  const channels = document?.channels ?? {};
  const missing = publishes.filter((eventName) => !channels[eventName]);

  return {
    name: "asyncapi_documented",
    status: missing.length === 0 ? "pass" : "fail",
    detail:
      missing.length > 0
        ? `${missing.length} published event(s) missing an AsyncAPI channel.`
        : undefined
  };
}

async function computeGenericSignals(
  descriptor: ModuleDescriptor,
  context: ModuleHealthContext,
  correlationId?: string
): Promise<ReadinessSignal[]> {
  return [
    { name: "descriptor_registered", status: "pass" },
    dbRegistrySyncedSignal(descriptor, context),
    context.migrations,
    permissionCatalogSyncedSignal(descriptor.key, context, correlationId),
    settingsValidSignal(descriptor.key, context, correlationId),
    jobsDocumentedSignal(descriptor.key),
    await openApiDocumentedSignal(descriptor),
    await asyncApiDocumentedSignal(descriptor)
  ];
}

/**
 * `null` means `moduleKey` isn't a registered descriptor — `404`.
 *
 * Pass `context` when reporting on several modules in one render so they share
 * a single prefetch; omit it and this builds its own (four queries), which is
 * exactly what the single-module `GET .../health` endpoint wants.
 */
export async function fetchModuleHealthReport(
  tx: Bun.SQL,
  tenantId: string,
  moduleKey: string,
  correlationId?: string,
  context?: ModuleHealthContext
): Promise<ModuleHealthReport | null> {
  const descriptor = findDescriptor(moduleKey);

  if (!descriptor) {
    return null;
  }

  const resolvedContext =
    context ?? (await prepareModuleHealthContext(tx, tenantId, correlationId));
  const signals = await computeGenericSignals(
    descriptor,
    resolvedContext,
    correlationId
  );

  return {
    moduleKey,
    status: classifyHealthStatus(signals),
    signals,
    generatedAt: new Date().toISOString()
  };
}

/**
 * Health for many modules at a flat cost of four queries total (Issue #824) —
 * the batch entry point every multi-module caller (`fetchModuleMatrix`,
 * `admin/modules.astro`) should use instead of looping `fetchModuleHealthReport`.
 * Unregistered keys are simply absent from the returned map.
 */
export async function fetchModuleHealthReports(
  tx: Bun.SQL,
  tenantId: string,
  moduleKeys: readonly string[],
  correlationId?: string
): Promise<Map<string, ModuleHealthReport>> {
  const context = await prepareModuleHealthContext(tx, tenantId, correlationId);
  const reports = new Map<string, ModuleHealthReport>();

  for (const moduleKey of moduleKeys) {
    const report = await fetchModuleHealthReport(
      tx,
      tenantId,
      moduleKey,
      correlationId,
      context
    );

    if (report) {
      reports.set(moduleKey, report);
    }
  }

  return reports;
}

/**
 * Only `email` has a real, bounded, network-calling provider health check
 * today (`resolveEmailProvider().healthCheck()`, Issue #495 — already
 * timeout-bounded and error-truncating, the same function
 * `bun run email:provider:health` calls). Every other module has no
 * provider to check, so this signal is `not_applicable` for them — this is
 * the one deliberately module-specific check in this otherwise-generic
 * service (same precedent `scripts/security-readiness.ts` already
 * established: a shared operational script naming one specific module's
 * check, not a generic port every module must implement).
 */
async function providerHealthCheckSignal(
  moduleKey: string,
  correlationId?: string
): Promise<ReadinessSignal> {
  if (moduleKey !== "email") {
    return { name: "provider_health_check", status: "not_applicable" };
  }

  try {
    const result = await resolveEmailProvider().healthCheck();

    return {
      name: "provider_health_check",
      status: result.ok ? "pass" : "fail",
      detail: result.ok ? undefined : "Email provider health check failed."
    };
  } catch (error) {
    log("error", "health-registry: provider_health_check failed", {
      moduleKey,
      correlationId,
      error: error instanceof Error ? error.message : String(error)
    });

    return {
      name: "provider_health_check",
      status: "fail",
      detail: "Could not run the provider health check."
    };
  }
}

/**
 * `awcms_mini_module_health_checks` (migration 025) — instance-level
 * history, RLS-free (a health result is a fact about the deployed
 * instance, not about any one tenant), written only by the explicit
 * `POST .../health/check` action (never the passive `GET`, which would
 * otherwise turn every admin page view into a write). `message` is a
 * fixed, safe summary of which signal names failed — never a signal's
 * own `detail` text, keeping the same "generic strings only" guarantee
 * the signals themselves already provide.
 */
async function recordHealthCheckHistory(
  tx: Bun.SQL,
  moduleKey: string,
  report: ModuleHealthReport
): Promise<void> {
  const failedNames = report.signals
    .filter((signal) => signal.status === "fail")
    .map((signal) => signal.name);
  const message =
    failedNames.length > 0
      ? `Failed signals: ${failedNames.join(", ")}.`
      : null;

  await tx`
    INSERT INTO awcms_mini_module_health_checks (module_key, status, message)
    VALUES (${moduleKey}, ${report.status}, ${message})
  `;
}

/**
 * The explicit, on-demand variant (`POST .../health/check`) — same
 * generic signals as `fetchModuleHealthReport`, plus the one live
 * provider check where applicable. Never called from `GET .../health`,
 * which stays fast/cheap on every call. Records its result into
 * `awcms_mini_module_health_checks` as a history entry — that table has
 * an FK to `awcms_mini_modules`, so this syncs the registry first (same
 * "sync first" reasoning as `tenant-module-lifecycle.ts`/
 * `module-settings.ts`). This is the one place `db_registry_synced` can
 * genuinely read differently between `GET` and `POST` for the same
 * module — `POST` self-heals the registry as a side effect of writing
 * history, `GET` never does (stays a pure read).
 */
export async function runModuleHealthCheck(
  tx: Bun.SQL,
  tenantId: string,
  moduleKey: string,
  correlationId?: string
): Promise<ModuleHealthReport | null> {
  const descriptor = findDescriptor(moduleKey);

  if (!descriptor) {
    return null;
  }

  await syncModuleDescriptors(tx);

  const context = await prepareModuleHealthContext(tx, tenantId, correlationId);
  const signals = await computeGenericSignals(
    descriptor,
    context,
    correlationId
  );
  signals.push(await providerHealthCheckSignal(moduleKey, correlationId));

  const report: ModuleHealthReport = {
    moduleKey,
    status: classifyHealthStatus(signals),
    signals,
    generatedAt: new Date().toISOString()
  };

  await recordHealthCheckHistory(tx, moduleKey, report);

  return report;
}
