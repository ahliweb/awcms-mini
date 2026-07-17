/**
 * Module-contribution sync (Issue #750, epic #738 platform-evolution Wave
 * 3, ADR-0021 §5). Reads `listModules()` (or an explicit descriptor list,
 * mirroring `module-management/application/descriptor-sync.ts`'s own
 * `descriptors` default-parameter pattern), validates every declared
 * `referenceData.contributesValueSets` entry (`domain/contribution-
 * registry.ts`), and upserts them into THIS module's own tables —
 * `awcms_mini_reference_value_sets`/`awcms_mini_reference_codes`
 * (`scope: "module_contributed"`, `managed_by_descriptor: true`).
 *
 * Never invoked automatically by another module's code — always explicit
 * (`bun run reference-data:contributions:sync`, mirroring `bun run
 * modules:sync`'s own explicit-invocation convention). Idempotent: an
 * unchanged descriptor re-synced produces no functional change (plain
 * `ON CONFLICT`-free upsert-by-read-then-write, since this module needs
 * per-row conflict DECISIONS — see below — that a blind `ON CONFLICT DO
 * UPDATE` cannot express).
 *
 * A `managed_by_descriptor: false` row (created manually via this
 * module's own CRUD API) that happens to collide on `key`/`code` with a
 * module's declared contribution is NEVER overwritten — reported back as
 * a `conflicts` entry instead (issue #750: "module owner ... enforced
 * server-side, not trusted from request input" — a manual row always
 * wins over an attempted descriptor sync collision, since the descriptor
 * sync has no per-request actor to attribute the overwrite to).
 */
import {
  validateReferenceDataContributionRegistry,
  type CollectedReferenceDataContribution
} from "../domain/contribution-registry";
import { listModules } from "../..";
import type {
  ModuleDescriptor,
  ReferenceCodeLabelContribution
} from "../../_shared/module-contract";

export type ReferenceDataContributionSyncResult = {
  valueSetsCreated: string[];
  valueSetsUpdated: string[];
  codesCreated: number;
  codesUpdated: number;
  conflicts: string[];
};

export class ReferenceDataContributionRegistryInvalidError extends Error {
  constructor(public readonly issues: string[]) {
    super(
      `Reference-data contribution registry is invalid:\n${issues.join("\n")}`
    );
    this.name = "ReferenceDataContributionRegistryInvalidError";
  }
}

async function syncOneContribution(
  tx: Bun.SQL,
  entry: CollectedReferenceDataContribution,
  result: ReferenceDataContributionSyncResult
): Promise<void> {
  const { ownerModuleKey, contribution } = entry;

  const existingValueSetRows = (await tx`
    SELECT id, scope, owner_module, managed_by_descriptor, name, description, override_policy
    FROM awcms_mini_reference_value_sets WHERE key = ${contribution.key}
  `) as {
    id: string;
    scope: string;
    owner_module: string;
    managed_by_descriptor: boolean;
    name: string;
    description: string | null;
    override_policy: string;
  }[];
  const existingValueSet = existingValueSetRows[0];

  let valueSetId: string;

  if (!existingValueSet) {
    const inserted = (await tx`
      INSERT INTO awcms_mini_reference_value_sets
        (key, owner_module, name, description, scope, override_policy, managed_by_descriptor)
      VALUES (
        ${contribution.key}, ${ownerModuleKey}, ${contribution.name}, ${contribution.description},
        'module_contributed', ${contribution.overridePolicy}, true
      )
      RETURNING id
    `) as { id: string }[];
    valueSetId = inserted[0]!.id;
    result.valueSetsCreated.push(contribution.key);
  } else if (
    !existingValueSet.managed_by_descriptor ||
    existingValueSet.owner_module !== ownerModuleKey
  ) {
    result.conflicts.push(
      `value set "${contribution.key}" already exists (owner=${existingValueSet.owner_module}, managed_by_descriptor=${existingValueSet.managed_by_descriptor}) — skipped, never overwritten by sync.`
    );
    return;
  } else {
    valueSetId = existingValueSet.id;
    await tx`
      UPDATE awcms_mini_reference_value_sets
      SET name = ${contribution.name}, description = ${contribution.description},
          override_policy = ${contribution.overridePolicy}, updated_at = now()
      WHERE id = ${valueSetId}
    `;
    result.valueSetsUpdated.push(contribution.key);
  }

  // Issue #835 §2: resolve every declared code for this value set in ONE
  // `code = ANY(...)` read instead of one SELECT per code. The per-code
  // create/conflict/update DECISION still runs in JS below (a blind
  // `ON CONFLICT DO UPDATE` cannot express "a manually-created row is never
  // overwritten, it is reported as a conflict" — see this file's header), it
  // just no longer costs a round-trip to find each row.
  const declaredCodes = contribution.codes.map((codeEntry) => codeEntry.code);
  const existingCodeByCode = new Map<
    string,
    { id: string; managed_by_descriptor: boolean }
  >();

  if (declaredCodes.length > 0) {
    const existingCodeRows = (await tx`
      SELECT id, code, managed_by_descriptor FROM awcms_mini_reference_codes
      WHERE value_set_id = ${valueSetId}
        AND code = ANY(${tx.array(declaredCodes, "text")})
    `) as { id: string; code: string; managed_by_descriptor: boolean }[];

    for (const row of existingCodeRows) {
      existingCodeByCode.set(row.code, {
        id: row.id,
        managed_by_descriptor: row.managed_by_descriptor
      });
    }
  }

  // And every existing translation for those codes in ONE read, so the
  // reconciliation below can DIFF (write only real changes) instead of the
  // previous delete-all-then-reinsert-every-label, which rewrote every
  // translation row on every sync — pure WAL/index churn for the common
  // "unchanged descriptor re-synced" case this module is built around.
  const existingCodeIds = [...existingCodeByCode.values()].map(
    (entry) => entry.id
  );
  const existingTranslations = new Map<
    string,
    Map<string, { label: string; description: string | null }>
  >();

  if (existingCodeIds.length > 0) {
    const translationRows = (await tx`
      SELECT code_id, locale, label, description
      FROM awcms_mini_reference_code_translations
      WHERE code_id = ANY(${tx.array(existingCodeIds, "uuid")})
    `) as {
      code_id: string;
      locale: string;
      label: string;
      description: string | null;
    }[];

    for (const row of translationRows) {
      let byLocale = existingTranslations.get(row.code_id);
      if (!byLocale) {
        byLocale = new Map();
        existingTranslations.set(row.code_id, byLocale);
      }
      byLocale.set(row.locale, {
        label: row.label,
        description: row.description
      });
    }
  }

  for (const codeEntry of contribution.codes) {
    const existingCode = existingCodeByCode.get(codeEntry.code);

    let codeId: string;
    if (!existingCode) {
      const inserted = (await tx`
        INSERT INTO awcms_mini_reference_codes
          (value_set_id, code, sort_order, metadata, provenance, managed_by_descriptor)
        VALUES (
          ${valueSetId}, ${codeEntry.code}, ${codeEntry.sortOrder ?? 0}, ${codeEntry.metadata ?? {}},
          'module', true
        )
        RETURNING id
      `) as { id: string }[];
      codeId = inserted[0]!.id;
      result.codesCreated += 1;
    } else if (!existingCode.managed_by_descriptor) {
      result.conflicts.push(
        `code "${codeEntry.code}" in value set "${contribution.key}" already exists as a manually-created row — skipped, never overwritten by sync.`
      );
      continue;
    } else {
      codeId = existingCode.id;
      await tx`
        UPDATE awcms_mini_reference_codes
        SET sort_order = ${codeEntry.sortOrder ?? 0}, metadata = ${codeEntry.metadata ?? {}},
            updated_at = now()
        WHERE id = ${codeId}
      `;
      result.codesUpdated += 1;
    }

    await reconcileCodeTranslations(
      tx,
      codeId,
      codeEntry.labels,
      // A freshly INSERTed code has no rows yet; an updated one uses its
      // pre-read snapshot (never null-coalesced into a stale write path).
      existingTranslations.get(codeId) ?? new Map()
    );
  }
}

