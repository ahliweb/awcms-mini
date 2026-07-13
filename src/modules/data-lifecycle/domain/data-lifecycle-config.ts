/**
 * Env-based configuration for `data_lifecycle` (Issue #745). Mirrors
 * `visitor-analytics/domain/visitor-analytics-config.ts`'s
 * `resolveVisitorAnalyticsConfig` shape: a single `resolve*Config`
 * function, called once at each composition root (job script / API
 * route), never `process.env` read ad hoc from deep inside
 * application/domain code.
 *
 * Deliberately ONE new env var (`DATA_LIFECYCLE_ARCHIVE_ROOT_PATH`) — per
 * issue #745 scope ("do not duplicate immutable descriptor facts in
 * mutable settings"), retention days/batch limits are already owned by
 * each `HighVolumeTableDescriptor` in code (or, for delegated adopters,
 * by their OWNING module's own existing env var — e.g.
 * `AUDIT_LOG_RETENTION_DAYS` — never re-declared here). Only the archive
 * artifact's filesystem root is genuinely deployment-specific
 * infrastructure configuration.
 */
export const DEFAULT_ARCHIVE_ROOT_PATH = "./var/data-lifecycle-archive";

export type DataLifecycleConfig = {
  archiveRootPath: string;
};

export function resolveDataLifecycleConfig(): DataLifecycleConfig {
  const envValue = process.env.DATA_LIFECYCLE_ARCHIVE_ROOT_PATH;

  return {
    archiveRootPath:
      envValue && envValue.trim().length > 0
        ? envValue
        : DEFAULT_ARCHIVE_ROOT_PATH
  };
}
