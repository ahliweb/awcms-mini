/**
 * Redaction data sensitif (doc 10 — Logger redaction).
 * Dipakai logger dan audit helper: key yang mengandung kata sensitif
 * tidak pernah masuk log/audit/response mentah.
 */

export const SENSITIVE_KEY_PATTERNS: readonly string[] = [
  "password",
  "passwordhash",
  "token",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "api_key",
  "secret",
  "authorization",
  "npwp",
  "nik",
  "phone",
  "whatsapp",
  "email"
];

export const REDACTED_VALUE = "[REDACTED]";

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, "");
  return SENSITIVE_KEY_PATTERNS.some((pattern) =>
    normalized.includes(pattern.replace(/[-_]/g, ""))
  );
}

/**
 * Mengembalikan salinan objek dengan nilai key sensitif diganti [REDACTED].
 * Rekursif untuk objek/array bersarang; aman terhadap referensi siklik.
 */
export function redactSensitive<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  const obj = value as unknown as object;
  if (seen.has(obj)) return "[CYCLE]" as unknown as T;
  seen.add(obj);

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, seen)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = isSensitiveKey(key) ? REDACTED_VALUE : redactSensitive(entry, seen);
  }
  return result as T;
}
