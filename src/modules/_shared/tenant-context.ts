/**
 * Tenant context (doc 10) — identitas request tervalidasi yang mengalir
 * dari middleware auth ke service. Service TIDAK membaca Request langsung.
 *
 * Catatan produksi: tenantUserId dan identityId TIDAK boleh dipercaya
 * langsung dari public header; nilai harus berasal dari auth middleware
 * yang memvalidasi token (modul identity-access).
 */

export type TenantContext = {
  tenantId: string;
  tenantUserId: string;
  identityId: string;
  profileId?: string;
  defaultOfficeId?: string;
  roles: string[];
  correlationId?: string;
  requestId?: string;
};

/** Header standard API (doc 05, prefiks disesuaikan AWCMS). */
export const HEADERS = {
  tenantId: "X-AWCMS-Tenant-ID",
  idempotencyKey: "Idempotency-Key",
  correlationId: "X-Correlation-ID",
  requestId: "X-Request-ID",
  nodeId: "X-AWCMS-Node-ID",
  syncTimestamp: "X-AWCMS-Timestamp",
  syncSignature: "X-AWCMS-Signature"
} as const;

/** Ambil/generate identifier trace dari request (aman untuk logging). */
export function traceIdsFromRequest(request: Request): {
  requestId: string;
  correlationId: string;
} {
  const requestId = request.headers.get(HEADERS.requestId) ?? `req_${crypto.randomUUID()}`;
  const correlationId =
    request.headers.get(HEADERS.correlationId) ?? `corr_${crypto.randomUUID()}`;
  return { requestId, correlationId };
}
