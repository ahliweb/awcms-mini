import {
  createEdgeApiJsonResponse,
  enforceEdgeApiAccept,
  enforceEdgeApiMethod,
  enforceEdgeApiOrigin,
  handleEdgeApiCorsPreflight,
} from "./v1.mjs";

export function handleEdgeHealthOptions({ request }) {
  return handleEdgeApiCorsPreflight(request, {
    methods: ["GET", "OPTIONS"],
    headers: ["Content-Type"],
  });
}

export async function handleEdgeHealthGet({ request }) {
  const methodError = enforceEdgeApiMethod(request, ["GET"]);
  if (methodError) return methodError;

  const originError = enforceEdgeApiOrigin(request);
  if (originError) return originError;

  const acceptError = enforceEdgeApiAccept(request);
  if (acceptError) return acceptError;

  return createEdgeApiJsonResponse(request, {
    ok: true,
    version: "v1",
    service: "awcms-mini-edge-api",
  });
}
