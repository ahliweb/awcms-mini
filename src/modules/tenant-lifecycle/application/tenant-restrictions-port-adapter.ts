/**
 * `tenant_restrictions` capability adapter (Issue #873, epic #868, ADR-0022
 * §2/§4). `tenant_lifecycle` PROVIDES this read-only, fail-closed restriction
 * snapshot; a consumer wires it at ITS composition root inside its own
 * `withTenant(sql, tenantId, ...)` transaction WITHOUT importing this module's
 * application/domain (module-boundary). It delegates to the SAME neutral-ground
 * reader the auth chokepoint uses, so the port and the enforcing surface can
 * never disagree.
 */
import { readTenantRestrictionSnapshot } from "../../_shared/tenant-lifecycle-restriction-read";
import type {
  TenantRestrictionSnapshot,
  TenantRestrictionsPort
} from "../../_shared/ports/tenant-lifecycle-port";

export function createTenantRestrictionsPort(
  tx: Bun.SQL,
  tenantId: string,
  nowProvider: () => Date = () => new Date()
): TenantRestrictionsPort {
  return {
    async resolve(): Promise<TenantRestrictionSnapshot> {
      const snapshot = await readTenantRestrictionSnapshot(
        tx,
        tenantId,
        nowProvider()
      );
      return {
        tenantId: snapshot.tenantId,
        governing: snapshot.governing,
        state: snapshot.state,
        version: snapshot.version,
        profile: snapshot.profile,
        resolvedAt: snapshot.resolvedAt
      };
    }
  };
}
