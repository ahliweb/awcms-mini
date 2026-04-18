import {
  createEdgeApiErrorResponse,
  createEdgeApiJsonResponse,
  enforceEdgeApiAccept,
  enforceEdgeApiJsonBody,
  enforceEdgeApiMethod,
  enforceEdgeApiOrigin,
  handleEdgeApiCorsPreflight,
  requireEdgeApiIdentitySession,
} from "./v1.mjs";
import { createSessionService } from "../../services/sessions/service.mjs";

export function handleEdgeSessionOptions({ request }) {
  return handleEdgeApiCorsPreflight(request, {
    methods: ["GET", "POST", "OPTIONS"],
    headers: ["Content-Type"],
  });
}

export async function handleEdgeSessionGet({ request, session, db }) {
  const methodError = enforceEdgeApiMethod(request, ["GET"]);
  if (methodError) return methodError;

  const originError = enforceEdgeApiOrigin(request);
  if (originError) return originError;

  const acceptError = enforceEdgeApiAccept(request);
  if (acceptError) return acceptError;

  const auth = await requireEdgeApiIdentitySession({ request, session, db });
  if (!auth.ok) return auth.response;

  return createEdgeApiJsonResponse(request, {
    user: {
      id: auth.user.id,
      email: auth.user.email,
      name: auth.user.name ?? auth.user.display_name ?? null,
      avatarUrl: auth.user.avatar_url ?? null,
    },
    session: {
      id: auth.activeSession.id,
      trustedDevice: auth.activeSession.trusted_device,
      expiresAt: auth.activeSession.expires_at,
      lastSeenAt: auth.activeSession.last_seen_at ?? null,
    },
  });
}

export async function handleEdgeSessionPost({ request, session, db }) {
  const methodError = enforceEdgeApiMethod(request, ["POST"]);
  if (methodError) return methodError;

  const originError = enforceEdgeApiOrigin(request);
  if (originError) return originError;

  const acceptError = enforceEdgeApiAccept(request);
  if (acceptError) return acceptError;

  const bodyError = enforceEdgeApiJsonBody(request);
  if (bodyError) return bodyError;

  const auth = await requireEdgeApiIdentitySession({ request, session, db });
  if (!auth.ok) return auth.response;

  let body;
  try {
    body = await request.json();
  } catch {
    return createEdgeApiErrorResponse(request, "INVALID_BODY", "Expected JSON body.", 400);
  }

  if (body?.action !== "revoke_current_session") {
    return createEdgeApiErrorResponse(request, "INVALID_ACTION", "Unsupported session action.", 400);
  }

  const sessions = createSessionService({ database: db });
  const revoked = await sessions.revokeSession(auth.activeSession.id);
  session?.destroy?.();

  return createEdgeApiJsonResponse(request, {
    success: true,
    session: {
      id: revoked?.id ?? auth.activeSession.id,
      revokedAt: revoked?.revoked_at ?? null,
    },
  });
}
