import {
  createEdgeApiJsonResponse,
  enforceEdgeApiAccept,
  enforceEdgeApiMethod,
  enforceEdgeApiOrigin,
  handleEdgeApiCorsPreflight,
} from "./v1.mjs";
import { checkDatabaseHealth, describeDatabaseHealthPosture } from "../../db/health.mjs";

export function handleEdgeHealthOptions({ request }) {
  return handleEdgeApiCorsPreflight(request, {
    methods: ["GET", "OPTIONS"],
    headers: ["Content-Type"],
  });
}

export async function handleEdgeHealthGet({
  request,
  databaseHealthCheck = checkDatabaseHealth,
  databaseHealthPosture = describeDatabaseHealthPosture,
} = {}) {
  const methodError = enforceEdgeApiMethod(request, ["GET"]);
  if (methodError) return methodError;

  const originError = enforceEdgeApiOrigin(request);
  if (originError) return originError;

  const acceptError = enforceEdgeApiAccept(request);
  if (acceptError) return acceptError;

  const database = await databaseHealthCheck();
  const databasePosture = databaseHealthPosture();
  const ok = database.ok;

  return createEdgeApiJsonResponse(
    request,
    {
      ok,
      version: "v1",
      service: "awcms-mini-edge-api",
      checks: {
        database: {
          ok: database.ok,
          ...(database.ok
            ? {}
            : {
                kind: database.kind,
                reason: database.reason,
              }),
          posture: databasePosture,
        },
      },
    },
    ok ? 200 : 503,
  );
}
