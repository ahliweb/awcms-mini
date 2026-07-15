/**
 * Static reference-data contribution registry validation gate (Issue
 * #750, epic #738 platform-evolution Wave 3, ADR-0021 §5). Pure
 * code-registry validation — no I/O, no database, no network — same
 * shape as `identity-access/domain/sod-rule-registry.ts`'s
 * `validateSoDRuleRegistry`, which `scripts/identity-access-sod-registry-
 * check.ts` (`bun run identity-access:sod-registry:check`) already wires
 * into `bun run check`. This file's `validateReferenceDataContributionRegistry`
 * is wired the same way by `scripts/reference-data-contributions-check.ts`
 * (`bun run reference-data:contributions:check`).
 *
 * Every `ReferenceValueSetContribution` is declared by its OWNING
 * module's own `module.ts` (`ModuleDescriptor.referenceData.
 * contributesValueSets`, see `_shared/module-contract.ts`) — this file
 * only AGGREGATES (`collectReferenceDataContributions`) and VALIDATES
 * what modules already declared. It never invents a value set and never
 * reaches into another module's schema.
 */
import type {
  ModuleDescriptor,
  ReferenceValueSetContribution
} from "../../_shared/module-contract";

const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;

export const VALID_OVERRIDE_POLICIES: readonly string[] = [
  "none",
  "tenant_extend",
  "tenant_override",
  "tenant_extend_and_override"
];

const MAX_CODES_PER_VALUE_SET = 500;

export type ReferenceDataContributionIssue = {
  valueSetKey: string;
  message: string;
};

export function formatReferenceDataContributionIssue(
  issue: ReferenceDataContributionIssue
): string {
  return `[${issue.valueSetKey}] ${issue.message}`;
}

export type CollectedReferenceDataContribution = {
  ownerModuleKey: string;
  contribution: ReferenceValueSetContribution;
};

/** Flattens every registered module's own `referenceData.contributesValueSets` into one list, tagged with the declaring module's key. */
export function collectReferenceDataContributions(
  modules: readonly ModuleDescriptor[]
): CollectedReferenceDataContribution[] {
  return modules.flatMap((module) =>
    (module.referenceData?.contributesValueSets ?? []).map((contribution) => ({
      ownerModuleKey: module.key,
      contribution
    }))
  );
}

function validateSingleContribution(
  ownerModuleKey: string,
  contribution: ReferenceValueSetContribution
): ReferenceDataContributionIssue[] {
  const issues: ReferenceDataContributionIssue[] = [];
  const push = (message: string) =>
    issues.push({ valueSetKey: contribution.key || "(missing key)", message });

  if (!contribution.key || !KEY_PATTERN.test(contribution.key)) {
    push(
      `key must be non-empty, lowercase snake_case (got ${JSON.stringify(contribution.key)}).`
    );
  }

  if (!contribution.name) {
    push("name is required.");
  }

  if (!contribution.description) {
    push("description is required.");
  }

  if (!VALID_OVERRIDE_POLICIES.includes(contribution.overridePolicy)) {
    push(
      `overridePolicy ${JSON.stringify(contribution.overridePolicy)} is not one of ${VALID_OVERRIDE_POLICIES.join(", ")}.`
    );
  }

  if (!Array.isArray(contribution.codes) || contribution.codes.length === 0) {
    push("codes must declare at least one entry.");
  } else if (contribution.codes.length > MAX_CODES_PER_VALUE_SET) {
    push(
      `codes must declare at most ${MAX_CODES_PER_VALUE_SET} entries (got ${contribution.codes.length}).`
    );
  } else {
    const seenCodes = new Set<string>();
    for (const codeEntry of contribution.codes) {
      if (!codeEntry.code || !CODE_PATTERN.test(codeEntry.code)) {
        push(`code ${JSON.stringify(codeEntry.code)} is not a valid code.`);
      }
      if (seenCodes.has(codeEntry.code)) {
        push(`duplicate code ${JSON.stringify(codeEntry.code)}.`);
      }
      seenCodes.add(codeEntry.code);

      if (!Array.isArray(codeEntry.labels) || codeEntry.labels.length === 0) {
        push(
          `code ${JSON.stringify(codeEntry.code)} requires at least one label.`
        );
      } else {
        const hasEnglish = codeEntry.labels.some(
          (label) => label.locale === "en"
        );
        if (!hasEnglish) {
          push(
            `code ${JSON.stringify(codeEntry.code)} requires an "en" label (doc convention: default en, min en+id).`
          );
        }
        for (const label of codeEntry.labels) {
          if (!LOCALE_PATTERN.test(label.locale)) {
            push(
              `code ${JSON.stringify(codeEntry.code)} has an invalid locale ${JSON.stringify(label.locale)}.`
            );
          }
          if (!label.label || label.label.trim().length === 0) {
            push(
              `code ${JSON.stringify(codeEntry.code)} locale ${JSON.stringify(label.locale)} requires a non-empty label.`
            );
          }
        }
      }
    }
  }

  return issues;
}

export type ReferenceDataContributionRegistryResult =
  | {
      valid: true;
      contributions: CollectedReferenceDataContribution[];
    }
  | {
      valid: false;
      contributions: CollectedReferenceDataContribution[];
      issues: ReferenceDataContributionIssue[];
    };

/**
 * Validates every registered module's static contribution, including
 * global uniqueness of `key` across ALL modules (a module cannot declare a
 * value set another module already owns — `ownerModuleKey` is always the
 * declaring module's own key, trusted from the descriptor, never
 * request-controlled).
 */
export function validateReferenceDataContributionRegistry(
  modules: readonly ModuleDescriptor[]
): ReferenceDataContributionRegistryResult {
  const contributions = collectReferenceDataContributions(modules);
  const issues: ReferenceDataContributionIssue[] = [];
  const keyOwners = new Map<string, string>();

  for (const entry of contributions) {
    issues.push(
      ...validateSingleContribution(entry.ownerModuleKey, entry.contribution)
    );

    const existingOwner = keyOwners.get(entry.contribution.key);
    if (existingOwner && existingOwner !== entry.ownerModuleKey) {
      issues.push({
        valueSetKey: entry.contribution.key,
        message: `declared by both "${existingOwner}" and "${entry.ownerModuleKey}" — a value set key must have exactly one owner module.`
      });
    } else if (!existingOwner) {
      keyOwners.set(entry.contribution.key, entry.ownerModuleKey);
    }
  }

  if (issues.length > 0) {
    return { valid: false, contributions, issues };
  }

  return { valid: true, contributions };
}
