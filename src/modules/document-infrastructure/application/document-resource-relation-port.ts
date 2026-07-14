/**
 * The `document_resource_relations` capability port (Issue #751, ADR-0011
 * pattern, ADR-0017 §4) — the ONLY functions in this module that INSERT/
 * UPDATE `awcms_mini_document_resource_relations`. Any OTHER module in
 * this monolith attaches a document to one of ITS OWN resources by
 * IMPORTING AND CALLING these functions directly (in-process, same
 * pattern `blog_content`/`news_portal` already established for their own
 * capability) — never by writing to this table itself (ADR-0013 §6
 * no-shared-table-write, enforced structurally by `tests/unit/module-
 * boundary-cycles.test.ts`: any module reaching into `document-
 * infrastructure/application|domain` is fine — that IS this port — but
 * this module never reaches INTO another module's `application`/`domain`
 * tree back, so no cycle is created).
 *
 * `ownerModuleKey`/`resourceType`/`resourceId` are OPAQUE strings from
 * this module's point of view — the CALLING module is responsible for
 * only ever passing an id it has already confirmed belongs to its own
 * tenant-scoped data (this module structurally cannot validate a foreign
 * table it does not own).
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  validateLinkDocumentToResourceInput,
  type LinkDocumentToResourceInput
} from "../domain/document-resource-relation";
import type { DocumentValidationError } from "../domain/errors";

const MODULE_KEY = "document_infrastructure";

export type DocumentResourceRelationRow = {
  id: string;
  tenantId: string;
  documentId: string;
  ownerModuleKey: string;
  resourceType: string;
  resourceId: string;
  relationType: string;
  createdBy: string | null;
  createdAt: Date;
  deletedAt: Date | null;
};

type DocumentResourceRelationDbRow = {
  id: string;
  tenant_id: string;
  document_id: string;
  owner_module_key: string;
  resource_type: string;
  resource_id: string;
  relation_type: string;
  created_by: string | null;
  created_at: Date;
  deleted_at: Date | null;
};

function toRow(
  row: DocumentResourceRelationDbRow
): DocumentResourceRelationRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    documentId: row.document_id,
    ownerModuleKey: row.owner_module_key,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    relationType: row.relation_type,
    createdBy: row.created_by,
    createdAt: row.created_at,
    deletedAt: row.deleted_at
  };
}

export type LinkDocumentToResourceResult =
  | { ok: true; relation: DocumentResourceRelationRow }
  | { ok: false; reason: "validation"; errors: DocumentValidationError[] }
  | { ok: false; reason: "document_not_found" }
  | { ok: false; reason: "already_linked" };

/**
 * Links `documentId` to a resource owned by the CALLING module. Called
 * either directly by an API route in THIS module, or in-process by
 * another module's own application code (the capability port).
 */
export async function linkDocumentToResource(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string | null,
  documentId: string,
  input: LinkDocumentToResourceInput,
  correlationId?: string
): Promise<LinkDocumentToResourceResult> {
  const errors = validateLinkDocumentToResourceInput(input);
  if (errors.length > 0) {
    return { ok: false, reason: "validation", errors };
  }

  const documentRows = (await tx`
    SELECT id FROM awcms_mini_documents
    WHERE tenant_id = ${tenantId} AND id = ${documentId} AND deleted_at IS NULL
  `) as { id: string }[];
  if (!documentRows[0]) {
    return { ok: false, reason: "document_not_found" };
  }

  const existingRows = (await tx`
    SELECT id FROM awcms_mini_document_resource_relations
    WHERE tenant_id = ${tenantId} AND document_id = ${documentId}
      AND owner_module_key = ${input.ownerModuleKey} AND resource_type = ${input.resourceType}
      AND resource_id = ${input.resourceId} AND relation_type = ${input.relationType}
      AND deleted_at IS NULL
  `) as { id: string }[];
  if (existingRows[0]) {
    return { ok: false, reason: "already_linked" };
  }

  const rows = (await tx`
    INSERT INTO awcms_mini_document_resource_relations
      (tenant_id, document_id, owner_module_key, resource_type, resource_id,
       relation_type, created_by)
    VALUES (
      ${tenantId}, ${documentId}, ${input.ownerModuleKey}, ${input.resourceType},
      ${input.resourceId}, ${input.relationType}, ${actorTenantUserId}
    )
    RETURNING id, tenant_id, document_id, owner_module_key, resource_type,
      resource_id, relation_type, created_by, created_at, deleted_at
  `) as DocumentResourceRelationDbRow[];

  const relation = toRow(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId: actorTenantUserId ?? undefined,
    moduleKey: MODULE_KEY,
    action: "assign",
    resourceType: "document_resource_relation",
    resourceId: relation.id,
    severity: "info",
    message: `Document ${documentId} linked to ${input.ownerModuleKey}:${input.resourceType}:${input.resourceId} (${input.relationType}).`,
    attributes: {
      ownerModuleKey: input.ownerModuleKey,
      resourceType: input.resourceType,
      relationType: input.relationType
    },
    correlationId
  });

  return { ok: true, relation };
}

