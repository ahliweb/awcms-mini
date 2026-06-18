/**
 * API v1 search router — /api/v1/search (CQRS query side, ADR-023 Tier 1).
 *
 * Endpoint READ-ONLY yang membungkus query service (`src/search/`). Setiap
 * endpoint dijaga ABAC permission dan mengembalikan read DTO (envelope `{ data }`).
 * Pencarian data sensitif (SIKESRA/SatuSehat) WAJIB mengaudit (hook onAudit).
 */

import { Hono } from "hono";

import { searchUsers as defaultSearchUsers } from "../../src/search/users-search.mjs";
import { searchSubjects as defaultSearchSubjects } from "../../src/plugins/sikesra/search/subjects-search.mjs";
import { searchPatients as defaultSearchPatients } from "../../src/plugins/satu-sehat-kobar/search/patients-search.mjs";
import { middlewareAbacGuard } from "../middleware/abac.mjs";

function readSearchQuery(c) {
  const sortField = c.req.query("sortField");
  return {
    q: c.req.query("q"),
    page: c.req.query("page"),
    pageSize: c.req.query("pageSize"),
    sort: sortField ? { field: sortField, dir: c.req.query("sortDir") } : undefined,
  };
}

// Bangun hook audit untuk pencarian data sensitif (selaras shape audit service).
function buildSearchAudit(c, options, { action, entityType, summary }) {
  return async ({ q, count }) => {
    if (!options.auditService) return;
    const actor = c.get("actor");
    await options.auditService.append({
      actor_user_id: actor?.id ?? null,
      action,
      entity_type: entityType,
      request_id: c.get("requestId") ?? null,
      ip_address: c.get("clientIp") ?? null,
      user_agent: c.req.header("user-agent") ?? null,
      summary,
      metadata: { q: q ?? null, count },
    });
  };
}

export function routeApiV1Search(options = {}) {
  const app = new Hono();
  const searchUsers = options.searchUsers ?? defaultSearchUsers;
  const searchSubjects = options.searchSubjects ?? defaultSearchSubjects;
  const searchPatients = options.searchPatients ?? defaultSearchPatients;

  // GET /api/v1/search/users — pencarian users (read-only, DTO tanpa password_hash).
  app.get(
    "/users",
    middlewareAbacGuard(
      { permissionCode: "admin.users.read", action: "read", resource: { kind: "user" } },
      options,
    ),
    async (c) => {
      const result = await searchUsers(readSearchQuery(c), { db: options.database });
      return c.json({ data: result });
    },
  );

  // GET /api/v1/search/sikesra/subjects — pencarian SIKESRA (highly_restricted; audit wajib).
  app.get(
    "/sikesra/subjects",
    middlewareAbacGuard(
      { permissionCode: "awcms:sikesra:subject:read", action: "read", resource: { kind: "sikesra_subject" } },
      options,
    ),
    async (c) => {
      const result = await searchSubjects(readSearchQuery(c), {
        db: options.database,
        onAudit: buildSearchAudit(c, options, {
          action: "sikesra.subject.search",
          entityType: "sikesra_subject",
          summary: "SIKESRA subject search (sensitive read)",
        }),
      });
      return c.json({ data: result });
    },
  );

  // GET /api/v1/search/satusehat/patients — pencarian SatuSehat (restricted; audit wajib).
  app.get(
    "/satusehat/patients",
    middlewareAbacGuard(
      { permissionCode: "awcms:satu_sehat_kobar:patient:read", action: "read", resource: { kind: "satu_sehat_patient" } },
      options,
    ),
    async (c) => {
      const result = await searchPatients(readSearchQuery(c), {
        db: options.database,
        onAudit: buildSearchAudit(c, options, {
          action: "satu_sehat_kobar.patient.search",
          entityType: "satu_sehat_patient",
          summary: "SatuSehat patient search (sensitive read)",
        }),
      });
      return c.json({ data: result });
    },
  );

  return app;
}
