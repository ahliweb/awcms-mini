import {
  createEdgeApiErrorResponse,
  createEdgeApiJsonResponse,
  enforceEdgeApiAccept,
  enforceEdgeApiJsonBody,
  enforceEdgeApiMethod,
  enforceEdgeApiOrigin,
  handleEdgeApiCorsPreflight,
} from "./v1.mjs";
import { createEdgeAuthService, EdgeAuthError } from "../../services/edge-auth/service.mjs";

export function handleEdgeTokenOptions({ request }) {
  return handleEdgeApiCorsPreflight(request, {
    methods: ["POST", "OPTIONS"],
    headers: ["Content-Type"],
  });
}

export async function handleEdgeTokenPost({ request, db }) {
  const methodError = enforceEdgeApiMethod(request, ["POST"]);
  if (methodError) return methodError;

  const originError = enforceEdgeApiOrigin(request);
  if (originError) return originError;

  const acceptError = enforceEdgeApiAccept(request);
  if (acceptError) return acceptError;

  const bodyError = enforceEdgeApiJsonBody(request);
  if (bodyError) return bodyError;

  let body;
  try {
    body = await request.json();
  } catch {
    return createEdgeApiErrorResponse(request, "INVALID_BODY", "Expected JSON body.", 400);
  }

  const edgeAuth = createEdgeAuthService({ database: db });
  const grantType = typeof body?.grant_type === "string" ? body.grant_type.trim() : "";

  try {
    if (grantType === "password") {
      const result = await edgeAuth.issueTokenPairFromPassword({
        request,
        email: body?.email,
        password: body?.password,
        code: body?.code,
        recoveryCode: body?.recoveryCode,
      });

      return createEdgeApiJsonResponse(request, result, 200);
    }

    if (grantType === "refresh_token") {
      const result = await edgeAuth.refreshTokenPair({
        refreshToken: body?.refresh_token,
        request,
      });

      return createEdgeApiJsonResponse(request, result, 200);
    }

    return createEdgeApiErrorResponse(request, "INVALID_GRANT_TYPE", "Unsupported grant type.", 400);
  } catch (error) {
    if (error instanceof EdgeAuthError) {
      return createEdgeApiErrorResponse(request, error.code, error.message, error.status);
    }

    throw error;
  }
}
