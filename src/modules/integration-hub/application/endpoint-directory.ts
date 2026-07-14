import { randomBytes } from "node:crypto";
import { listInboundIntegrationAdapters } from "../infrastructure/adapter-registry";
import { assertValidSecretReferenceNaming } from "../domain/secret-reference-validation";

export { InvalidSecretReferenceError } from "../domain/secret-reference-validation";

/**
 * Inbound webhook endpoint CRUD (Issue #754). `endpoint_token` is an
 * opaque, server-generated, unguessable identifier (never client/tenant
 * chosen) — the URL path segment a provider POSTs to
 * (`/api/v1/integration-hub/inbound/{endpointToken}`). It is NOT itself
 * the security boundary (that is the per-endpoint HMAC secret, resolved
 * from `secret_reference`) — knowing an endpoint's token alone never lets
 * a caller forge a valid, verified delivery.
 *
 * Same "DB snake_case row -> public camelCase DTO" split
 * `organization-structure/application/legal-entity-directory.ts` already
 * established (`LegalEntityDbRow` -> `LegalEntityRow`) — every function
 * here returns `IntegrationEndpointDto` (camelCase, matches the OpenAPI
 * contract), never the raw DB row shape.
 */

export const DEFAULT_KEY_ROTATION_OVERLAP_HOURS = 24;

export class UnknownInboundAdapterError extends Error {
  constructor(adapterKey: string) {
    super(
      `"${adapterKey}" is not a registered inbound adapter — see infrastructure/adapter-registry.ts.`
    );
    this.name = "UnknownInboundAdapterError";
  }
}

type IntegrationEndpointDbRow = {
  id: string;
  tenant_id: string;
  adapter_key: string;
  endpoint_token: string;
  display_name: string;
  description: string | null;
  secret_reference: string;
  secret_reference_previous: string | null;
  secret_rotated_at: Date | null;
  previous_secret_expires_at: Date | null;
  status: string;
  max_body_bytes: number;
  allowed_content_types: string[];
  timestamp_tolerance_seconds: number;
  created_at: Date;
  updated_at: Date;
};

export type IntegrationEndpointDto = {
  id: string;
  tenantId: string;
  adapterKey: string;
  endpointToken: string;
  displayName: string;
  description: string | null;
  secretReference: string;
  hasSecretRotationInProgress: boolean;
  secretRotatedAt: Date | null;
  previousSecretExpiresAt: Date | null;
  status: string;
  maxBodyBytes: number;
  allowedContentTypes: string[];
  timestampToleranceSeconds: number;
  createdAt: Date;
  updatedAt: Date;
};

