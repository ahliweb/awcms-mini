import { definePlugin, PluginRouteError } from "emdash";

import { collectRegisteredPluginPermissions } from "../permission-registration.mjs";
import { createAuthorizedPluginRoute } from "../route-authorization.mjs";
import { createPluginServiceAuthorizationHelper } from "../service-authorization.mjs";
import { createPluginAuditHelper } from "../audit-helper.mjs";
import { createPluginRegionAwarenessHelper } from "../region-awareness.mjs";

const SAMPLE_PLUGIN_ID = "internal-governance-sample";

export const SAMPLE_PLUGIN_PERMISSIONS = collectRegisteredPluginPermissions([
  {
    id: SAMPLE_PLUGIN_ID,
    permissions: [
      {
        code: "sample.records.read",
        domain: "sample",
        resource: "records",
        action: "read",
        description: "View internal governance sample records.",
      },
      {
        code: "sample.records.flag",
        domain: "sample",
        resource: "records",
        action: "flag",
        description: "Flag internal governance sample records.",
        is_protected: true,
      },
    ],
  },
]);

let sampleDatabaseGetter = () => ({ name: "sample-db" });
let sampleAuthorizationServiceFactory = () => ({
  async evaluate() {
    return { allowed: true };
  },
});
let sampleAuditServiceFactory = () => ({
  async append() {
    return true;
  },
});
let sampleRecordServiceFactory = () => ({
  async listRecordsByUserId() {
    return [];
  },
  async flagRecord() {
    return { id: "", userId: "", status: "flagged" };
  },
});
let sampleRegionAwarenessFactory = () => createPluginRegionAwarenessHelper();

async function createSampleActor(ctx) {
  const sessionUser = await ctx.session?.get?.("user");
  const actorUserId = sessionUser?.id ?? "";

  if (!actorUserId) {
    throw PluginRouteError.unauthorized("Missing sample actor context.");
  }

  return {
    id: actorUserId,
    status: "active",
    isProtected: false,
    activeRoleStaffLevel: 4,
  };
}

function createSampleProtectedRoute(options) {
  return createAuthorizedPluginRoute({
    pluginId: SAMPLE_PLUGIN_ID,
    permissions: SAMPLE_PLUGIN_PERMISSIONS,
    getDatabase: () => sampleDatabaseGetter(),
    resolveActor: async (_db, ctx) => createSampleActor(ctx),
    getAuthorizationService: (database) => sampleAuthorizationServiceFactory(database),
    ...options,
  });
}

async function listRecordsHandler(ctx) {
  const search = new URL(ctx.request.url).searchParams;
  const userId = search.get("userId");

  if (!userId) {
    throw PluginRouteError.badRequest("Missing required user id");
  }

  const service = sampleRecordServiceFactory(ctx.pluginDb ?? sampleDatabaseGetter());
  return {
    items: await service.listRecordsByUserId(userId),
  };
}

