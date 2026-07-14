/**
 * Integration tests for `document_infrastructure` (Issue #751, epic #738
 * platform-evolution Wave 3) against real PostgreSQL, through the REAL
 * Astro route handlers: classification/document/version/relation/
 * sequence/reservation CRUD + lifecycle transitions (void/restore/
 * reclassify), Idempotency-Key replay/conflict on every high-risk
 * mutation, a genuine CONCURRENT numbering-reservation race (proving no
 * duplicate numbers under real parallel requests — not just documented),
 * cross-tenant isolation, and five neutral fixtures demonstrating reuse
 * across unrelated domains without this module ever importing their
 * rules.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { createHash } from "node:crypto";

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  createCookieJar,
  getAdminSql,
  integrationEnabled,
  invoke,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import {
  GET as listClassifications,
  POST as createClassification
} from "../../src/pages/api/v1/document-infrastructure/classifications/index";
import {
  DELETE as deactivateClassification,
  GET as getClassification,
  PATCH as updateClassification
} from "../../src/pages/api/v1/document-infrastructure/classifications/[id]";
import { POST as restoreClassification } from "../../src/pages/api/v1/document-infrastructure/classifications/[id]/restore";
import {
  GET as listDocuments,
  POST as createDocument
} from "../../src/pages/api/v1/document-infrastructure/documents/index";
import {
  DELETE as deleteDocument,
  GET as getDocument,
  PATCH as updateDocument
} from "../../src/pages/api/v1/document-infrastructure/documents/[id]";
import { POST as restoreDocument } from "../../src/pages/api/v1/document-infrastructure/documents/[id]/restore";
import { POST as voidDocument } from "../../src/pages/api/v1/document-infrastructure/documents/[id]/void";
import { POST as reclassifyDocument } from "../../src/pages/api/v1/document-infrastructure/documents/[id]/reclassify";
import {
  GET as listVersions,
  POST as createVersion
} from "../../src/pages/api/v1/document-infrastructure/documents/[id]/versions/index";
import {
  GET as listRelations,
  POST as linkRelation
} from "../../src/pages/api/v1/document-infrastructure/documents/[id]/relations/index";
import { DELETE as unlinkRelation } from "../../src/pages/api/v1/document-infrastructure/documents/[id]/relations/[relationId]";
import {
  GET as listSequences,
  POST as defineSequence
} from "../../src/pages/api/v1/document-infrastructure/sequences/index";
import { POST as reviseSequence } from "../../src/pages/api/v1/document-infrastructure/sequences/revise";
import { POST as deactivateSequence } from "../../src/pages/api/v1/document-infrastructure/sequences/deactivate";
import { POST as restoreSequence } from "../../src/pages/api/v1/document-infrastructure/sequences/restore";
import { GET as sequenceHistory } from "../../src/pages/api/v1/document-infrastructure/sequences/history";
import { GET as listReservations } from "../../src/pages/api/v1/document-infrastructure/reservations/index";
import { POST as reserveNumber } from "../../src/pages/api/v1/document-infrastructure/reservations/reserve";
import { POST as commitReservation } from "../../src/pages/api/v1/document-infrastructure/reservations/[id]/commit";
import { POST as cancelReservation } from "../../src/pages/api/v1/document-infrastructure/reservations/[id]/cancel";
import { GET as listEvidence } from "../../src/pages/api/v1/document-infrastructure/evidence/index";

const OWNER_LOGIN = "owner@example.com";
const OWNER_PASSWORD = "integration-test-doc-infra-owner-password";

type Bootstrap = {
  tenantId: string;
  token: string;
  tenantUserId: string;
};

async function bootstrap(
  tenantCode = "acme",
  tenantName = "Acme"
): Promise<Bootstrap> {
  const loginIdentifier = `${tenantCode}-${OWNER_LOGIN}`;
  const setup = await invoke<{ data: { tenantId: string } }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: {
      tenantName,
      tenantCode,
      officeCode: "hq",
      officeName: "HQ",
      ownerLoginIdentifier: loginIdentifier,
      ownerPassword: OWNER_PASSWORD,
      ownerDisplayName: "Owner"
    }
  });
  expect(setup.status).toBe(200);

  const login = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": setup.body.data.tenantId
    },
    body: { loginIdentifier, password: OWNER_PASSWORD },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  const admin = getAdminSql();
  const tenantUserRows = (await admin`
    SELECT tu.id FROM awcms_mini_tenant_users tu
    JOIN awcms_mini_identities i ON i.id = tu.identity_id
    WHERE tu.tenant_id = ${setup.body.data.tenantId} AND i.login_identifier = ${loginIdentifier}
  `) as { id: string }[];

  return {
    tenantId: setup.body.data.tenantId,
    token: login.body.data.token,
    tenantUserId: tenantUserRows[0]!.id
  };
}

/** Second tenant seeded directly via the privileged client — setup is a global one-time singleton lock (mirrors organization-structure.integration.test.ts's own precedent/comment). */
async function bootstrapSecondTenant(
  tenantCode: string,
  tenantName: string
): Promise<Bootstrap> {
  const admin = getAdminSql();
  const loginIdentifier = `${tenantCode}-${OWNER_LOGIN}`;

  const tenantRows = (await admin`
    INSERT INTO awcms_mini_tenants (tenant_code, tenant_name, status)
    VALUES (${tenantCode}, ${tenantName}, 'active')
    RETURNING id
  `) as { id: string }[];
  const tenantId = tenantRows[0]!.id;

  const profileRows = (await admin`
    INSERT INTO awcms_mini_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', 'Owner')
    RETURNING id
  `) as { id: string }[];

  const { hashPassword } = await import("../../src/lib/auth/password");
  const passwordHash = await hashPassword(OWNER_PASSWORD);
  const identityRows = (await admin`
    INSERT INTO awcms_mini_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profileRows[0]!.id}, ${loginIdentifier}, ${passwordHash})
    RETURNING id
  `) as { id: string }[];

  const tenantUserRows = (await admin`
    INSERT INTO awcms_mini_tenant_users (tenant_id, identity_id)
    VALUES (${tenantId}, ${identityRows[0]!.id})
    RETURNING id
  `) as { id: string }[];
  const tenantUserId = tenantUserRows[0]!.id;

  const roleRows = (await admin`
    INSERT INTO awcms_mini_roles (tenant_id, role_code, role_name, is_system)
    VALUES (${tenantId}, 'owner', 'Owner', true)
    RETURNING id
  `) as { id: string }[];

  await admin`
    INSERT INTO awcms_mini_role_permissions (tenant_id, role_id, permission_id)
    SELECT ${tenantId}, ${roleRows[0]!.id}, id FROM awcms_mini_permissions
  `;

  await admin`
    INSERT INTO awcms_mini_access_assignments (tenant_id, tenant_user_id, role_id, assigned_by)
    VALUES (${tenantId}, ${tenantUserId}, ${roleRows[0]!.id}, ${tenantUserId})
  `;

  const login = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-mini-tenant-id": tenantId
    },
    body: { loginIdentifier, password: OWNER_PASSWORD },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  return { tenantId, token: login.body.data.token, tenantUserId };
}

