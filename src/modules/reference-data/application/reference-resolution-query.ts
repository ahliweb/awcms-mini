/**
 * Read-side baseline + tenant-override resolution query (Issue #750, epic
 * #738 platform-evolution Wave 3, ADR-0021 §8). Fetches the GLOBAL
 * baseline (`awcms_mini_reference_codes` + translations, no tenant
 * filter — identical for every tenant) and `tenantId`'s own override/
 * extension rows (`awcms_mini_reference_tenant_codes` + translations,
 * `tx` MUST be `withTenant`-scoped so RLS only ever returns THIS tenant's
 * rows), then hands both to the pure merge (`domain/resolution.ts`).
 *
 * This is the SAME function both the tenant-codes list/resolve API route
 * and `application/reference-data-port-adapter.ts` (the capability port
 * implementation) call — one resolution code path, not two that could
 * drift.
 */
import {
  resolveOneReferenceCode,
  resolveReferenceCodes,
  type ResolutionBaselineCodeRow,
  type ResolutionTenantCodeRow,
  type ResolvedReferenceCodeEntry
} from "../domain/resolution";

type BaselineDbRow = {
  code: string;
  sort_order: number;
  metadata: Record<string, unknown>;
  valid_from: Date;
  valid_to: Date | null;
  deprecated_at: Date | null;
};

type TenantDbRow = BaselineDbRow & { base_code_id: string | null };

type LabelDbRow = {
  owner_id: string;
  locale: string;
  label: string;
  description: string | null;
};

async function fetchBaselineWithLabels(
  tx: Bun.SQL,
  valueSetId: string
): Promise<ResolutionBaselineCodeRow[]> {
  const codeRows = (await tx`
    SELECT id, code, sort_order, metadata, valid_from, valid_to, deprecated_at
    FROM awcms_mini_reference_codes
    WHERE value_set_id = ${valueSetId}
  `) as (BaselineDbRow & { id: string })[];

  if (codeRows.length === 0) {
    return [];
  }

  const labelRows = (await tx`
    SELECT code_id AS owner_id, locale, label, description
    FROM awcms_mini_reference_code_translations
    WHERE code_id = ANY(${tx.array(
      codeRows.map((row) => row.id),
      "uuid"
    )})
  `) as LabelDbRow[];

  const labelsById = new Map<string, LabelDbRow[]>();
  for (const label of labelRows) {
    const list = labelsById.get(label.owner_id) ?? [];
    list.push(label);
    labelsById.set(label.owner_id, list);
  }

  return codeRows.map((row) => ({
    code: row.code,
    sortOrder: Number(row.sort_order),
    metadata: row.metadata,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    deprecatedAt: row.deprecated_at,
    labels: (labelsById.get(row.id) ?? []).map((label) => ({
      locale: label.locale,
      label: label.label,
      description: label.description
    }))
  }));
}

async function fetchTenantCodesWithLabels(
  tx: Bun.SQL,
  tenantId: string,
  valueSetId: string
): Promise<ResolutionTenantCodeRow[]> {
  const codeRows = (await tx`
    SELECT id, base_code_id, code, sort_order, metadata, valid_from, valid_to, deprecated_at
    FROM awcms_mini_reference_tenant_codes
    WHERE tenant_id = ${tenantId} AND value_set_id = ${valueSetId}
  `) as (TenantDbRow & { id: string })[];

  if (codeRows.length === 0) {
    return [];
  }

  const labelRows = (await tx`
    SELECT tenant_code_id AS owner_id, locale, label, description
    FROM awcms_mini_reference_tenant_code_translations
    WHERE tenant_id = ${tenantId}
      AND tenant_code_id = ANY(${tx.array(
        codeRows.map((row) => row.id),
        "uuid"
      )})
  `) as LabelDbRow[];

  const labelsById = new Map<string, LabelDbRow[]>();
  for (const label of labelRows) {
    const list = labelsById.get(label.owner_id) ?? [];
    list.push(label);
    labelsById.set(label.owner_id, list);
  }

  return codeRows.map((row) => ({
    baseCodeId: row.base_code_id,
    code: row.code,
    sortOrder: Number(row.sort_order),
    metadata: row.metadata,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    deprecatedAt: row.deprecated_at,
    labels: (labelsById.get(row.id) ?? []).map((label) => ({
      locale: label.locale,
      label: label.label,
      description: label.description
    }))
  }));
}

export type ResolveValueSetOptions = {
  asOf?: Date;
  locale?: string;
  includeDeprecated?: boolean;
};

/** Resolves every currently-usable code in `valueSetId` for `tenantId` — baseline + this tenant's own overrides/extensions, deterministic precedence (`domain/resolution.ts`). */
export async function resolveReferenceValueSetForTenant(
  tx: Bun.SQL,
  tenantId: string,
  valueSetId: string,
  options: ResolveValueSetOptions = {}
): Promise<ResolvedReferenceCodeEntry[]> {
  const [baseline, tenantCodes] = await Promise.all([
    fetchBaselineWithLabels(tx, valueSetId),
    fetchTenantCodesWithLabels(tx, tenantId, valueSetId)
  ]);

  return resolveReferenceCodes(baseline, tenantCodes, {
    asOf: options.asOf ?? new Date(),
    locale: options.locale ?? "en",
    includeDeprecated: options.includeDeprecated ?? false
  });
}

/** Resolves exactly one `code` in `valueSetId` for `tenantId` — `null` when it cannot be resolved (fails safe, never a guessed default). */
export async function resolveReferenceCodeForTenant(
  tx: Bun.SQL,
  tenantId: string,
  valueSetId: string,
  code: string,
  options: ResolveValueSetOptions = {}
): Promise<ResolvedReferenceCodeEntry | null> {
  const [baseline, tenantCodes] = await Promise.all([
    fetchBaselineWithLabels(tx, valueSetId),
    fetchTenantCodesWithLabels(tx, tenantId, valueSetId)
  ]);

  return resolveOneReferenceCode(baseline, tenantCodes, code, {
    asOf: options.asOf ?? new Date(),
    locale: options.locale ?? "en",
    includeDeprecated: options.includeDeprecated ?? false
  });
}
