/**
 * Provider signing-secret resolution for `payment_gateway` (Issue #877, ADR-0022
 * §3/§6). A provider account stores a POINTER `env:VAR_NAME` — never the secret
 * VALUE. This resolves the pointer against `process.env` at verify/dispatch
 * time. The resolved secret is NEVER returned in a response, persisted to a
 * table, logged, or audited — it lives only in the transient scope of an HMAC
 * computation. A missing/malformed pointer or an unset env var fails CLOSED
 * (the webhook is rejected, the dispatch is deferred) — it never falls back to a
 * literal or empty secret.
 */

const ENV_POINTER_RE = /^env:([A-Z][A-Z0-9_]*)$/;

export type SecretResolution =
  | { ok: true; value: string }
  | { ok: false; reason: "malformed_pointer" | "unset" };

/** Validate the pointer SHAPE only (never touches process.env) — reused by the config write path so a literal secret can never be stored. */
export function isValidSecretRefShape(ref: unknown): ref is string {
  return typeof ref === "string" && ENV_POINTER_RE.test(ref);
}

export function resolveSecretRef(
  ref: string,
  env: Record<string, string | undefined> = process.env
): SecretResolution {
  const match = typeof ref === "string" ? ENV_POINTER_RE.exec(ref) : null;
  if (!match) {
    return { ok: false, reason: "malformed_pointer" };
  }
  const value = env[match[1]!];
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, reason: "unset" };
  }
  return { ok: true, value };
}
