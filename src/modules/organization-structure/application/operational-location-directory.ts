/**
 * Operational-location persistence + audit (Issue #749, epic #738
 * platform-evolution Wave 2, ADR-0016).
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  validateCreateOperationalLocationInput,
  validateUpdateOperationalLocationInput,
  type CreateOperationalLocationInput,
  type OperationalLocationValidationError,
  type UpdateOperationalLocationInput
} from "../domain/operational-location";

const MODULE_KEY = "organization_structure";

export type OperationalLocationRow = {
  id: string;
  tenantId: string;
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  countryCode: string | null;
  latitude: number | null;
  longitude: number | null;
  status: "active" | "inactive";
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

type OperationalLocationDbRow = {
  id: string;
  tenant_id: string;
  name: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country_code: string | null;
  latitude: string | null;
  longitude: string | null;
  status: "active" | "inactive";
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

function toRow(row: OperationalLocationDbRow): OperationalLocationRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    region: row.region,
    postalCode: row.postal_code,
    countryCode: row.country_code,
    latitude: row.latitude !== null ? Number(row.latitude) : null,
    longitude: row.longitude !== null ? Number(row.longitude) : null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  };
}

export type CreateOperationalLocationResult =
  | { ok: true; location: OperationalLocationRow }
  | {
      ok: false;
      reason: "validation";
      errors: OperationalLocationValidationError[];
    };

export async function createOperationalLocation(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateOperationalLocationInput,
  correlationId?: string
): Promise<CreateOperationalLocationResult> {
  const errors = validateCreateOperationalLocationInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const rows = (await tx`
    INSERT INTO awcms_mini_operational_locations
      (tenant_id, name, address_line1, address_line2, city, region, postal_code,
       country_code, latitude, longitude, created_by, updated_by)
    VALUES (
      ${tenantId}, ${input.name}, ${input.addressLine1}, ${input.addressLine2}, ${input.city},
      ${input.region}, ${input.postalCode}, ${input.countryCode}, ${input.latitude},
      ${input.longitude}, ${actorTenantUserId}, ${actorTenantUserId}
    )
    RETURNING id, tenant_id, name, address_line1, address_line2, city, region, postal_code,
      country_code, latitude, longitude, status, created_at, updated_at, deleted_at
  `) as OperationalLocationDbRow[];

  const location = toRow(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "create",
    resourceType: "operational_location",
    resourceId: location.id,
    severity: "info",
    message: `Operational location "${location.name}" created.`,
    attributes: {},
    correlationId
  });

  return { ok: true, location };
}

export type UpdateOperationalLocationResult =
  | { ok: true; location: OperationalLocationRow }
  | {
      ok: false;
      reason: "validation";
      errors: OperationalLocationValidationError[];
    }
  | { ok: false; reason: "not_found" };

export async function updateOperationalLocation(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  locationId: string,
  input: UpdateOperationalLocationInput,
  correlationId?: string
): Promise<UpdateOperationalLocationResult> {
  const errors = validateUpdateOperationalLocationInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const rows = (await tx`
    UPDATE awcms_mini_operational_locations
    SET name = ${input.name}, address_line1 = ${input.addressLine1},
        address_line2 = ${input.addressLine2}, city = ${input.city}, region = ${input.region},
        postal_code = ${input.postalCode}, country_code = ${input.countryCode},
        latitude = ${input.latitude}, longitude = ${input.longitude},
        updated_by = ${actorTenantUserId}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${locationId} AND deleted_at IS NULL
    RETURNING id, tenant_id, name, address_line1, address_line2, city, region, postal_code,
      country_code, latitude, longitude, status, created_at, updated_at, deleted_at
  `) as OperationalLocationDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "not_found" };
  }

  const location = toRow(rows[0]);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "update",
    resourceType: "operational_location",
    resourceId: location.id,
    severity: "info",
    message: `Operational location "${location.name}" updated.`,
    attributes: {},
    correlationId
  });

  return { ok: true, location };
}

export type DeleteOperationalLocationResult =
  | { ok: true; location: OperationalLocationRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "already_deleted" };

export async function deleteOperationalLocation(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  locationId: string,
  deleteReason: string | null,
  correlationId?: string
): Promise<DeleteOperationalLocationResult> {
  const existingRows = (await tx`
    SELECT id, deleted_at FROM awcms_mini_operational_locations
    WHERE tenant_id = ${tenantId} AND id = ${locationId}
  `) as { id: string; deleted_at: Date | null }[];

  const existing = existingRows[0];
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.deleted_at !== null) {
    return { ok: false, reason: "already_deleted" };
  }

  const rows = (await tx`
    UPDATE awcms_mini_operational_locations
    SET status = 'inactive', deleted_at = now(), deleted_by = ${actorTenantUserId},
        delete_reason = ${deleteReason}, updated_at = now(), updated_by = ${actorTenantUserId}
    WHERE tenant_id = ${tenantId} AND id = ${locationId} AND deleted_at IS NULL
    RETURNING id, tenant_id, name, address_line1, address_line2, city, region, postal_code,
      country_code, latitude, longitude, status, created_at, updated_at, deleted_at
  `) as OperationalLocationDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "already_deleted" };
  }

  const location = toRow(rows[0]);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "delete",
    resourceType: "operational_location",
    resourceId: location.id,
    severity: "warning",
    message: `Operational location "${location.name}" soft-deleted.`,
    attributes: { deleteReason },
    correlationId
  });

  return { ok: true, location };
}

export type RestoreOperationalLocationResult =
  | { ok: true; location: OperationalLocationRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_deleted" };

export async function restoreOperationalLocation(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  locationId: string,
  correlationId?: string
): Promise<RestoreOperationalLocationResult> {
  const existingRows = (await tx`
    SELECT id, deleted_at FROM awcms_mini_operational_locations
    WHERE tenant_id = ${tenantId} AND id = ${locationId}
  `) as { id: string; deleted_at: Date | null }[];

  const existing = existingRows[0];
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.deleted_at === null) {
    return { ok: false, reason: "not_deleted" };
  }

  const rows = (await tx`
    UPDATE awcms_mini_operational_locations
    SET status = 'active', deleted_at = NULL, deleted_by = NULL, delete_reason = NULL,
        restored_at = now(), restored_by = ${actorTenantUserId}, updated_at = now(),
        updated_by = ${actorTenantUserId}
    WHERE tenant_id = ${tenantId} AND id = ${locationId} AND deleted_at IS NOT NULL
    RETURNING id, tenant_id, name, address_line1, address_line2, city, region, postal_code,
      country_code, latitude, longitude, status, created_at, updated_at, deleted_at
  `) as OperationalLocationDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "not_deleted" };
  }

  const location = toRow(rows[0]);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: MODULE_KEY,
    action: "restore",
    resourceType: "operational_location",
    resourceId: location.id,
    severity: "info",
    message: `Operational location "${location.name}" restored.`,
    attributes: {},
    correlationId
  });

  return { ok: true, location };
}

export async function fetchOperationalLocationById(
  tx: Bun.SQL,
  tenantId: string,
  locationId: string
): Promise<OperationalLocationRow | null> {
  const rows = (await tx`
    SELECT id, tenant_id, name, address_line1, address_line2, city, region, postal_code,
      country_code, latitude, longitude, status, created_at, updated_at, deleted_at
    FROM awcms_mini_operational_locations
    WHERE tenant_id = ${tenantId} AND id = ${locationId}
  `) as OperationalLocationDbRow[];

  return rows[0] ? toRow(rows[0]) : null;
}

/** Bounded list (`LIMIT 200`), newest first. `includeDeleted` is `true` only from the admin SSR page's own direct call (`admin/organization-structure/locations.astro`, so the restore action has something to target) — the public `GET .../locations` API route never sets this. */
export async function listOperationalLocations(
  tx: Bun.SQL,
  tenantId: string,
  includeDeleted = false
): Promise<OperationalLocationRow[]> {
  const rows = (await tx`
    SELECT id, tenant_id, name, address_line1, address_line2, city, region, postal_code,
      country_code, latitude, longitude, status, created_at, updated_at, deleted_at
    FROM awcms_mini_operational_locations
    WHERE tenant_id = ${tenantId}
      AND (${includeDeleted} OR deleted_at IS NULL)
    ORDER BY created_at DESC
    LIMIT 200
  `) as OperationalLocationDbRow[];

  return rows.map(toRow);
}
