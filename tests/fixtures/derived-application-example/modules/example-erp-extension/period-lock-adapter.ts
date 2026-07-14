/**
 * Fixture-only `PeriodLockPort` (`_shared/ports/period-lock-port.ts`)
 * reference adapter (Issue #755, ADR-0020). Purely in-memory — no
 * database, no network — a real ERP extension backs this with its own
 * fiscal-calendar table. Exists solely to prove the port's fail-closed
 * contract is actually implementable and exercisable by
 * `posting-engine.ts`/`tests/unit/erp-extension-contracts.test.ts`.
 */
import type {
  PeriodLockCheckResult,
  PeriodLockOperation,
  PeriodLockPort
} from "../../../../../src/modules/_shared/ports/period-lock-port";
import type { BusinessScopeReference } from "../../../../../src/modules/_shared/ports/business-scope-hierarchy-port";

/**
 * A minimal fixture adapter: `periodKey`s in `lockedPeriodKeys` are
 * closed for `"post"` (a `"reverse"` operation is still permitted against
 * a locked period, matching the port's own doc comment that a reversal
 * is a distinct operation an ERP extension MAY choose to treat
 * differently — this fixture demonstrates that choice, it is not itself
 * a base requirement).
 */
export function createFixturePeriodLockAdapter(
  lockedPeriodKeys: ReadonlySet<string>
): PeriodLockPort {
  return {
    async checkPeriodLock(
      _tx: Bun.SQL,
      _tenantId: string,
      _legalEntityScope: BusinessScopeReference | null,
      periodKey: string,
      operation: PeriodLockOperation
    ): Promise<PeriodLockCheckResult> {
      if (operation === "post" && lockedPeriodKeys.has(periodKey)) {
        return {
          checked: true,
          locked: true,
          reason: `period "${periodKey}" is closed for new postings (fixture).`
        };
      }
      return { checked: true, locked: false };
    }
  };
}
