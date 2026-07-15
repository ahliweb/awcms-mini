/**
 * Baseline-vs-tenant-override resolution (Issue #750, epic #738
 * platform-evolution Wave 3, ADR-0021 §8). Pure function only — no I/O,
 * no database, no `tenantId` parameter at all: this function merges two
 * ALREADY tenant-scoped inputs (the global baseline list, and a caller-
 * supplied tenant-override list that the CALLER is responsible for
 * fetching via `withTenant`-scoped RLS, `application/reference-
 * resolution-query.ts`) — it structurally cannot leak another tenant's
 * rows because it never sees a tenant identifier or reaches out to fetch
 * anything itself. The real cross-tenant isolation guarantee lives at the
 * RLS layer (migration 069); this function's job is deterministic
 * PRECEDENCE, tested in isolation from any database.
 *
 * Precedence rule (issue #750 acceptance criterion: "Baseline versus
 * tenant override precedence is deterministic and tested"): a tenant
 * override/extension row for a given `code` string ALWAYS wins over a
 * same-`code` baseline row — never merged field-by-field, never "most
 * recently updated wins". Unknown/ambiguous codes fail safely: a `code`
 * requested via `resolveOneReferenceCode` that matches nothing in either
 * input returns `null`, never a guessed/default value.
 */
export type ReferenceCodeLabelRow = {
  locale: string;
  label: string;
  description: string | null;
};

export type ResolutionBaselineCodeRow = {
  code: string;
  sortOrder: number;
  metadata: Record<string, unknown>;
  validFrom: Date;
  validTo: Date | null;
  deprecatedAt: Date | null;
  labels: readonly ReferenceCodeLabelRow[];
};

export type ResolutionTenantCodeRow = {
  /** `null` = extension (a wholly new tenant-defined code); non-null = override of a baseline code with this same `code` string. */
  baseCodeId: string | null;
  code: string;
  sortOrder: number;
  metadata: Record<string, unknown>;
  validFrom: Date;
  validTo: Date | null;
  deprecatedAt: Date | null;
  labels: readonly ReferenceCodeLabelRow[];
};

export type ResolvedReferenceCodeEntry = {
  code: string;
  isTenantOverride: boolean;
  label: string;
  description: string | null;
  sortOrder: number;
  metadata: Record<string, unknown>;
  validFrom: Date;
  validTo: Date | null;
  deprecated: boolean;
};

export type ResolutionOptions = {
  asOf: Date;
  locale: string;
  includeDeprecated: boolean;
};

function isActiveAt(
  row: { validFrom: Date; validTo: Date | null; deprecatedAt: Date | null },
  asOf: Date
): boolean {
  if (row.deprecatedAt !== null && row.deprecatedAt <= asOf) {
    return false;
  }
  if (asOf < row.validFrom) {
    return false;
  }
  if (row.validTo !== null && asOf >= row.validTo) {
    return false;
  }
  return true;
}

function pickLabel(
  labels: readonly ReferenceCodeLabelRow[],
  locale: string,
  fallbackCode: string
): { label: string; description: string | null } {
  const exact = labels.find((entry) => entry.locale === locale);
  if (exact) {
    return { label: exact.label, description: exact.description };
  }
  const english = labels.find((entry) => entry.locale === "en");
  if (english) {
    return { label: english.label, description: english.description };
  }
  const first = labels[0];
  if (first) {
    return { label: first.label, description: first.description };
  }
  return { label: fallbackCode, description: null };
}

function toResolvedEntry(
  row: ResolutionBaselineCodeRow | ResolutionTenantCodeRow,
  isTenantOverride: boolean,
  asOf: Date,
  locale: string
): ResolvedReferenceCodeEntry {
  const { label, description } = pickLabel(row.labels, locale, row.code);
  return {
    code: row.code,
    isTenantOverride,
    label,
    description,
    sortOrder: row.sortOrder,
    metadata: row.metadata,
    validFrom: row.validFrom,
    validTo: row.validTo,
    deprecated: row.deprecatedAt !== null && row.deprecatedAt <= asOf
  };
}

/**
 * Merges baseline + tenant-override/extension rows into the final
 * resolved list a tenant sees, applying as-of/deprecation filtering and
 * deterministic code-string precedence (tenant row always wins). Sorted
 * by `sortOrder` then `code` for a stable, deterministic order.
 */
export function resolveReferenceCodes(
  baseline: readonly ResolutionBaselineCodeRow[],
  tenantCodes: readonly ResolutionTenantCodeRow[],
  options: ResolutionOptions
): ResolvedReferenceCodeEntry[] {
  const byCode = new Map<string, ResolvedReferenceCodeEntry>();

  for (const row of baseline) {
    if (!options.includeDeprecated && !isActiveAt(row, options.asOf)) {
      continue;
    }
    byCode.set(
      row.code,
      toResolvedEntry(row, false, options.asOf, options.locale)
    );
  }

  for (const row of tenantCodes) {
    if (!options.includeDeprecated && !isActiveAt(row, options.asOf)) {
      byCode.delete(row.code);
      continue;
    }
    byCode.set(
      row.code,
      toResolvedEntry(row, true, options.asOf, options.locale)
    );
  }

  return [...byCode.values()].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) {
      return a.sortOrder - b.sortOrder;
    }
    return a.code.localeCompare(b.code);
  });
}

/** Resolves exactly one `code` — `null` when it cannot be resolved (unknown/ambiguous codes fail safely, issue #750 requirement), never a guessed default. */
export function resolveOneReferenceCode(
  baseline: readonly ResolutionBaselineCodeRow[],
  tenantCodes: readonly ResolutionTenantCodeRow[],
  code: string,
  options: ResolutionOptions
): ResolvedReferenceCodeEntry | null {
  const resolved = resolveReferenceCodes(
    baseline.filter((row) => row.code === code),
    tenantCodes.filter((row) => row.code === code),
    options
  );
  return resolved[0] ?? null;
}