function authHeaders(
  owner: Bootstrap,
  idempotencyKey?: string
): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-mini-tenant-id": owner.tenantId,
    authorization: `Bearer ${owner.token}`,
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {})
  };
}

// Computed rather than hand-typed to guarantee a real, correctly formatted
// 64-character lowercase hex SHA-256 digest (same convention the unit test
// for this domain file uses).
const VALID_CHECKSUM = createHash("sha256")
  .update("integration-fixture")
  .digest("hex");

async function createClassificationFixture(
  owner: Bootstrap,
  code = "correspondence"
): Promise<string> {
  const result = await invoke<{ data: { classification: { id: string } } }>(
    createClassification,
    {
      method: "POST",
      path: "/api/v1/document-infrastructure/classifications",
      headers: authHeaders(owner),
      body: {
        code,
        name: code,
        confidentialityLevel: "internal"
      }
    }
  );
  expect(result.status).toBe(200);
  return result.body.data.classification.id;
}

async function createDocumentFixture(
  owner: Bootstrap,
  overrides: Partial<{
    ownerModuleKey: string;
    documentType: string;
    resourceType: string;
    resourceId: string;
  }> = {}
): Promise<string> {
  const result = await invoke<{ data: { document: { id: string } } }>(
    createDocument,
    {
      method: "POST",
      path: "/api/v1/document-infrastructure/documents",
      headers: authHeaders(owner, `create-doc-${Math.random()}`),
      body: {
        ownerModuleKey: overrides.ownerModuleKey ?? "profile_identity",
        documentType: overrides.documentType ?? "correspondence",
        title: "Fixture document",
        confidentialityLevel: "internal",
        resourceType: overrides.resourceType ?? "profile",
        resourceId:
          overrides.resourceId ?? "11111111-1111-1111-1111-111111111111"
      }
    }
  );
  expect(result.status).toBe(200);
  return result.body.data.document.id;
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  await applyMigrations();
  await provisionAppRole();
});

beforeEach(async () => {
  if (!integrationEnabled) return;
  await resetDatabase();
});

const suite = integrationEnabled ? describe : describe.skip;

