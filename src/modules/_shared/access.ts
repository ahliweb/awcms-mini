/**
 * Kontrak ABAC guard (doc 10 & 17).
 *
 * Aturan non-negotiable:
 * - Semua endpoint non-public wajib guard.
 * - Default deny; deny overrides allow.
 * - RLS tetap wajib walau ABAC sudah cek (defense in depth).
 * - Access denied high-risk masuk decision log.
 *
 * Evaluator konkret dimiliki modul identity-access; _shared hanya
 * mendefinisikan kontrak + guard pembungkus.
 */
import { apiError, type ApiError } from "./api-error";
import type { TenantContext } from "./tenant-context";

export type AccessAction =
  | "read"
  | "create"
  | "update"
  | "delete"
  | "post"
  | "cancel"
  | "approve"
  | "export"
  | "send"
  | "configure"
  | "analyze"
  | "assign";

export type AccessRequest = {
  moduleKey: string;
  activityCode: string;
  action: AccessAction;
  resourceType?: string;
  resourceId?: string;
  resourceAttributes?: Record<string, unknown>;
  environmentAttributes?: Record<string, unknown>;
};

export type AccessDecision = {
  allowed: boolean;
  reason: string;
  decisionId?: string;
  matchedPolicy?: string;
};

export type AccessEvaluator = (
  context: TenantContext,
  request: AccessRequest
) => Promise<AccessDecision>;

/** Keputusan default bila tidak ada evaluator/policy yang cocok. */
export const DEFAULT_DENY: AccessDecision = {
  allowed: false,
  reason: "default_deny"
};

export function accessDeniedError(decision: AccessDecision): ApiError {
  return apiError("ACCESS_DENIED", "Tidak punya akses.", [
    { message: decision.reason, code: decision.matchedPolicy }
  ]);
}

/**
 * Guard pembungkus: evaluasi lalu lempar ACCESS_DENIED bila ditolak.
 * Mengembalikan decision untuk keperluan decision log.
 */
export async function guardAccess(
  evaluator: AccessEvaluator,
  context: TenantContext,
  request: AccessRequest
): Promise<AccessDecision> {
  const decision = await evaluator(context, request);
  if (!decision.allowed) {
    throw accessDeniedError(decision);
  }
  return decision;
}
