import { defineModule } from "../_shared/module-contract";

export const documentInfrastructureModule = defineModule({
  key: "document_infrastructure",
  name: "Document Infrastructure",
  version: "0.1.0",
  status: "active",
  description:
    "Optional, tenant-scoped generic document METADATA infrastructure (Issue #751, epic `platform-evolution` #738 Wave 3, ADR-0017 admission decision). Admitted as an Official Optional Business Foundation module — opt-in per tenant, generic across every derived application, never a domain document schema (no letters/invoices/POs/journal batches/medical records/contracts here). Adds a document classification catalog (`awcms_mini_document_classifications`), the document registry itself (`awcms_mini_documents`, stable id + owner module + document type + classification + status + a PRIMARY generic resource reference), IMMUTABLE append-only versions (`awcms_mini_document_versions`, content referenced through an approved managed-object storage contract — never a binary blob column), additional typed generic resource relations (`awcms_mini_document_resource_relations`, written ONLY through the capability port, never a direct cross-module table write), concurrency-safe effective-dated numbering sequence definitions (`awcms_mini_document_number_sequences`, SCD Type 2 style — revising the format never resets or reuses the counter), atomic number reservations (`awcms_mini_document_number_reservations`, reserve/commit/cancel, `UNIQUE (sequence_id, reserved_number)` makes silent reuse structurally impossible), and an append-only evidence trail (`awcms_mini_document_evidence`). Provides `document_resource_relations` as a capability other modules IMPORT AND CALL DIRECTLY (in-process function, ADR-0011 pattern) to attach a document to one of THEIR OWN resources — this module never reads/writes another module's tables (ADR-0013 §6 no-shared-table-write).",
  dependencies: ["tenant_admin", "identity_access", "domain_event_runtime"],
  type: "domain",
  // This module PROVIDES the generic document<->resource attachment
  // capability — it does NOT declare any `consumes` entry (deliberately
  // no hard capability/lifecycle edge to `data_lifecycle`/
  // `workflow_approval`/`sync_storage` in this PR, see ADR-0017 §4/§10).
  capabilities: {
    provides: ["document_resource_relations"]
  },
  events: {
    asyncApiPath: "asyncapi/awcms-mini-domain-events.asyncapi.yaml",
    publishes: [
      "awcms-mini.document-infrastructure.document.created",
      "awcms-mini.document-infrastructure.document.voided",
      "awcms-mini.document-infrastructure.document.restored",
      "awcms-mini.document-infrastructure.document.reclassified",
      "awcms-mini.document-infrastructure.version.created",
      "awcms-mini.document-infrastructure.number.reserved",
      "awcms-mini.document-infrastructure.number.committed",
      "awcms-mini.document-infrastructure.number.canceled"
    ]
  },
  navigation: [
    {
      labelKey: "admin.layout.nav_document_infrastructure_documents",
      path: "/admin/document-infrastructure/documents",
      order: 110,
      requiredPermission: "document_infrastructure.documents.read"
    },
    {
      labelKey: "admin.layout.nav_document_infrastructure_classifications",
      path: "/admin/document-infrastructure/classifications",
      order: 111,
      requiredPermission: "document_infrastructure.classifications.read"
    },
    {
      labelKey: "admin.layout.nav_document_infrastructure_sequences",
      path: "/admin/document-infrastructure/sequences",
      order: 112,
      requiredPermission: "document_infrastructure.sequences.read"
    }
  ],
  permissions: [
    {
      activityCode: "classifications",
      action: "read",
      description: "Read document classifications for the caller's tenant"
    },
    {
      activityCode: "classifications",
      action: "create",
      description: "Create a document classification"
    },
    {
      activityCode: "classifications",
      action: "update",
      description: "Update a document classification's neutral metadata"
    },
    {
      activityCode: "classifications",
      action: "delete",
      description: "Deactivate (soft-delete) a document classification"
    },
    {
      activityCode: "classifications",
      action: "restore",
      description: "Restore a previously deactivated document classification"
    },
    {
      activityCode: "documents",
      action: "read",
      description: "Read/list/search documents"
    },
    {
      activityCode: "documents",
      action: "create",
      description: "Create a document registry entry"
    },
    {
      activityCode: "documents",
      action: "update",
      description: "Update a document's neutral metadata (title/summary/dates)"
    },
    {
      activityCode: "documents",
      action: "delete",
      description: "Soft-delete a mistakenly created document registry entry"
    },
    {
      activityCode: "documents",
      action: "restore",
      description:
        "Restore a soft-deleted document, or un-void a voided document"
    },
    {
      activityCode: "documents",
      action: "void",
      description:
        "Void a document (irreversible-by-default business-state transition, kept visible as evidence)"
    },
    {
      activityCode: "documents",
      action: "reclassify",
      description:
        "Change a document's classification and/or confidentiality level"
    },
    {
      activityCode: "documents_confidential",
      action: "read",
      description:
        "Read documents classified confidential (additive to the base documents.read permission, not implied by it)"
    },
    {
      activityCode: "documents_restricted",
      action: "read",
      description:
        "Read documents classified restricted (additive to the base documents.read permission, not implied by it)"
    },
    {
      activityCode: "versions",
      action: "read",
      description: "Read/list document versions"
    },
    {
      activityCode: "versions",
      action: "create",
      description: "Create a new (append-only) document version"
    },
    {
      activityCode: "relations",
      action: "read",
      description: "Read document-to-resource relations"
    },
    {
      activityCode: "relations",
      action: "assign",
      description: "Link a document to a module-owned resource"
    },
    {
      activityCode: "relations",
      action: "revoke",
      description: "Unlink a document from a module-owned resource"
    },
    {
      activityCode: "sequences",
      action: "read",
      description: "Read number sequence definitions and history"
    },
    {
      activityCode: "sequences",
      action: "create",
      description: "Define a new number sequence"
    },
    {
      activityCode: "sequences",
      action: "update",
      description:
        "Revise a number sequence's format/reset policy (effective-dated, counter carried forward)"
    },
    {
      activityCode: "sequences",
      action: "delete",
      description: "Deactivate a number sequence"
    },
    {
      activityCode: "sequences",
      action: "restore",
      description: "Reactivate a deactivated number sequence"
    },
    {
      activityCode: "reservations",
      action: "read",
      description: "Read number reservations"
    },
    {
      activityCode: "reservations",
      action: "reserve",
      description: "Reserve the next number from a sequence"
    },
    {
      activityCode: "reservations",
      action: "commit",
      description: "Commit a reserved number to a document"
    },
    {
      activityCode: "reservations",
      action: "cancel",
      description:
        "Cancel a reserved (not yet committed) number, recorded as gap evidence"
    },
    {
      activityCode: "evidence",
      action: "read",
      description: "Read the document/numbering evidence trail"
    }
  ],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/document-infrastructure"
  }
});
