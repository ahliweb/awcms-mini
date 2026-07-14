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
import type { ModuleDescriptor } from "../../_shared/module-contract";

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

  for (const codeEntry of contribution.codes) {
    const existingCodeRows = (await tx`
      SELECT id, managed_by_descriptor FROM awcms_mini_reference_codes
      WHERE value_set_id = ${valueSetId} AND code = ${codeEntry.code}
    `) as { id: string; managed_by_descriptor: boolean }[];
    const existingCode = existingCodeRows[0];

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

    await tx`DELETE FROM awcms_mini_reference_code_translations WHERE code_id = ${codeId}`;
    for (const label of codeEntry.labels) {
      await tx`
        INSERT INTO awcms_mini_reference_code_translations (code_id, locale, label, description)
        VALUES (${codeId}, ${label.locale}, ${label.label}, ${label.description ?? null})
      `;
    }
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
