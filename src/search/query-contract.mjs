/**
 * Kontrak query CQRS-lite untuk pencarian (ADR-023).
 *
 * Query side bersifat READ-ONLY: menormalkan input pencarian dan membentuk
 * hasil terstandar (selaras envelope API §6). Tidak melakukan mutasi dan tidak
 * memanggil command repository.
 *
 * Lihat personal-coding `docs/architecture/awcms-cqrs-search.md`.
 */

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_SORT = { field: "created_at", dir: "desc" };

function clampInteger(value, { min, max, fallback }) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

/**
 * Normalkan input pencarian mentah menjadi SearchQuery yang aman.
 *
 * @param {object} [input]
 * @param {string} [input.q] - kata kunci pencarian
 * @param {Record<string, unknown>} [input.filters]
 * @param {number|string} [input.page] - 1-based (default 1)
 * @param {number|string} [input.pageSize] - default 20, maks 100
 * @param {{ field: string; dir: "asc"|"desc" }} [input.sort]
 * @param {object} [options]
 * @param {string[]} [options.allowedSortFields] - whitelist field sort (anti-injection)
 * @returns {{ q: string|null; filters: Record<string, unknown>; page: number; pageSize: number; offset: number; sort: { field: string; dir: "asc"|"desc" } }}
 */
export function normalizeSearchQuery(input = {}, options = {}) {
  const allowedSortFields = options.allowedSortFields ?? [DEFAULT_SORT.field, "id"];

  const q = typeof input.q === "string" && input.q.trim() !== "" ? input.q.trim() : null;

  const page = clampInteger(input.page, { min: 1, fallback: 1 });
  const pageSize = clampInteger(input.pageSize, { min: 1, max: MAX_PAGE_SIZE, fallback: DEFAULT_PAGE_SIZE });

  // Sort: field harus di-whitelist (cegah SQL injection lewat nama kolom).
  const requestedField = input.sort?.field;
  const field = allowedSortFields.includes(requestedField) ? requestedField : DEFAULT_SORT.field;
  const dir = input.sort?.dir === "asc" ? "asc" : "desc";

  return {
    q,
    filters: input.filters && typeof input.filters === "object" ? input.filters : {},
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    sort: { field, dir },
  };
}

/**
 * Bentuk hasil pencarian terstandar.
 *
 * @template TDto
 * @param {TDto[]} items - read DTO/projection (BUKAN entity domain)
 * @param {{ page: number; pageSize: number; total: number }} meta
 * @returns {{ items: TDto[]; page: number; pageSize: number; total: number; totalPages: number }}
 */
export function buildSearchResult(items, { page, pageSize, total }) {
  const safeTotal = Number.isFinite(total) && total >= 0 ? total : items.length;
  return {
    items,
    page,
    pageSize,
    total: safeTotal,
    totalPages: pageSize > 0 ? Math.ceil(safeTotal / pageSize) : 0,
  };
}