/**
 * Diff-reconcile a code's translations against its desired label set (Issue
 * #835 §2). Writes ONLY real changes: inserts locales that are new, updates
 * locales whose label/description actually differ, deletes locales no longer
 * declared. An unchanged re-sync issues no writes at all — replacing the old
 * `DELETE all + INSERT every label` that churned every row on every sync.
 */
async function reconcileCodeTranslations(
  tx: Bun.SQL,
  codeId: string,
  desiredLabels: readonly ReferenceCodeLabelContribution[],
  existingByLocale: Map<string, { label: string; description: string | null }>
): Promise<void> {
  const desiredLocales = new Set<string>();

  for (const label of desiredLabels) {
    desiredLocales.add(label.locale);
    const desiredDescription = label.description ?? null;
    const existing = existingByLocale.get(label.locale);

    if (!existing) {
      await tx`
        INSERT INTO awcms_mini_reference_code_translations (code_id, locale, label, description)
        VALUES (${codeId}, ${label.locale}, ${label.label}, ${desiredDescription})
      `;
    } else if (
      existing.label !== label.label ||
      existing.description !== desiredDescription
    ) {
      await tx`
        UPDATE awcms_mini_reference_code_translations
        SET label = ${label.label}, description = ${desiredDescription}, updated_at = now()
        WHERE code_id = ${codeId} AND locale = ${label.locale}
      `;
    }
  }

  const staleLocales = [...existingByLocale.keys()].filter(
    (locale) => !desiredLocales.has(locale)
  );

  if (staleLocales.length > 0) {
    await tx`
      DELETE FROM awcms_mini_reference_code_translations
      WHERE code_id = ${codeId}
        AND locale = ANY(${tx.array(staleLocales, "text")})
    `;
  }
}

export async function syncReferenceDataContributions(
  tx: Bun.SQL,
  descriptors: readonly ModuleDescriptor[] = listModules()
): Promise<ReferenceDataContributionSyncResult> {
  const validation = validateReferenceDataContributionRegistry(descriptors);
  if (!validation.valid) {
    throw new ReferenceDataContributionRegistryInvalidError(
      validation.issues.map(
        (issue) => `[${issue.valueSetKey}] ${issue.message}`
      )
    );
  }

  const result: ReferenceDataContributionSyncResult = {
    valueSetsCreated: [],
    valueSetsUpdated: [],
    codesCreated: 0,
    codesUpdated: 0,
    conflicts: []
  };

  for (const entry of validation.contributions) {
    await syncOneContribution(tx, entry, result);
  }

  return result;
}
