/**
 * Utilitas UI admin plugin native (decoupling EmDash, ADR-020 Fase 4).
 *
 * Pengganti `emdash/plugin-utils` untuk komponen `admin.tsx` plugin. Menyediakan
 * `apiFetch` (fetch + header anti-CSRF), `parseApiResponse` (membuka envelope
 * `{ data }`), `getErrorMessage`, dan `isRecord`.
 *
 * Catatan kontrak: header `X-EmDash-Request: 1` **dipertahankan** karena admin
 * backend saat ini (admin shell EmDash, dilepas pada Fase 4/5) masih menolak
 * request state-changing tanpa header tsb. Saat admin shell diganti native,
 * ganti `CSRF_HEADER` ke header milik AWCMS sendiri.
 *
 * Tidak ada dependency `emdash`; implementasi milik AWCMS-Mini sendiri.
 */

const CSRF_HEADER = "X-EmDash-Request";

/**
 * Pembungkus `fetch` yang menambahkan header proteksi CSRF.
 * Semua panggilan API admin plugin sebaiknya memakai ini, bukan `fetch()` mentah.
 */
export function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set(CSRF_HEADER, "1");
  return fetch(input, { ...init, headers });
}

/**
 * Parse respons API, membuka envelope `{ data: T }`. Pada respons non-2xx,
 * melempar `Error` dengan pesan dari server (`{ error: { message } }`) atau fallback.
 */
export async function parseApiResponse<T>(
  response: Response,
  fallbackMessage = "Request failed",
): Promise<T> {
  if (!response.ok) {
    throw new Error(await getErrorMessage(response, `${fallbackMessage}: ${response.statusText}`));
  }
  return (await response.json()).data as T;
}

/**
 * Ambil pesan error dari respons API gagal (shape `{ error: { code, message } }`).
 * Menelan kegagalan parse JSON dengan anggun.
 */
export async function getErrorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => ({}));
  if (isRecord(body) && isRecord(body.error)) {
    const msg = (body.error as Record<string, unknown>).message;
    if (typeof msg === "string") return msg;
  }
  return fallback;
}

/** Sempitkan `unknown` ke record objek biasa. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
