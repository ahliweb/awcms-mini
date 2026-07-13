/**
 * Concrete `LegalHoldGuardPort` implementation (Issue #745, security-auditor
 * finding on PR #773). See `_shared/ports/legal-hold-guard-port.ts` for the
 * full rationale — this file exists so `logging`/`visitor_analytics`/
 * `form_drafts`' own purge functions can enforce an active legal hold
 * without importing `data_lifecycle`'s `application`/`domain` code directly
 * (which would create a forbidden circular cross-module import, Issue
 * #685/ADR-0011).
 *
 * A composition root (a script, an API route, or an integration test) is
 * the only thing that should ever import this file — never another
 * module's own `application`/`domain` code.
 */
import type { LegalHoldGuardPort } from "../../_shared/ports/legal-hold-guard-port";
import { fetchActiveLegalHoldsForPlanning } from "./legal-hold-service";
import { evaluateLegalHoldForDescriptor } from "../domain/legal-hold";

export const legalHoldGuardPortAdapter: LegalHoldGuardPort = {
  async isDescriptorHeld(tx, tenantId, descriptorKey) {
    const activeHolds = await fetchActiveLegalHoldsForPlanning(tx, tenantId);
    return evaluateLegalHoldForDescriptor(activeHolds, descriptorKey).held;
  }
};