async function flagRecordHandler(ctx) {
  let body;

  try {
    body = await ctx.request.json();
  } catch {
    throw PluginRouteError.badRequest("Expected JSON body");
  }

  const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
  const recordId = typeof body?.recordId === "string" ? body.recordId.trim() : "";

  if (!userId || !recordId) {
    throw PluginRouteError.badRequest("User id and record id are required");
  }

  const db = ctx.pluginDb ?? sampleDatabaseGetter();
  const actor = ctx.pluginActor ?? await createSampleActor(ctx);
  const regionAwareness = sampleRegionAwarenessFactory();
  const serviceAuthorization = createPluginServiceAuthorizationHelper({
    pluginId: SAMPLE_PLUGIN_ID,
    permissions: SAMPLE_PLUGIN_PERMISSIONS,
    getAuthorizationService: (database) => sampleAuthorizationServiceFactory(database),
  });

  const scopedResource = await regionAwareness.buildScopedResource({
    database: db,
    resource: {
      kind: "sample_record",
      target_user_id: userId,
    },
    includeLogical: true,
    includeAdministrative: true,
  });

  const authResult = await serviceAuthorization.authorize({
    actor,
    database: db,
    permissionCode: "sample.records.flag",
    action: "flag",
    resource: scopedResource,
    sessionId: (await ctx.session?.get?.("identitySession"))?.id ?? null,
  });

  if (!authResult.allowed) {
    throw PluginRouteError.forbidden(authResult.reason?.code ?? "Forbidden");
  }

  const records = sampleRecordServiceFactory(db);
  const result = await records.flagRecord({
    userId,
    recordId,
    actorUserId: actor.id,
  });

  const pluginAudit = createPluginAuditHelper({
    pluginId: SAMPLE_PLUGIN_ID,
    getAuditService: (database) => sampleAuditServiceFactory(database),
  });

  await pluginAudit.append({
    database: db,
    actorUserId: actor.id,
    request: ctx.request,
    action: "plugin.sample.records.flag",
    entityType: "sample_record",
    entityId: recordId,
    targetUserId: userId,
    summary: "Flagged sample governance record.",
    afterPayload: {
      status: result.status,
    },
    metadata: {
      plugin_action: "records.flag",
      logical_region_ids: scopedResource.logical_region_ids ?? [],
      administrative_region_ids: scopedResource.administrative_region_ids ?? [],
    },
  });

  return {
    item: result,
  };
}

export function createPlugin() {
  return definePlugin({
    id: SAMPLE_PLUGIN_ID,
    version: "0.1.0",
    permissions: SAMPLE_PLUGIN_PERMISSIONS,
    routes: {
      "records/list": {
        ...createSampleProtectedRoute({
          guard: {
            permissionCode: "sample.records.read",
            action: "read",
            resource: async ({ ctx, db }) => {
              const userId = new URL(ctx.request.url).searchParams.get("userId");

              if (!userId) {
                throw PluginRouteError.badRequest("Missing required user id");
              }

              return sampleRegionAwarenessFactory().buildScopedResource({
                database: db,
                resource: {
                  kind: "sample_record",
                  target_user_id: userId,
                },
                includeLogical: true,
              });
            },
          },
          handler: listRecordsHandler,
        }),
      },
      "records/flag": {
        ...createSampleProtectedRoute({
          guard: {
            permissionCode: "sample.records.read",
            action: "read",
          },
          handler: flagRecordHandler,
        }),
      },
    },
  });
}

export function internalGovernanceSamplePlugin() {
  return {
    id: SAMPLE_PLUGIN_ID,
    version: "0.1.0",
    format: "native",
    entrypoint: "/src/plugins/internal-governance-sample/index.mjs",
    permissions: SAMPLE_PLUGIN_PERMISSIONS,
  };
}

export function setSampleDatabaseGetter(getter) {
  sampleDatabaseGetter = getter;
}

export function resetSampleDatabaseGetter() {
  sampleDatabaseGetter = () => ({ name: "sample-db" });
}

export function setSampleAuthorizationServiceFactory(factory) {
  sampleAuthorizationServiceFactory = factory;
}

export function resetSampleAuthorizationServiceFactory() {
  sampleAuthorizationServiceFactory = () => ({
    async evaluate() {
      return { allowed: true };
    },
  });
}

export function setSampleAuditServiceFactory(factory) {
  sampleAuditServiceFactory = factory;
}

export function resetSampleAuditServiceFactory() {
  sampleAuditServiceFactory = () => ({
    async append() {
      return true;
    },
  });
}

export function setSampleRecordServiceFactory(factory) {
  sampleRecordServiceFactory = factory;
}

export function resetSampleRecordServiceFactory() {
  sampleRecordServiceFactory = () => ({
    async listRecordsByUserId() {
      return [];
    },
    async flagRecord() {
      return { id: "", userId: "", status: "flagged" };
    },
  });
}

export function setSampleRegionAwarenessFactory(factory) {
  sampleRegionAwarenessFactory = factory;
}

export function resetSampleRegionAwarenessFactory() {
  sampleRegionAwarenessFactory = () => createPluginRegionAwarenessHelper();
}

export default createPlugin;
