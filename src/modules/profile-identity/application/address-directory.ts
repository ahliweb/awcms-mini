import { recordAuditEvent } from "../../logging/application/audit-log";
import type { CreateAddressInput } from "../domain/address-channel-validation";

const AUDIT_MODULE_KEY = "profile_identity";
const AUDIT_RESOURCE_TYPE = "profile_address";

export type AddressView = {
  id: string;
  profileId: string;
  addressType: string;
  addressLine: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  countryCode: string;
  isDefault: boolean;
  validFrom: string;
  validUntil: string | null;
  createdAt: string;
  updatedAt: string;
};

type AddressRow = {
  id: string;
  profile_id: string;
  address_type: string;
  address_line: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  country_code: string;
  is_default: boolean;
  valid_from: Date;
  valid_until: Date | null;
  created_at: Date;
  updated_at: Date;
};

function toView(row: AddressRow): AddressView {
  return {
    id: row.id,
    profileId: row.profile_id,
    addressType: row.address_type,
    addressLine: row.address_line,
    city: row.city,
    province: row.province,
    postalCode: row.postal_code,
    countryCode: row.country_code,
    isDefault: row.is_default,
    validFrom: row.valid_from.toISOString(),
    validUntil: row.valid_until ? row.valid_until.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

export async function createAddress(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  profileId: string,
  input: CreateAddressInput,
  correlationId?: string
): Promise<AddressView> {
  const rows = (await tx`
    INSERT INTO awcms_mini_profile_addresses
      (tenant_id, profile_id, address_type, address_line, city, province, postal_code,
       country_code, is_default, valid_from, valid_until)
    VALUES (
      ${tenantId}, ${profileId}, ${input.addressType}, ${input.addressLine}, ${input.city},
      ${input.province}, ${input.postalCode}, ${input.countryCode}, ${input.isDefault},
      ${input.validFrom}, ${input.validUntil}
    )
    RETURNING id, profile_id, address_type, address_line, city, province, postal_code,
      country_code, is_default, valid_from, valid_until, created_at, updated_at
  `) as AddressRow[];

  const view = toView(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "address_added",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: view.id,
    severity: "info",
    message: "Address added.",
    attributes: { addressType: view.addressType },
    correlationId
  });

  return view;
}

export async function listAddresses(
  tx: Bun.SQL,
  tenantId: string,
  profileId: string
): Promise<AddressView[]> {
  const rows = (await tx`
    SELECT id, profile_id, address_type, address_line, city, province, postal_code,
      country_code, is_default, valid_from, valid_until, created_at, updated_at
    FROM awcms_mini_profile_addresses
    WHERE tenant_id = ${tenantId} AND profile_id = ${profileId} AND deleted_at IS NULL
    ORDER BY created_at DESC
  `) as AddressRow[];

  return rows.map(toView);
}

export async function softDeleteAddress(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  profileId: string,
  addressId: string,
  reason: string,
  correlationId?: string
): Promise<boolean> {
  const rows = await tx`
    UPDATE awcms_mini_profile_addresses
    SET deleted_at = now(), deleted_by = ${actorTenantUserId}, delete_reason = ${reason}
    WHERE tenant_id = ${tenantId} AND profile_id = ${profileId} AND id = ${addressId}
      AND deleted_at IS NULL
    RETURNING id
  `;

  if (rows.length === 0) {
    return false;
  }

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "address_removed",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: addressId,
    severity: "info",
    message: "Address soft-deleted.",
    attributes: { reason },
    correlationId
  });

  return true;
}
