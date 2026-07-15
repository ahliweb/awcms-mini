/**
 * `ReferenceDataPort` real adapter (Issue #750, epic #738
 * platform-evolution Wave 3, ADR-0021 §5). Thin wrapper around
 * `reference-resolution-query.ts` — the actual merge logic lives there
 * (shared with the tenant-codes API route) and in `domain/resolution.ts`
 * (pure precedence). No module in this PR wires this adapter as a
 * `capabilities.consumes` entry yet (extension seam, ADR-0021 §5) — a
 * future consumer's OWN composition root imports this file directly.
 */
import type {
  ReferenceDataPort,
  ReferenceValueSetSnapshot,
  ResolvedReferenceCode
} from "../../_shared/ports/reference-data-port";
import { fetchReferenceValueSetByKey } from "./value-set-directory";
import {
  resolveReferenceCodeForTenant,
  resolveReferenceValueSetForTenant
} from "./reference-resolution-query";

function toPortShape(entry: {
  code: string;
  isTenantOverride: boolean;
  label: string;
  description: string | null;
  sortOrder: number;
  metadata: Record<string, unknown>;
  validFrom: Date;
  validTo: Date | null;
  deprecated: boolean;
}): ResolvedReferenceCode {
  return { ...entry };
}

export const referenceDataPortAdapter: ReferenceDataPort = {
  async resolveCode(tx, tenantId, valueSetKey, code, options) {
    const valueSet = await fetchReferenceValueSetByKey(tx, valueSetKey);
    if (!valueSet || valueSet.status !== "active") {
      return null;
    }

    const resolved = await resolveReferenceCodeForTenant(
      tx,
      tenantId,
      valueSet.id,
      code,
      options
    );
    return resolved ? toPortShape(resolved) : null;
  },

  async getSnapshot(tx, tenantId, valueSetKey, options) {
    const valueSet = await fetchReferenceValueSetByKey(tx, valueSetKey);
    if (!valueSet) {
      return null;
    }

    const codes = await resolveReferenceValueSetForTenant(
      tx,
      tenantId,
      valueSet.id,
      options
    );

    const snapshot: ReferenceValueSetSnapshot = {
      key: valueSet.key,
      name: valueSet.name,
      status: valueSet.status,
      overridePolicy: valueSet.overridePolicy,
      codes: codes.map(toPortShape)
    };
    return snapshot;
  }
};