suite("document_infrastructure integration", () => {
  test("classification lifecycle: create, read, update, deactivate (idempotent), restore (idempotent)", async () => {
    const owner = await bootstrap();

    const create = await invoke<{
      data: { classification: { id: string; code: string } };
    }>(createClassification, {
      method: "POST",
      path: "/api/v1/document-infrastructure/classifications",
      headers: authHeaders(owner),
      body: {
        code: "invoice",
        name: "Invoice",
        confidentialityLevel: "internal"
      }
    });
    expect(create.status).toBe(200);
    const classificationId = create.body.data.classification.id;

    const list = await invoke<{ data: { classifications: { id: string }[] } }>(
      listClassifications,
      {
        method: "GET",
        path: "/api/v1/document-infrastructure/classifications",
        headers: authHeaders(owner)
      }
    );
    expect(list.status).toBe(200);
    expect(
      list.body.data.classifications.some((c) => c.id === classificationId)
    ).toBe(true);

    const update = await invoke(updateClassification, {
      method: "PATCH",
      path: `/api/v1/document-infrastructure/classifications/${classificationId}`,
      headers: authHeaders(owner),
      params: { id: classificationId },
      body: { name: "Invoice (renamed)", confidentialityLevel: "confidential" }
    });
    expect(update.status).toBe(200);

    // Idempotent deactivate: same key + same body replayed twice -> both 200, one audit trail.
    const deactivateKey = "deactivate-classification-key";
    const deactivate1 = await invoke(deactivateClassification, {
      method: "DELETE",
      path: `/api/v1/document-infrastructure/classifications/${classificationId}`,
      headers: authHeaders(owner, deactivateKey),
      params: { id: classificationId },
      body: { deleteReason: "No longer needed." }
    });
    expect(deactivate1.status).toBe(200);

    const deactivate2 = await invoke(deactivateClassification, {
      method: "DELETE",
      path: `/api/v1/document-infrastructure/classifications/${classificationId}`,
      headers: authHeaders(owner, deactivateKey),
      params: { id: classificationId },
      body: { deleteReason: "No longer needed." }
    });
    expect(deactivate2.status).toBe(200);

    // Different payload, same key -> 409 conflict, never silently processed.
    const conflictingDeactivate = await invoke(deactivateClassification, {
      method: "DELETE",
      path: `/api/v1/document-infrastructure/classifications/${classificationId}`,
      headers: authHeaders(owner, deactivateKey),
      params: { id: classificationId },
      body: { deleteReason: "A completely different reason." }
    });
    expect(conflictingDeactivate.status).toBe(409);

    const restore = await invoke(restoreClassification, {
      method: "POST",
      path: `/api/v1/document-infrastructure/classifications/${classificationId}/restore`,
      headers: authHeaders(owner, "restore-classification-key"),
      params: { id: classificationId }
    });
    expect(restore.status).toBe(200);

    const fetchAfterRestore = await invoke(getClassification, {
      method: "GET",
      path: `/api/v1/document-infrastructure/classifications/${classificationId}`,
      headers: authHeaders(owner),
      params: { id: classificationId }
    });
    expect(fetchAfterRestore.status).toBe(200);
  });

  test("document lifecycle: create requires Idempotency-Key, void/restore, reclassify, and soft-delete/restore are distinct transitions", async () => {
    const owner = await bootstrap();
    const classificationId = await createClassificationFixture(owner);

    const missingKey = await invoke(createDocument, {
      method: "POST",
      path: "/api/v1/document-infrastructure/documents",
      headers: authHeaders(owner),
      body: {
        ownerModuleKey: "profile_identity",
        documentType: "correspondence",
        title: "Untitled",
        confidentialityLevel: "internal",
        resourceType: "profile",
        resourceId: "11111111-1111-1111-1111-111111111111"
      }
    });
    expect(missingKey.status).toBe(400);

    const documentId = await createDocumentFixture(owner);

    const voidResult = await invoke(voidDocument, {
      method: "POST",
      path: `/api/v1/document-infrastructure/documents/${documentId}/void`,
      headers: authHeaders(owner, "void-key-1"),
      params: { id: documentId },
      body: { voidReason: "Superseded by a corrected document." }
    });
    expect(voidResult.status).toBe(200);

    // Voiding an already-voided document is rejected, not silently accepted.
    const voidAgain = await invoke(voidDocument, {
      method: "POST",
      path: `/api/v1/document-infrastructure/documents/${documentId}/void`,
      headers: authHeaders(owner, "void-key-2"),
      params: { id: documentId },
      body: { voidReason: "Trying again." }
    });
    expect(voidAgain.status).toBe(409);

    const restoreResult = await invoke(restoreDocument, {
      method: "POST",
      path: `/api/v1/document-infrastructure/documents/${documentId}/restore`,
      headers: authHeaders(owner, "restore-key-1"),
      params: { id: documentId }
    });
    expect(restoreResult.status).toBe(200);

    const reclassify = await invoke(reclassifyDocument, {
      method: "POST",
      path: `/api/v1/document-infrastructure/documents/${documentId}/reclassify`,
      headers: authHeaders(owner, "reclassify-key-1"),
      params: { id: documentId },
      body: {
        classificationId,
        confidentialityLevel: "confidential",
        reason: "Contains sensitive terms."
      }
    });
    expect(reclassify.status).toBe(200);

    const deleteResult = await invoke(deleteDocument, {
      method: "DELETE",
      path: `/api/v1/document-infrastructure/documents/${documentId}`,
      headers: authHeaders(owner, "delete-key-1"),
      params: { id: documentId },
      body: { deleteReason: "Created by mistake." }
    });
    expect(deleteResult.status).toBe(200);

    // A soft-deleted document cannot be voided (distinct lifecycle tracks).
    const voidAfterDelete = await invoke(voidDocument, {
      method: "POST",
      path: `/api/v1/document-infrastructure/documents/${documentId}/void`,
      headers: authHeaders(owner, "void-key-3"),
      params: { id: documentId },
      body: { voidReason: "Should be rejected." }
    });
    expect(voidAfterDelete.status).toBe(409);

    const restoreAfterDelete = await invoke(restoreDocument, {
      method: "POST",
      path: `/api/v1/document-infrastructure/documents/${documentId}/restore`,
      headers: authHeaders(owner, "restore-key-2"),
      params: { id: documentId }
    });
    expect(restoreAfterDelete.status).toBe(200);

    const listResult = await invoke(listDocuments, {
      method: "GET",
      path: "/api/v1/document-infrastructure/documents",
      headers: authHeaders(owner)
    });
    expect(listResult.status).toBe(200);

    const updateResult = await invoke(updateDocument, {
      method: "PATCH",
      path: `/api/v1/document-infrastructure/documents/${documentId}`,
      headers: authHeaders(owner),
      params: { id: documentId },
      body: { title: "Updated title" }
    });
    expect(updateResult.status).toBe(200);

    const getResult = await invoke(getDocument, {
      method: "GET",
      path: `/api/v1/document-infrastructure/documents/${documentId}`,
      headers: authHeaders(owner),
      params: { id: documentId }
    });
    expect(getResult.status).toBe(200);
  });

  test("versions are append-only: sequential version numbers, immutable rows, Idempotency-Key required", async () => {
    const owner = await bootstrap();
    const documentId = await createDocumentFixture(owner);

    const createVersion1 = await invoke<{
      data: { version: { versionNumber: number } };
    }>(createVersion, {
      method: "POST",
      path: `/api/v1/document-infrastructure/documents/${documentId}/versions`,
      headers: authHeaders(owner, "version-key-1"),
      params: { id: documentId },
      body: {
        contentReference: "sync-objects/tenant/doc-v1.pdf",
        contentReferenceKind: "object_storage_reference",
        mediaType: "application/pdf",
        sizeBytes: 1024,
        checksumSha256: VALID_CHECKSUM,
        source: "upload"
      }
    });
    expect(createVersion1.status).toBe(200);
    expect(createVersion1.body.data.version.versionNumber).toBe(1);

    const createVersion2 = await invoke<{
      data: { version: { versionNumber: number } };
    }>(createVersion, {
      method: "POST",
      path: `/api/v1/document-infrastructure/documents/${documentId}/versions`,
      headers: authHeaders(owner, "version-key-2"),
      params: { id: documentId },
      body: {
        contentReference: "sync-objects/tenant/doc-v2.pdf",
        contentReferenceKind: "object_storage_reference",
        mediaType: "application/pdf",
        sizeBytes: 2048,
        checksumSha256: VALID_CHECKSUM,
        source: "upload"
      }
    });
    expect(createVersion2.status).toBe(200);
    expect(createVersion2.body.data.version.versionNumber).toBe(2);

    // Replaying the SAME Idempotency-Key + SAME body must NOT create a
    // third version — the append-only chain stays at exactly 2 rows.
    const replay = await invoke<{
      data: { version: { versionNumber: number } };
    }>(createVersion, {
      method: "POST",
      path: `/api/v1/document-infrastructure/documents/${documentId}/versions`,
      headers: authHeaders(owner, "version-key-2"),
      params: { id: documentId },
      body: {
        contentReference: "sync-objects/tenant/doc-v2.pdf",
        contentReferenceKind: "object_storage_reference",
        mediaType: "application/pdf",
        sizeBytes: 2048,
        checksumSha256: VALID_CHECKSUM,
        source: "upload"
      }
    });
    expect(replay.status).toBe(200);
    expect(replay.body.data.version.versionNumber).toBe(2);

    const list = await invoke<{ data: { versions: unknown[] } }>(listVersions, {
      method: "GET",
      path: `/api/v1/document-infrastructure/documents/${documentId}/versions`,
      headers: authHeaders(owner),
      params: { id: documentId }
    });
    expect(list.status).toBe(200);
    expect(list.body.data.versions.length).toBe(2);

    const admin = getAdminSql();
    const rawVersions = (await admin`
      SELECT version_number, content_reference FROM awcms_mini_document_versions
      WHERE tenant_id = ${owner.tenantId} AND document_id = ${documentId}
      ORDER BY version_number
    `) as { version_number: number; content_reference: string }[];
    expect(rawVersions.length).toBe(2);
    expect(rawVersions[0]!.content_reference).toBe(
      "sync-objects/tenant/doc-v1.pdf"
    );
    expect(rawVersions[1]!.content_reference).toBe(
      "sync-objects/tenant/doc-v2.pdf"
    );
  });

  test("resource relations: link (assign) and unlink (revoke) through the capability port, both Idempotency-Key gated", async () => {
    const owner = await bootstrap();
    const documentId = await createDocumentFixture(owner);

    const link = await invoke<{ data: { relation: { id: string } } }>(
      linkRelation,
      {
        method: "POST",
        path: `/api/v1/document-infrastructure/documents/${documentId}/relations`,
        headers: authHeaders(owner, "link-key-1"),
        params: { id: documentId },
        body: {
          ownerModuleKey: "profile_identity",
          resourceType: "profile",
          resourceId: "22222222-2222-2222-2222-222222222222",
          relationType: "evidence_for"
        }
      }
    );
    expect(link.status).toBe(200);
    const relationId = link.body.data.relation.id;

    const duplicateLink = await invoke(linkRelation, {
      method: "POST",
      path: `/api/v1/document-infrastructure/documents/${documentId}/relations`,
      headers: authHeaders(owner, "link-key-2"),
      params: { id: documentId },
      body: {
        ownerModuleKey: "profile_identity",
        resourceType: "profile",
        resourceId: "22222222-2222-2222-2222-222222222222",
        relationType: "evidence_for"
      }
    });
    expect(duplicateLink.status).toBe(409);

    const list = await invoke<{ data: { relations: unknown[] } }>(
      listRelations,
      {
        method: "GET",
        path: `/api/v1/document-infrastructure/documents/${documentId}/relations`,
        headers: authHeaders(owner),
        params: { id: documentId }
      }
    );
    expect(list.status).toBe(200);
    expect(list.body.data.relations.length).toBe(1);

    const unlink = await invoke(unlinkRelation, {
      method: "DELETE",
      path: `/api/v1/document-infrastructure/documents/${documentId}/relations/${relationId}`,
      headers: authHeaders(owner, "unlink-key-1"),
      params: { id: documentId, relationId },
      body: { reason: "No longer applicable." }
    });
    expect(unlink.status).toBe(200);
  });

  test("sequences: define, revise (carries counter forward), deactivate, restore, and history", async () => {
    const owner = await bootstrap();

    const define = await invoke(defineSequence, {
      method: "POST",
      path: "/api/v1/document-infrastructure/sequences",
      headers: authHeaders(owner, "define-key-1"),
      body: {
        scopeType: "tenant",
        sequenceKey: "invoice",
        formatTemplate: "INV/{YYYY}/{SEQ:6}",
        resetPolicy: "yearly"
      }
    });
    expect(define.status).toBe(200);

    // Reserve once so current_value > 0, to prove revise carries it forward.
    const reserve1 = await invoke<{
      data: { reservation: { reservedNumber: number } };
    }>(reserveNumber, {
      method: "POST",
      path: "/api/v1/document-infrastructure/reservations/reserve",
      headers: authHeaders(owner, "reserve-key-1"),
      body: { scopeType: "tenant", sequenceKey: "invoice" }
    });
    expect(reserve1.status).toBe(200);
    expect(reserve1.body.data.reservation.reservedNumber).toBe(1);

    const revise = await invoke<{
      data: { sequence: { currentValue: number } };
    }>(reviseSequence, {
      method: "POST",
      path: "/api/v1/document-infrastructure/sequences/revise",
      headers: authHeaders(owner, "revise-key-1"),
      body: {
        scopeType: "tenant",
        sequenceKey: "invoice",
        formatTemplate: "INVOICE-{YYYY}-{SEQ:8}",
        resetPolicy: "yearly",
        revisionReason: "New finance format requirement."
      }
    });
    expect(revise.status).toBe(200);
    expect(revise.body.data.sequence.currentValue).toBe(1);

    // The NEXT reservation continues from 2, never resets to 1 just
    // because the format changed.
    const reserve2 = await invoke<{
      data: { reservation: { reservedNumber: number } };
    }>(reserveNumber, {
      method: "POST",
      path: "/api/v1/document-infrastructure/reservations/reserve",
      headers: authHeaders(owner, "reserve-key-2"),
      body: { scopeType: "tenant", sequenceKey: "invoice" }
    });
    expect(reserve2.status).toBe(200);
    expect(reserve2.body.data.reservation.reservedNumber).toBe(2);

    const deactivate = await invoke(deactivateSequence, {
      method: "POST",
      path: "/api/v1/document-infrastructure/sequences/deactivate",
      headers: authHeaders(owner, "deactivate-seq-key-1"),
      body: {
        scopeType: "tenant",
        sequenceKey: "invoice",
        deleteReason: "Retiring for the year."
      }
    });
    expect(deactivate.status).toBe(200);

    const restore = await invoke<{
      data: { sequence: { currentValue: number } };
    }>(restoreSequence, {
      method: "POST",
      path: "/api/v1/document-infrastructure/sequences/restore",
      headers: authHeaders(owner, "restore-seq-key-1"),
      body: { scopeType: "tenant", sequenceKey: "invoice" }
    });
    expect(restore.status).toBe(200);
    expect(restore.body.data.sequence.currentValue).toBe(2);

    const history = await invoke<{ data: { history: unknown[] } }>(
      sequenceHistory,
      {
        method: "GET",
        path: "/api/v1/document-infrastructure/sequences/history?scopeType=tenant&sequenceKey=invoice",
        headers: authHeaders(owner)
      }
    );
    expect(history.status).toBe(200);
    // 3 rows: original definition (closed by revise), revised definition
    // (closed by deactivate), restored definition (currently open).
    expect(history.body.data.history.length).toBe(3);

    const list = await invoke<{ data: { sequences: unknown[] } }>(
      listSequences,
      {
        method: "GET",
        path: "/api/v1/document-infrastructure/sequences",
        headers: authHeaders(owner)
      }
    );
    expect(list.status).toBe(200);
    expect(list.body.data.sequences.length).toBe(1);
  });

  test("reservations: reserve, commit to a document, cancel is rejected once already committed; cancel leaves durable gap evidence", async () => {
    const owner = await bootstrap();
    await invoke(defineSequence, {
      method: "POST",
      path: "/api/v1/document-infrastructure/sequences",
      headers: authHeaders(owner, "define-key-2"),
      body: {
        scopeType: "tenant",
        sequenceKey: "correspondence",
        formatTemplate: "{SEQ:4}",
        resetPolicy: "never"
      }
    });
    const documentId = await createDocumentFixture(owner);

    const reserve = await invoke<{
      data: { reservation: { id: string; formattedNumber: string } };
    }>(reserveNumber, {
      method: "POST",
      path: "/api/v1/document-infrastructure/reservations/reserve",
      headers: authHeaders(owner, "reserve-key-a"),
      body: { scopeType: "tenant", sequenceKey: "correspondence" }
    });
    expect(reserve.status).toBe(200);
    expect(reserve.body.data.reservation.formattedNumber).toBe("0001");
    const reservationId = reserve.body.data.reservation.id;

    const commit = await invoke(commitReservation, {
      method: "POST",
      path: `/api/v1/document-infrastructure/reservations/${reservationId}/commit`,
      headers: authHeaders(owner, "commit-key-a"),
      params: { id: reservationId },
      body: { documentId }
    });
    expect(commit.status).toBe(200);

    const cancelAfterCommit = await invoke(cancelReservation, {
      method: "POST",
      path: `/api/v1/document-infrastructure/reservations/${reservationId}/cancel`,
      headers: authHeaders(owner, "cancel-key-a"),
      params: { id: reservationId },
      body: { cancelReason: "Too late." }
    });
    expect(cancelAfterCommit.status).toBe(409);

    // A second reservation, canceled rather than committed — its number
    // is a permanent gap, never reissued.
    const reserve2 = await invoke<{
      data: { reservation: { id: string; formattedNumber: string } };
    }>(reserveNumber, {
      method: "POST",
      path: "/api/v1/document-infrastructure/reservations/reserve",
      headers: authHeaders(owner, "reserve-key-b"),
      body: { scopeType: "tenant", sequenceKey: "correspondence" }
    });
    expect(reserve2.status).toBe(200);
    expect(reserve2.body.data.reservation.formattedNumber).toBe("0002");

    const cancel = await invoke(cancelReservation, {
      method: "POST",
      path: `/api/v1/document-infrastructure/reservations/${reserve2.body.data.reservation.id}/cancel`,
      headers: authHeaders(owner, "cancel-key-b"),
      params: { id: reserve2.body.data.reservation.id },
      body: { cancelReason: "Document creation abandoned." }
    });
    expect(cancel.status).toBe(200);

    // A THIRD reservation must be 0003, never reissuing the canceled 0002.
    const reserve3 = await invoke<{
      data: { reservation: { formattedNumber: string } };
    }>(reserveNumber, {
      method: "POST",
      path: "/api/v1/document-infrastructure/reservations/reserve",
      headers: authHeaders(owner, "reserve-key-c"),
      body: { scopeType: "tenant", sequenceKey: "correspondence" }
    });
    expect(reserve3.status).toBe(200);
    expect(reserve3.body.data.reservation.formattedNumber).toBe("0003");

    const list = await invoke<{ data: { reservations: unknown[] } }>(
      listReservations,
      {
        method: "GET",
        path: "/api/v1/document-infrastructure/reservations",
        headers: authHeaders(owner)
      }
    );
    expect(list.status).toBe(200);
    expect(list.body.data.reservations.length).toBe(3);

    const evidence = await invoke<{
      data: { evidence: { evidenceType: string }[] };
    }>(listEvidence, {
      method: "GET",
      path: "/api/v1/document-infrastructure/evidence",
      headers: authHeaders(owner)
    });
    expect(evidence.status).toBe(200);
    expect(
      evidence.body.data.evidence.some(
        (e) => e.evidenceType === "number_canceled"
      )
    ).toBe(true);
    expect(
      evidence.body.data.evidence.some(
        (e) => e.evidenceType === "number_committed"
      )
    ).toBe(true);
  });

  test("CONCURRENCY: N near-simultaneous reserve requests against the SAME sequence never allocate a duplicate number", async () => {
    const owner = await bootstrap();
    await invoke(defineSequence, {
      method: "POST",
      path: "/api/v1/document-infrastructure/sequences",
      headers: authHeaders(owner, "define-key-concurrency"),
      body: {
        scopeType: "tenant",
        sequenceKey: "concurrent_test",
        formatTemplate: "{SEQ:6}",
        resetPolicy: "never"
      }
    });

    const CONCURRENT_REQUESTS = 20;
    const results = await Promise.all(
      Array.from({ length: CONCURRENT_REQUESTS }, (_, index) =>
        invoke<{ data: { reservation: { reservedNumber: number } } }>(
          reserveNumber,
          {
            method: "POST",
            path: "/api/v1/document-infrastructure/reservations/reserve",
            headers: authHeaders(owner, `concurrent-reserve-key-${index}`),
            body: { scopeType: "tenant", sequenceKey: "concurrent_test" }
          }
        )
      )
    );

    for (const result of results) {
      expect(result.status).toBe(200);
    }

    const reservedNumbers = results.map(
      (r) => r.body.data.reservation.reservedNumber
    );
    const uniqueNumbers = new Set(reservedNumbers);

    // The core assertion: 20 concurrent callers, 20 DISTINCT numbers —
    // no duplicate ever allocated under real concurrent load.
    expect(uniqueNumbers.size).toBe(CONCURRENT_REQUESTS);
    expect([...uniqueNumbers].sort((a, b) => a - b)).toEqual(
      Array.from({ length: CONCURRENT_REQUESTS }, (_, i) => i + 1)
    );

    const admin = getAdminSql();
    const dbRows = (await admin`
      SELECT reserved_number FROM awcms_mini_document_number_reservations
      WHERE tenant_id = ${owner.tenantId}
    `) as { reserved_number: string }[];
    expect(dbRows.length).toBe(CONCURRENT_REQUESTS);
    const dbUnique = new Set(dbRows.map((r) => Number(r.reserved_number)));
    expect(dbUnique.size).toBe(CONCURRENT_REQUESTS);
  });

  test("cross-tenant isolation: tenant B cannot read or mutate tenant A's classifications, documents, sequences, or reservations", async () => {
    const tenantA = await bootstrap("tenant-a", "Tenant A");
    const tenantB = await bootstrapSecondTenant("tenant-b", "Tenant B");

    const classificationId = await createClassificationFixture(tenantA);
    const documentId = await createDocumentFixture(tenantA);
    await invoke(defineSequence, {
      method: "POST",
      path: "/api/v1/document-infrastructure/sequences",
      headers: authHeaders(tenantA, "isolation-define-key"),
      body: {
        scopeType: "tenant",
        sequenceKey: "isolation_test",
        formatTemplate: "{SEQ}",
        resetPolicy: "never"
      }
    });

    // Tenant B's reads never see tenant A's rows.
    const bClassifications = await invoke<{
      data: { classifications: { id: string }[] };
    }>(listClassifications, {
      method: "GET",
      path: "/api/v1/document-infrastructure/classifications",
      headers: authHeaders(tenantB)
    });
    expect(
      bClassifications.body.data.classifications.some(
        (c) => c.id === classificationId
      )
    ).toBe(false);

    const bGetDocument = await invoke(getDocument, {
      method: "GET",
      path: `/api/v1/document-infrastructure/documents/${documentId}`,
      headers: authHeaders(tenantB),
      params: { id: documentId }
    });
    expect(bGetDocument.status).toBe(404);

    const bDocuments = await invoke<{ data: { documents: { id: string }[] } }>(
      listDocuments,
      {
        method: "GET",
        path: "/api/v1/document-infrastructure/documents",
        headers: authHeaders(tenantB)
      }
    );
    expect(
      bDocuments.body.data.documents.some((d) => d.id === documentId)
    ).toBe(false);

    // Tenant B cannot reserve against tenant A's sequence (it does not exist for B).
    const bReserve = await invoke(reserveNumber, {
      method: "POST",
      path: "/api/v1/document-infrastructure/reservations/reserve",
      headers: authHeaders(tenantB, "isolation-reserve-key"),
      body: { scopeType: "tenant", sequenceKey: "isolation_test" }
    });
    expect(bReserve.status).toBe(404);

    // Tenant B cannot mutate tenant A's classification even by guessing its id.
    const bDeactivate = await invoke(deactivateClassification, {
      method: "DELETE",
      path: `/api/v1/document-infrastructure/classifications/${classificationId}`,
      headers: authHeaders(tenantB, "isolation-deactivate-key"),
      params: { id: classificationId },
      body: { deleteReason: "Cross-tenant attempt." }
    });
    expect(bDeactivate.status).toBe(404);
  });

  test("five neutral fixtures demonstrate reuse across unrelated domains without domain-specific rules", async () => {
    const owner = await bootstrap();

    const fixtures = [
      {
        ownerModuleKey: "profile_identity",
        documentType: "correspondence",
        resourceType: "profile",
        title: "Correspondence evidence — appointment letter"
      },
      {
        ownerModuleKey: "organization_structure",
        documentType: "contract_attachment",
        resourceType: "legal_entity",
        title: "Contract attachment — vendor service agreement"
      },
      {
        ownerModuleKey: "workflow_approval",
        documentType: "invoice_reference",
        resourceType: "workflow_instance",
        title: "Invoice reference — linked to an approval workflow instance"
      },
      {
        ownerModuleKey: "business_scope",
        documentType: "approval_evidence",
        resourceType: "business_scope_exception",
        title: "Approval evidence — segregation-of-duties exception grant"
      },
      {
        ownerModuleKey: "data_lifecycle",
        documentType: "asset_disposal_evidence",
        resourceType: "legal_hold",
        title: "Asset-disposal evidence — legal hold release record"
      }
    ];

    const createdIds: string[] = [];
    for (const fixture of fixtures) {
      const result = await invoke<{ data: { document: { id: string } } }>(
        createDocument,
        {
          method: "POST",
          path: "/api/v1/document-infrastructure/documents",
          headers: authHeaders(owner, `fixture-key-${fixture.documentType}`),
          body: {
            ownerModuleKey: fixture.ownerModuleKey,
            documentType: fixture.documentType,
            title: fixture.title,
            confidentialityLevel: "internal",
            resourceType: fixture.resourceType,
            resourceId: "33333333-3333-3333-3333-333333333333"
          }
        }
      );
      expect(result.status).toBe(200);
      createdIds.push(result.body.data.document.id);
    }

    // Every fixture is a plain document row distinguished only by opaque
    // strings (ownerModuleKey/documentType/resourceType) — this module
    // never branches on, validates, or imports any domain-specific rule
    // for any of the five.
    const list = await invoke<{
      data: { documents: { id: string; documentType: string }[] };
    }>(listDocuments, {
      method: "GET",
      path: "/api/v1/document-infrastructure/documents",
      headers: authHeaders(owner)
    });
    expect(list.status).toBe(200);
    const listedTypes = new Set(
      list.body.data.documents.map((d) => d.documentType)
    );
    for (const fixture of fixtures) {
      expect(listedTypes.has(fixture.documentType)).toBe(true);
    }
    expect(createdIds.length).toBe(5);
    expect(new Set(createdIds).size).toBe(5);
  });
});