function toDto(row: IntegrationEndpointDbRow): IntegrationEndpointDto {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    adapterKey: row.adapter_key,
    endpointToken: row.endpoint_token,
    displayName: row.display_name,
    description: row.description,
    // `secret_reference` is a pointer (`env:VAR_NAME`), never the secret
    // VALUE itself — safe to return, same convention `token_reference`
    // (social_publishing) already establishes for API responses.
    secretReference: row.secret_reference,
    hasSecretRotationInProgress: row.secret_reference_previous !== null,
    secretRotatedAt: row.secret_rotated_at,
    previousSecretExpiresAt: row.previous_secret_expires_at,
    status: row.status,
    maxBodyBytes: row.max_body_bytes,
    allowedContentTypes: row.allowed_content_types,
    timestampToleranceSeconds: row.timestamp_tolerance_seconds,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function generateEndpointToken(): string {
  return randomBytes(32).toString("base64url");
}

function assertKnownInboundAdapter(adapterKey: string): void {
  if (
    !listInboundIntegrationAdapters().some(
      (adapter) => adapter.adapterKey === adapterKey
    )
  ) {
    throw new UnknownInboundAdapterError(adapterKey);
  }
}

export type CreateEndpointInput = {
  adapterKey: string;
  displayName: string;
  description?: string | null;
  secretReference: string;
  maxBodyBytes?: number;
  allowedContentTypes?: string[];
  timestampToleranceSeconds?: number;
  actorTenantUserId?: string | null;
};

export async function createIntegrationEndpoint(
  tx: Bun.SQL,
  tenantId: string,
  input: CreateEndpointInput
): Promise<IntegrationEndpointDto> {
  assertKnownInboundAdapter(input.adapterKey);
  assertValidSecretReferenceNaming(input.secretReference);

  const rows = (await tx`
    INSERT INTO awcms_mini_integration_endpoints
      (tenant_id, adapter_key, endpoint_token, display_name, description,
       secret_reference, max_body_bytes, allowed_content_types,
       timestamp_tolerance_seconds, created_by, updated_by)
    VALUES (
      ${tenantId}, ${input.adapterKey}, ${generateEndpointToken()}, ${input.displayName},
      ${input.description ?? null}, ${input.secretReference},
      ${input.maxBodyBytes ?? 65536}, ${tx.array(input.allowedContentTypes ?? ["application/json"], "text")},
      ${input.timestampToleranceSeconds ?? 300}, ${input.actorTenantUserId ?? null},
      ${input.actorTenantUserId ?? null}
    )
    RETURNING *
  `) as IntegrationEndpointDbRow[];

  return toDto(rows[0]!);
}

export async function listIntegrationEndpoints(
  tx: Bun.SQL,
  tenantId: string
): Promise<IntegrationEndpointDto[]> {
  const rows = (await tx`
    SELECT * FROM awcms_mini_integration_endpoints
    WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
    ORDER BY created_at DESC
  `) as IntegrationEndpointDbRow[];

  return rows.map(toDto);
}

export async function getIntegrationEndpoint(
  tx: Bun.SQL,
  tenantId: string,
  id: string
): Promise<IntegrationEndpointDto | null> {
  const rows = (await tx`
    SELECT * FROM awcms_mini_integration_endpoints
    WHERE tenant_id = ${tenantId} AND id = ${id} AND deleted_at IS NULL
  `) as IntegrationEndpointDbRow[];

  return rows[0] ? toDto(rows[0]) : null;
}

export async function rotateIntegrationEndpointSecret(
  tx: Bun.SQL,
  tenantId: string,
  id: string,
  newSecretReference: string,
  actorTenantUserId: string | null,
  overlapHours: number = DEFAULT_KEY_ROTATION_OVERLAP_HOURS
): Promise<IntegrationEndpointDto | null> {
  assertValidSecretReferenceNaming(newSecretReference);

  const currentRows = (await tx`
    SELECT * FROM awcms_mini_integration_endpoints
    WHERE tenant_id = ${tenantId} AND id = ${id} AND deleted_at IS NULL
  `) as IntegrationEndpointDbRow[];
  const current = currentRows[0];

  if (!current) {
    return null;
  }

  const previousSecretExpiresAt = new Date(
    Date.now() + overlapHours * 60 * 60 * 1000
  );

  const rows = (await tx`
    UPDATE awcms_mini_integration_endpoints
    SET secret_reference = ${newSecretReference},
        secret_reference_previous = ${current.secret_reference},
        secret_rotated_at = now(),
        previous_secret_expires_at = ${previousSecretExpiresAt},
        updated_at = now(), updated_by = ${actorTenantUserId}
    WHERE tenant_id = ${tenantId} AND id = ${id} AND deleted_at IS NULL
    RETURNING *
  `) as IntegrationEndpointDbRow[];

  return rows[0] ? toDto(rows[0]) : null;
}

export async function setIntegrationEndpointStatus(
  tx: Bun.SQL,
  tenantId: string,
  id: string,
  status: "active" | "paused" | "disabled",
  actorTenantUserId: string | null
): Promise<IntegrationEndpointDto | null> {
  const rows = (await tx`
    UPDATE awcms_mini_integration_endpoints
    SET status = ${status}, updated_at = now(), updated_by = ${actorTenantUserId}
    WHERE tenant_id = ${tenantId} AND id = ${id} AND deleted_at IS NULL
    RETURNING *
  `) as IntegrationEndpointDbRow[];

  return rows[0] ? toDto(rows[0]) : null;
}

export async function softDeleteIntegrationEndpoint(
  tx: Bun.SQL,
  tenantId: string,
  id: string,
  reason: string,
  actorTenantUserId: string | null
): Promise<boolean> {
  const rows = (await tx`
    UPDATE awcms_mini_integration_endpoints
    SET deleted_at = now(), deleted_by = ${actorTenantUserId}, delete_reason = ${reason},
        status = 'disabled', updated_at = now(), updated_by = ${actorTenantUserId}
    WHERE tenant_id = ${tenantId} AND id = ${id} AND deleted_at IS NULL
    RETURNING id
  `) as { id: string }[];

  return rows.length > 0;
}
