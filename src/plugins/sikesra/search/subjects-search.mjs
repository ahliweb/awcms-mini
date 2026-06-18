/**
 * Query service pencarian SIKESRA subjects (CQRS-lite, ADR-023) — READ-ONLY,
 * **masking ketat** karena data highly_restricted.
 *
 * Aturan keras:
 * - NIK (`nik_enc`) dan `metadata` **TIDAK PERNAH** dikembalikan dari pencarian.
 * - Caller WAJIB punya permission `awcms:sikesra:subject:read` dan **mengaudit**
 *   pencarian (data sensitif) — lihat parameter `onAudit`.
 * - RLS (ADR-015) tetap berlaku via koneksi ber-konteks.
 *
 * Lihat personal-coding `docs/architecture/awcms-cqrs-search.md` §3 (keamanan).
 */

import { getDatabase } from "../../../db/index.mjs";
import { withUserContext } from "../../../db/plugin-adapter.mjs";
import { normalizeSearchQuery, buildSearchResult } from "../../../search/query-contract.mjs";

const SCHEMA = "sikesra";
const TABLE = "subjects";

/** Proyeksi aman — TANPA nik_enc & metadata (highly_restricted). */
export const SUBJECT_SEARCH_COLUMNS = ["id", "full_name", "gender", "classification", "created_at"];

/** Field sort yang diizinkan (whitelist). */
export const SUBJECT_SEARCH_SORT_FIELDS = ["created_at", "full_name"];

/** Kolom yang dicari saat `q` diberikan. (Hanya full_name — bukan NIK.) */
const SUBJECT_SEARCH_MATCH_COLUMNS = ["full_name"];

/**
 * Petakan baris → DTO aman. Defensif: buang nik_enc & metadata walau row membawanya.
 */
export function toSubjectSearchDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    fullName: row.full_name ?? null,
    gender: row.gender ?? null,
    classification: row.classification ?? "highly_restricted",
    createdAt: row.created_at ?? null,
  };
}

/**
 * Cari SIKESRA subjects (read-only, masking ketat).
 *
 * Konteks RLS (`app.current_user_id`) di-set dalam **satu transaksi** dengan query
 * (via withUserContext) agar policy RLS plugin benar-benar diterapkan pada jalur
 * request berbasis connection pool.
 *
 * @param {object} [input] - lihat normalizeSearchQuery
 * @param {object} [deps]
 * @param {string} [deps.actorId] - ID user aktif (konteks RLS). WAJIB di produksi.
 * @param {import("kysely").Kysely<unknown>} [deps.db]
 * @param {import("kysely").Transaction<unknown>} [deps.executor] - executor siap-pakai (test/sudah dalam konteks)
 * @param {(info: { q: string|null; count: number }) => (void|Promise<void>)} [deps.onAudit]
 *   Hook audit WAJIB diisi caller untuk mencatat pencarian data sensitif.
 */
export async function searchSubjects(input = {}, deps = {}) {
  const query = normalizeSearchQuery(input, { allowedSortFields: SUBJECT_SEARCH_SORT_FIELDS });

  const applyFilters = (qb) => {
    let next = qb.where("deleted_at", "is", null);
    if (query.q) {
      const pattern = `%${query.q}%`;
      next = next.where((eb) =>
        eb.or(SUBJECT_SEARCH_MATCH_COLUMNS.map((col) => eb(col, "ilike", pattern))),
      );
    }
    if (typeof query.filters.gender === "string") {
      next = next.where("gender", "=", query.filters.gender);
    }
    return next;
  };

  const runQueries = async (executor) => {
    const countRow = await applyFilters(executor.withSchema(SCHEMA).selectFrom(TABLE))
      .select((eb) => eb.fn.countAll().as("count"))
      .executeTakeFirst();
    const rows = await applyFilters(executor.withSchema(SCHEMA).selectFrom(TABLE))
      .select(SUBJECT_SEARCH_COLUMNS)
      .orderBy(query.sort.field, query.sort.dir)
      .orderBy("id", "asc")
      .limit(query.pageSize)
      .offset(query.offset)
      .execute();
    return { total: Number(countRow?.count ?? 0), rows };
  };

  // executor injectable untuk test; di produksi bungkus dalam transaksi + konteks RLS.
  const { total, rows } = deps.executor
    ? await runQueries(deps.executor)
    : await withUserContext(deps.db ?? getDatabase(), deps.actorId ?? "", runQueries);

  // Audit pencarian data sensitif (caller menyediakan hook).
  if (typeof deps.onAudit === "function") {
    await deps.onAudit({ q: query.q, count: total });
  }

  return buildSearchResult(rows.map(toSubjectSearchDto), {
    page: query.page,
    pageSize: query.pageSize,
    total,
  });
}
