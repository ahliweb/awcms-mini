/**
 * Query service pencarian SatuSehat patients (CQRS-lite, ADR-023) — READ-ONLY,
 * masking untuk data `restricted`.
 *
 * Aturan keras:
 * - NIK (`nik_enc`), nilai `ihs_number`, dan `metadata` **TIDAK** dikembalikan
 *   dari pencarian. DTO hanya menyertakan `hasIhs` (boolean status tautan
 *   SatuSehat) — informatif tanpa membocorkan identifier.
 * - Cari hanya by `full_name` (bukan NIK/IHS).
 * - Caller WAJIB permission `awcms:satu_sehat_kobar:patient:read` + audit (`onAudit`).
 * - RLS (ADR-015) tetap berlaku.
 */

import { getDatabase } from "../../../db/index.mjs";
import { withUserContext } from "../../../db/plugin-adapter.mjs";
import { normalizeSearchQuery, buildSearchResult } from "../../../search/query-contract.mjs";

const SCHEMA = "satu_sehat_kobar";
const TABLE = "patients";

/** Proyeksi — TANPA nik_enc, nilai ihs_number, metadata. ihs_number dibaca hanya untuk derive hasIhs. */
export const PATIENT_SEARCH_COLUMNS = ["id", "full_name", "gender", "classification", "ihs_number", "created_at"];

/** Field sort yang diizinkan (whitelist). */
export const PATIENT_SEARCH_SORT_FIELDS = ["created_at", "full_name"];

/** Kolom yang dicari saat `q` diberikan. (Hanya full_name.) */
const PATIENT_SEARCH_MATCH_COLUMNS = ["full_name"];

/**
 * Petakan baris → DTO aman. `ihs_number` TIDAK diekspos; hanya `hasIhs` boolean.
 */
export function toPatientSearchDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    fullName: row.full_name ?? null,
    gender: row.gender ?? null,
    classification: row.classification ?? "restricted",
    hasIhs: Boolean(row.ihs_number),
    createdAt: row.created_at ?? null,
  };
}

/**
 * Cari SatuSehat patients (read-only, masking).
 *
 * @param {object} [input] - lihat normalizeSearchQuery
 * @param {object} [deps]
 * @param {import("kysely").Kysely<unknown>} [deps.db]
 * @param {(info: { q: string|null; count: number }) => (void|Promise<void>)} [deps.onAudit]
 */
export async function searchPatients(input = {}, deps = {}) {
  const query = normalizeSearchQuery(input, { allowedSortFields: PATIENT_SEARCH_SORT_FIELDS });

  const applyFilters = (qb) => {
    let next = qb.where("deleted_at", "is", null);
    if (query.q) {
      const pattern = `%${query.q}%`;
      next = next.where((eb) =>
        eb.or(PATIENT_SEARCH_MATCH_COLUMNS.map((col) => eb(col, "ilike", pattern))),
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
      .select(PATIENT_SEARCH_COLUMNS)
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

  if (typeof deps.onAudit === "function") {
    await deps.onAudit({ q: query.q, count: total });
  }

  return buildSearchResult(rows.map(toPatientSearchDto), {
    page: query.page,
    pageSize: query.pageSize,
    total,
  });
}
