/**
 * Structured logging dengan Pino (ADR-021).
 *
 * - Output JSON terstruktur, low-overhead.
 * - Redaction WAJIB untuk field sensitif (token, password, NIK, header auth)
 *   selaras klasifikasi data (restricted/highly_restricted). Lihat
 *   personal-coding `awcms-shared-standards.md` §8.3.
 * - Gunakan child logger ber-`requestId` (selaras envelope API §6).
 */

import pino from "pino";

/**
 * Path yang WAJIB di-redact dari log. Memakai sintaks path Pino
 * (mendukung wildcard `*` satu level). Censor → "[REDACTED]".
 *
 * Catatan: jangan pernah log payload restricted/highly_restricted mentah.
 * Daftar ini adalah jaring pengaman lapis terakhir, bukan pengganti disiplin
 * tidak mem-log data sensitif.
 */
export const REDACT_PATHS = [
  // Kredensial & token
  "password",
  "*.password",
  "passwordHash",
  "*.passwordHash",
  "password_hash",
  "*.password_hash",
  "token",
  "*.token",
  "accessToken",
  "*.accessToken",
  "refreshToken",
  "*.refreshToken",
  "secret",
  "*.secret",
  "apiKey",
  "*.apiKey",
  // Identitas sensitif (SIKESRA/SatuSehat — highly_restricted)
  "nik",
  "*.nik",
  "nikEnc",
  "*.nikEnc",
  "nik_enc",
  "*.nik_enc",
  // Header auth
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "headers.cookie",
  'res.headers["set-cookie"]',
];

const REDACT_CENSOR = "[REDACTED]";

/**
 * Buat instance Pino logger dengan redaction wajib.
 *
 * @param {object} [options]
 * @param {string} [options.level] - Level log (default: env LOG_LEVEL atau "info").
 * @param {Record<string, unknown>} [options.base] - Field dasar yang disertakan di setiap log.
 * @param {string[]} [options.redactPaths] - Override path redaction (default REDACT_PATHS).
 * @returns {import("pino").Logger}
 */
export function createLogger(options = {}) {
  const level = options.level ?? process.env.LOG_LEVEL ?? "info";
  const redactPaths = options.redactPaths ?? REDACT_PATHS;

  return pino({
    level,
    base: options.base ?? undefined,
    redact: {
      paths: redactPaths,
      censor: REDACT_CENSOR,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      // Tampilkan level sebagai label (mis. "info") alih-alih angka.
      level(label) {
        return { level: label };
      },
    },
  });
}

/**
 * Root logger aplikasi (singleton). Gunakan untuk log non-request
 * (startup, jobs, scripts). Untuk konteks request, pakai child logger.
 */
export const rootLogger = createLogger({ base: { service: "awcms-mini" } });

/**
 * Buat child logger yang terikat pada satu request (ber-`requestId`).
 * Selaras envelope API §6 agar log mudah dikorelasikan dengan respons.
 *
 * @param {string} requestId
 * @param {Record<string, unknown>} [bindings] - Field tambahan (mis. userId).
 * @returns {import("pino").Logger}
 */
export function childLoggerForRequest(requestId, bindings = {}) {
  return rootLogger.child({ requestId, ...bindings });
}
