/**
 * Idempotency wrapper (doc 10 & 16) — mutation high-risk wajib
 * Idempotency-Key. Logika murni di sini; penyimpanan di
 * src/lib/database/idempotency-store.ts (tabel awcms_idempotency_keys).
 */
import { createHash } from "node:crypto";
import { apiError } from "./api-error";
import { HEADERS } from "./tenant-context";

export type IdempotencyRecord = {
  key: string;
  requestHash: string;
  status: "in_progress" | "completed";
  responseStatus?: number;
  responseBody?: unknown;
};

export type IdempotencyStore = {
  find(tenantId: string, key: string): Promise<IdempotencyRecord | undefined>;
  start(tenantId: string, key: string, requestHash: string): Promise<void>;
  complete(
    tenantId: string,
    key: string,
    responseStatus: number,
    responseBody: unknown
  ): Promise<void>;
};

/** Stable stringify: urutkan key objek agar hash deterministik. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

export function computeRequestHash(method: string, path: string, body: unknown): string {
  return createHash("sha256")
    .update(`${method.toUpperCase()} ${path}\n${stableStringify(body ?? null)}`)
    .digest("hex");
}

export function requireIdempotencyKey(request: Request): string {
  const key = request.headers.get(HEADERS.idempotencyKey);
  if (!key || key.trim().length === 0 || key.length > 255) {
    throw apiError("IDEMPOTENCY_REQUIRED", "Header Idempotency-Key wajib untuk mutation ini.");
  }
  return key.trim();
}

export type ReplayDecision =
  | { kind: "fresh" }
  | { kind: "replay"; responseStatus: number; responseBody: unknown }
  | { kind: "in_progress" };

/**
 * Evaluasi record tersimpan terhadap hash request sekarang:
 * - key sama + hash sama + completed → replay response tersimpan
 * - key sama + hash beda → 409 IDEMPOTENCY_CONFLICT
 * - key sama + masih in_progress → 409 (klien harus retry nanti)
 */
export function evaluateReplay(
  existing: IdempotencyRecord | undefined,
  requestHash: string
): ReplayDecision {
  if (!existing) return { kind: "fresh" };
  if (existing.requestHash !== requestHash) {
    throw apiError(
      "IDEMPOTENCY_CONFLICT",
      "Idempotency-Key sudah dipakai oleh request yang berbeda."
    );
  }
  if (existing.status === "completed") {
    return {
      kind: "replay",
      responseStatus: existing.responseStatus ?? 200,
      responseBody: existing.responseBody
    };
  }
  return { kind: "in_progress" };
}
