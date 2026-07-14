/**
 * reference-data-contributions-sync.ts — `bun run
 * reference-data:contributions:sync`.
 *
 * Issue #750 (epic #738 platform-evolution, Wave 3, ADR-0021 §5). CLI
 * wrapper for `syncReferenceDataContributions`
 * (`src/modules/reference-data/application/contribution-sync.ts`) —
 * reads the trusted code registry (`listModules()`) and upserts every
 * module's declared `referenceData.contributesValueSets` into
 * `awcms_mini_reference_value_sets`/`awcms_mini_reference_codes`
 * (GLOBAL tables). Never invoked automatically by another module's code
 * — an explicit operational step, same convention `bun run modules:sync`
 * establishes for the module registry itself. Idempotent: an unchanged
 * descriptor re-synced produces no functional change.
 *
 * Deliberately a plain script (not migrated onto the shared job-runner
 * framework `scripts/modules-sync.ts` uses) — this sync touches at most a
 * handful of module-declared value sets/codes (bounded, no tenant loop,
 * no external I/O), the same "no natural mid-run checkpoint" shape
 * `modules-sync.ts`'s own header comment documents for its own job, but
 * without that job's live HTTP-endpoint dual-caller requiring the shared
 * lock/telemetry machinery — a future issue can migrate this onto the
 * runner if a second caller (e.g. a live API endpoint) needs it.
 */
import { getDatabaseClient } from "../src/lib/database/client";
import { logScriptFailure } from "../src/lib/logging/error-log";
import { listModules } from "../src/modules";
import {
  ReferenceDataContributionRegistryInvalidError,
  syncReferenceDataContributions
} from "../src/modules/reference-data/application/contribution-sync";

async function main(): Promise<void> {
  const sql = getDatabaseClient();

  try {
    const result = await sql.begin(async (tx) => {
      return syncReferenceDataContributions(tx, listModules());
    });

    console.log(
      `reference-data:contributions:sync OK — value sets created=${result.valueSetsCreated.length}, updated=${result.valueSetsUpdated.length}; codes created=${result.codesCreated}, updated=${result.codesUpdated}.`
    );
    if (result.conflicts.length > 0) {
      console.warn(
        "reference-data:contributions:sync — conflicts skipped (never overwritten):"
      );
      for (const conflict of result.conflicts) {
        console.warn(`  ${conflict}`);
      }
    }
  } catch (error) {
    if (error instanceof ReferenceDataContributionRegistryInvalidError) {
      logScriptFailure(
        "reference-data:contributions:sync FAILED — invalid registry",
        error
      );
      return;
    }
    throw error;
  } finally {
    await sql.end();
  }
}

if (import.meta.main) {
  main();
}
