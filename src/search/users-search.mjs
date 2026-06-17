/**
 * Query service pencarian users (CQRS-lite, ADR-023) — READ-ONLY.
 *
 * Mengembalikan read DTO/projection (BUKAN entity domain): field sensitif
 * (`password_hash`, dll) tidak pernah dikembalikan. Tidak memanggil command
 * repository & tidak melakukan mutasi.
 *
 * RLS (ADR-015) tetap berlaku melalui koneksi ber-konteks; masking di sini =
 * lapis tambahan (proyeksi kolom aman).
 */

import { getDatabase } from "../db/index.mjs";
import { normalizeSearchQuery, buildSearchResult } from "./query-contract.mjs";

/** Kolom proyeksi aman — TIDAK termasuk password_hash atau data sensitif lain. */
export const USER_SEARCH_COLUMNS = [
  "id",
  "email",
  "username",
  "display_name",
  "status",
  "is_protected",
  "created_at",
];

/** Field yang boleh dipakai untuk sort (whitelist, anti-injection). */
export const USER_SEARCH_SORT_FIELDS = ["created_at", "email", "username", "display_name"];

/** Kolom yang dicari saat `q` diberikan (trigram/ILIKE-friendly). */
const USER_SEARCH_MATCH_COLUMNS = ["email", "username", "display_name"];

/**
 * Petakan baris DB → read DTO. Pure & defensif: hanya kolom proyeksi,
 * jaminan tidak membocorkan field sensitif walau baris membawa lebih.
 *
 * @param {Record<string, unknown>} row
 */
export function toUserSearchDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    username: row.username ?? null,
    displayName: row.display_name ?? null,
    status: row.status ?? null,
    isProtected: Boolean(row.is_protected),
    createdAt: row.created_at ?? null,
  };
}

/**
 * Cari users (read-only). Mengembalikan SearchResult berisi read DTO.
 *
 * @param {object} [input] - lihat normalizeSearchQuery
 * @param {object} [deps]
 * @param {import("kysely").Kysely<unknown>} [deps.db]
 */
export async function searchUsers(input = {}, deps = {}) {
  const db = deps.db ?? getDatabase();
  const query = normalizeSearchQuery(input, { allowedSortFields: USER_SEARCH_SORT_FIELDS });

  // Predikat dasar: hanya baris aktif (soft-delete guard).
  const applyFilters = (qb) => {
    let next = qb.where("deleted_at", "is", null);
    if (query.q) {
      const pattern = `%${query.q}%`;
      next = next.where((eb) =>
        eb.or(USER_SEARCH_MATCH_COLUMNS.map((col) => eb(col, "ilike", pattern))),
      );
    }
    if (typeof query.filters.status === "string") {
      next = next.where("status", "=", query.filters.status);
    }
    return next;
  };

  // Total (count) — query terpisah pada predikat yang sama.
  const countRow = await applyFilters(db.selectFrom("users"))
    .select((eb) => eb.fn.countAll().as("count"))
    .executeTakeFirst();
  const total = Number(countRow?.count ?? 0);

  // Halaman data dengan proyeksi aman + sort whitelist + paginasi.
  const rows = await applyFilters(db.selectFrom("users"))
    .select(USER_SEARCH_COLUMNS)
    .orderBy(query.sort.field, query.sort.dir)
    .orderBy("id", "asc") // tie-breaker deterministik
    .limit(query.pageSize)
    .offset(query.offset)
    .execute();

  return buildSearchResult(rows.map(toUserSearchDto), {
    page: query.page,
    pageSize: query.pageSize,
    total,
  });
}