export type UnlinkDocumentFromResourceResult =
  | { ok: true; relation: DocumentResourceRelationRow }
  | { ok: false; reason: "validation"; errors: DocumentValidationError[] }
  | { ok: false; reason: "not_found" };

export async function unlinkDocumentFromResource(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string | null,
  relationId: string,
  reason: string,
  correlationId?: string
): Promise<UnlinkDocumentFromResourceResult> {
  if (!reason || reason.trim().length === 0) {
    return {
      ok: false,
      reason: "validation",
      errors: [{ field: "reason", message: "reason is required." }]
    };
  }

  const rows = (await tx`
    UPDATE awcms_mini_document_resource_relations
    SET deleted_at = now(), deleted_by = ${actorTenantUserId}, delete_reason = ${reason}
    WHERE tenant_id = ${tenantId} AND id = ${relationId} AND deleted_at IS NULL
    RETURNING id, tenant_id, document_id, owner_module_key, resource_type,
      resource_id, relation_type, created_by, created_at, deleted_at
  `) as DocumentResourceRelationDbRow[];

  if (!rows[0]) {
    return { ok: false, reason: "not_found" };
  }

  const relation = toRow(rows[0]);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId: actorTenantUserId ?? undefined,
    moduleKey: MODULE_KEY,
    action: "revoke",
    resourceType: "document_resource_relation",
    resourceId: relation.id,
    severity: "warning",
    message: `Document ${relation.documentId} unlinked from ${relation.ownerModuleKey}:${relation.resourceType}:${relation.resourceId}.`,
    attributes: { reason },
    correlationId
  });

  return { ok: true, relation };
}

/** Read surface for ANY module (including this one's own admin UI): "which resources is this document linked to?" */
export async function listRelationsForDocument(
  tx: Bun.SQL,
  tenantId: string,
  documentId: string
): Promise<DocumentResourceRelationRow[]> {
  const rows = (await tx`
    SELECT id, tenant_id, document_id, owner_module_key, resource_type,
      resource_id, relation_type, created_by, created_at, deleted_at
    FROM awcms_mini_document_resource_relations
    WHERE tenant_id = ${tenantId} AND document_id = ${documentId} AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 200
  `) as DocumentResourceRelationDbRow[];

  return rows.map(toRow);
}

/**
 * Read surface for ANY OTHER module: "which documents are linked to THIS
 * resource of mine?" — the pull-based half of the capability port,
 * complementing the `*.document.*` domain events (push-based) other
 * modules may also subscribe to.
 */
export async function listRelationsForResource(
  tx: Bun.SQL,
  tenantId: string,
  resourceType: string,
  resourceId: string
): Promise<DocumentResourceRelationRow[]> {
  const rows = (await tx`
    SELECT id, tenant_id, document_id, owner_module_key, resource_type,
      resource_id, relation_type, created_by, created_at, deleted_at
    FROM awcms_mini_document_resource_relations
    WHERE tenant_id = ${tenantId} AND resource_type = ${resourceType}
      AND resource_id = ${resourceId} AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 200
  `) as DocumentResourceRelationDbRow[];

  return rows.map(toRow);
}
