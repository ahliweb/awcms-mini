/**
 * Location-to-unit relationship persistence + audit (Issue #749, epic
 * #738 platform-evolution Wave 2, ADR-0016). `operationalLocationId`/
 * `organizationUnitId` are re-validated as belonging to THIS tenant at
 * write time — cross-tenant references are rejected here, not just by
 * RLS (same convention `organization-unit-directory.ts`'s legal-entity/
 * unit-type checks establish).
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  validateCreateLocationUnitRelationshipInput,
  type CreateLocationUnitRelationshipInput,
  type LocationUnitRelationshipValidationError
} from "../domain/location-unit-relationship";

const MODULE_KEY = "organization_structure";

export type LocationUnitRelationshipRow = {
  id: string;
  tenantId: string;
  operationalLocationId: string;
  organizationUnitId: string;
  relationshipType: "primary" | "secondary";
  effectiveFrom: Date;
  effectiveTo: Date | null;
  createdAt: Date;
};

type LocationUnitRelationshipDbRow = {
  id: string;
  tenant_id: string;
  operational_location_id: string;
  organization_unit_id: string;
  relationship_type: "primary" | "secondary";
  effective_from: Date;
  effective_to: Date | null;
  created_at: Date;
};

function toRow(
  row: LocationUnitRelationshipDbRow
): LocationUnitRelationshipRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    operationalLocationId: row.operational_location_id,
    organizationUnitId: row.organization_unit_id,
    relationshipType: row.relationship_type,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    createdAt: row.created_at
  };
}

export type CreateLocationUnitRelationshipResult =
  | { ok: true; relationship: LocationUnitRelationshipRow }
  | {
      ok: false;
      reason: "validation";
      errors: LocationUnitRelationshipValidationError[];
    }
  | { ok: false; reason: "location_invalid" }
  | { ok: false; reason: "unit_invalid" }
  | { ok: false; reason: "already_related" };

export async function createLocationUnitRelationship(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateLocationUnitRelationshipInput,
  correlationId?: string
): Promise<CreateLocationUnitRelationshipResult> {
  const errors = validateCreateLocationUnitRelationshipInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const locationRows = (await tx`
    SELECT id FROM awcms_mini_operational_locations
    WHERE tenant_id = ${tenantId} AND id = ${input.operationalLocationId} AND deleted_at IS NULL
  `) as { id: string }[];
  if (!locationRows[0]) {
    return { ok: false, reason: "location_invalid" };
  }

  const unitRows = (await tx`
    SELECT id FROM awcms_mini_organization_units
    WHERE tenant_id = ${tenantId} AND id = ${input.organizationUnitId} AND deleted_at IS NULL
  `) as { id: string }[];
  if (!unitRows[0]) {
    return { ok: false, reason: "unit_invalid" };
  }

  const existingRows = (await tx`
    SELECT id FROM awcms_mini_location_unit_relationships
    WHERE tenant_id = ${tenantId} AND operational_location_id = ${input.operationalLocationId}
      AND organization_unit_id = ${input.organizationUnitId} AND effective_to IS NULL
  `) as { id: string }[];
  if (existingRows[0]) {
    return { ok: false, reason: "already_related" };
  }

  const rows = (await tx`
    INSERT INTO awcms_mini_location_unit_relationships
      (tenant_id, operational_location_id, organization_unit_id, relationship_type,
       effective_from, effective_to, created_by)
    VALUES (
      ${tenantId}, ${input.operationalLocationId}, ${input.organizationUnitId},
      ${input.relationshipType}, ${input.effectiveFrom}, ${input.effectiveTo}, ${actorTenantUserId}
    )
    RETURNING id, tenant_id, operational_location_id, organization_unit_id, relationship_type,
      effective_from, effective_to, created_at
  `) as LocationUnitRelationshipDbRow[];

  const relationship = toRow(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "create",
    resourceType: "location_unit_relationship",
    resourceId: relationship.id,
    severity: "info",
    message: "Location-to-unit relationship created.",
    attributes: {
      operationalLocationId: relationship.operationalLocationId,
      organizationUnitId: relationship.organizationUnitId
    },
    correlationId
  });

  return { ok: true, relationship };
}

export type EndLocationUnitRelationshipResult =
  | { ok: true; relationship: LocationUnitRelationshipRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "already_ended" };

export async function endLocationUnitRelationship(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  relationshipId: string,
  correlationId?: string
): Promise<EndLocationUnitRelationshipResult> {
  const existingRows = (await tx`
    SELECT id, effective_to FROM awcms_mini_location_unit_relationships
    WHERE tenant_id = ${tenantId} AND id = ${relationshipId}
  `) as { id: string; effective_to: Date | null }[];

  const existing = existingRows[0];
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.effective_to !== null) {
    return { ok: false, reason: "already_ended" };
  }

  const rows = (await tx`
    UPDATE awcms_mini_location_unit_relationships
    SET effective_to = now(), ended_at = now(), ended_by = ${actorTenantUserId}
    WHERE tenant_id = ${tenantId} AND id = ${relationshipId} AND effective_to IS NULL
    RETURNING id, tenant_id, operational_location_id, organization_unit_id, relationship_type,
      effective_from, effective_to, created_at
  `) as LocationUnitRelationshipDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "already_ended" };
  }

  const relationship = toRow(rows[0]);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "revoke",
    resourceType: "location_unit_relationship",
    resourceId: relationship.id,
    severity: "warning",
    message: "Location-to-unit relationship ended.",
    attributes: {},
    correlationId
  });

  return { ok: true, relationship };
}

export type ListLocationUnitRelationshipsFilter = {
  operationalLocationId?: string;
  organizationUnitId?: string;
  asOf?: Date;
};

export async function listLocationUnitRelationships(
  tx: Bun.SQL,
  tenantId: string,
  filter: ListLocationUnitRelationshipsFilter = {}
): Promise<LocationUnitRelationshipRow[]> {
  const asOf = filter.asOf ?? null;

  const rows = (await tx`
    SELECT id, tenant_id, operational_location_id, organization_unit_id, relationship_type,
      effective_from, effective_to, created_at
    FROM awcms_mini_location_unit_relationships
    WHERE tenant_id = ${tenantId}
      AND (${filter.operationalLocationId ?? null}::uuid IS NULL OR operational_location_id = ${filter.operationalLocationId ?? null})
      AND (${filter.organizationUnitId ?? null}::uuid IS NULL OR organization_unit_id = ${filter.organizationUnitId ?? null})
      AND (
        (${asOf}::timestamptz IS NULL AND effective_to IS NULL)
        OR (
          ${asOf}::timestamptz IS NOT NULL
          AND effective_from <= ${asOf}
          AND (effective_to IS NULL OR effective_to > ${asOf})
        )
      )
    ORDER BY created_at DESC
    LIMIT 200
  `) as LocationUnitRelationshipDbRow[];

  return rows.map(toRow);
}
