/**
 * Cloudflare Turnstile bot-protection adapter (Issue #588, epic: full-online
 * auth hardening #587-#593). Active only when the full-online security gate
 * (Issue #587, `../auth/online-security-config.ts`'s
 * `isFullOnlineSecurityActive`) is on AND `TURNSTILE_ENABLED=true` —
 * `isTurnstileRequired` below is the ONE function every gated endpoint
 * checks; local/offline/LAN deployments never call Cloudflare, never
 * require these env vars, and never change behavior.
 *
 * Verifies a client-submitted Turnstile response token against Cloudflare's
 * siteverify endpoint server-side (issue's own security note: "Verify token
 * server-side; client widget alone is not security"). Timeout-bounded
 * (`withTimeout`) and gated by a shared circuit breaker
 * (`getProviderCircuitBreaker("turnstile")`) — same pattern
 * `tenant-domain/infrastructure/cloudflare-dns-adapter.ts` and
 * `email/infrastructure/mailketing-provider.ts` already use for outbound
 * provider calls. Never opens or participates in a DB transaction (this
 * file has zero DB access) — callers run it before entering `withTenant`.
 */
import { getProviderCircuitBreaker } from "../database/circuit-breaker";
import { withTimeout } from "../integration/timeout";
import { isFullOnlineSecurityActive } from "../auth/online-security-config";
import { log } from "../logging/logger";

const PROVIDER_KEY = "turnstile";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_ERROR_MESSAGE_LENGTH = 300;
const DEFAULT_SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Env var names required only when `TURNSTILE_ENABLED=true`
 * (`scripts/validate-env.ts`'s `checkTurnstileConfig`). `TURNSTILE_SITE_KEY`
 * is not a secret (Cloudflare's own docs: it's embedded in the public HTML
 * widget), but the feature can't work without it either, so it's still
 * required-when-enabled — only `TURNSTILE_SECRET_KEY` needs the redaction
 * discipline `verifyTurnstileToken` above applies.
 */
export const TURNSTILE_REQUIRED_WHEN_ENABLED = [
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY"
] as const;

export type TurnstileConfig = {
  secretKey: string;
  /** Override for tests only — a local fake HTTP server standing in for Cloudflare's siteverify endpoint. Always from configuration, never request input (SSRF-safe, same convention as the Cloudflare DNS adapter's `baseUrl` override). */
  verifyUrl?: string;
  timeoutMs?: number;
};

export type TurnstileVerifyResult =
  { ok: true } | { ok: false; error: string; retryable: boolean };

type SiteverifyResponse = {
  success?: boolean;
  "error-codes"?: string[];
};

function truncate(message: string): string {
  return message.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`
    : message;
}

/**
 * Strips the configured secret out of `message` before it is ever returned
 * to a caller or logged — defense in depth against a thrown error
 * accidentally echoing part of the request. Same pattern as the Cloudflare
 * DNS adapter's own `redact()`.
 */
function redact(message: string, secrets: readonly string[]): string {
  let sanitized = message;

  for (const secret of secrets) {
    if (secret) {
      sanitized = sanitized.split(secret).join("[redacted]");
    }
  }

  return sanitized;
}

/**
 * Verifies `token` (the client-submitted Turnstile response, e.g. from the
 * widget's auto-injected `cf-turnstile-response` form field) against
 * Cloudflare's siteverify endpoint. `remoteIp`, if provided, is forwarded
 * per Cloudflare's own API (optional, improves their fraud scoring — never
 * required).
 */
export async function verifyTurnstileToken(
  token: string,
  config: TurnstileConfig,
  remoteIp?: string
): Promise<TurnstileVerifyResult> {
  const verifyUrl = config.verifyUrl ?? DEFAULT_SITEVERIFY_URL;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const breaker = getProviderCircuitBreaker(PROVIDER_KEY);
  const attemptedAt = new Date();
  const secrets = [config.secretKey];

  if (!breaker.canAttempt(attemptedAt)) {
    // Operationally significant: while open, `enforceTurnstileIfRequired`
    // fails closed and blocks every login/password-reset/setup request for
    // every tenant. Logged at `warning` so a sustained open breaker (real
    // Cloudflare outage) is distinguishable from normal traffic.
    log("warning", "turnstile.circuit_breaker_open");

    return {
      ok: false,
      error: "Turnstile circuit breaker is open; skipping attempt.",
      retryable: true
    };
  }

  const formData = new URLSearchParams();
  formData.set("secret", config.secretKey);
  formData.set("response", token);

  if (remoteIp) {
    formData.set("remoteip", remoteIp);
  }

  try {
    const response = await withTimeout(
      fetch(verifyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData.toString()
      }),
      timeoutMs,
      "turnstile siteverify"
    );

    const rawBody = await response.text().catch(() => "");
    let body: SiteverifyResponse | undefined;

    try {
      body = rawBody ? (JSON.parse(rawBody) as SiteverifyResponse) : undefined;
    } catch {
      body = undefined;
    }

    // Only a transport-level problem with Cloudflare itself (non-2xx HTTP
    // status, or a 2xx response we couldn't even parse) counts as a
    // *provider* failure for circuit-breaker purposes. A well-formed 2xx
    // response with `success: false` is Cloudflare correctly telling us the
    // client-submitted token was bad — the normal, expected, and trivially
    // attacker-repeatable outcome for a garbage/expired/reused token. Feeding
    // that into `recordFailure` would let anyone trip this shared,
    // cross-tenant breaker (and, since `enforceTurnstileIfRequired` fails
    // closed while it's open, lock out login/password-reset/setup for every
    // tenant) just by submitting a handful of invalid tokens — see PR #596
    // security review.
    if (response.status < 200 || response.status >= 300 || !body) {
      breaker.recordFailure(attemptedAt);
      log("warning", "turnstile.provider_call_failed", {
        httpStatus: response.status
      });

      return {
        ok: false,
        error: truncate(
          redact(
            `Turnstile provider call failed (HTTP ${response.status}).`,
            secrets
          )
        ),
        retryable: response.status >= 500 || response.status === 0
      };
    }

    if (!body.success) {
      breaker.recordSuccess(attemptedAt);

      return {
        ok: false,
        error: truncate(
          redact(
            `Turnstile token rejected (error codes: ${
              (body["error-codes"] ?? []).join(", ") || "none"
            }).`,
            secrets
          )
        ),
        retryable: false
      };
    }

    breaker.recordSuccess(attemptedAt);
    return { ok: true };
  } catch (error) {
    breaker.recordFailure(attemptedAt);
    const message = error instanceof Error ? error.message : String(error);
    log("warning", "turnstile.provider_call_errored", {
      error: redact(truncate(message), secrets)
    });

    return {
      ok: false,
      error: truncate(redact(message, secrets)),
      retryable: true
    };
  }
}

export function isTurnstileEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.TURNSTILE_ENABLED === "true";
}

export function resolveTurnstileTimeoutMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = Number(env.TURNSTILE_VERIFY_TIMEOUT_MS);

  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * The single boolean every one of the four gated endpoints
 * (`POST /auth/login`, `/auth/password/forgot`, `/auth/password/reset`,
 * `/setup/initialize`) must check before requiring/verifying a Turnstile
 * token — true only when BOTH the full-online security gate (Issue #587)
 * is active AND this feature's own flag is set. Matches this issue's
 * acceptance criterion "Turnstile is active only when #587 gate is enabled
 * and TURNSTILE_ENABLED=true."
 */
export function isTurnstileRequired(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return isFullOnlineSecurityActive(env) && isTurnstileEnabled(env);
}

/**
 * Builds a `TurnstileConfig` from env. Returns `null` if misconfigured
 * (enabled but missing the secret key) — never throws. Callers must treat
 * `null` as "cannot verify" and fail closed (reject the request), not as
 * "skip verification", since `isTurnstileRequired` already said this
 * deployment wants Turnstile enforced.
 */
export function resolveTurnstileConfig(
  env: NodeJS.ProcessEnv = process.env
): TurnstileConfig | null {
  const secretKey = env.TURNSTILE_SECRET_KEY;

  if (!secretKey) {
    return null;
  }

  return { secretKey, timeoutMs: resolveTurnstileTimeoutMs(env) };
}

export type TurnstileEnforcementResult =
  | { ok: true }
  | { ok: false; code: "TURNSTILE_REQUIRED" | "TURNSTILE_INVALID" };

/**
 * The one function every gated endpoint calls — consolidates the
 * "skip if not required / reject if missing / reject if misconfigured /
 * verify and reject if invalid" branching so it isn't duplicated four
 * times. `turnstileToken` is deliberately typed `unknown`: it comes
 * straight from an untrusted parsed JSON request body.
 */
export async function enforceTurnstileIfRequired(
  turnstileToken: unknown,
  remoteIp: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<TurnstileEnforcementResult> {
  if (!isTurnstileRequired(env)) {
    return { ok: true };
  }

  if (typeof turnstileToken !== "string" || turnstileToken.length === 0) {
    return { ok: false, code: "TURNSTILE_REQUIRED" };
  }

  const config = resolveTurnstileConfig(env);

  // Fail closed rather than silently skipping verification — a misconfigured
  // deployment (TURNSTILE_ENABLED=true but no secret key) should never be
  // indistinguishable from "verification passed" to the client. Reusing
  // TURNSTILE_INVALID (rather than a distinct code) avoids telling an
  // unauthenticated caller that the server is misconfigured.
  if (!config) {
    return { ok: false, code: "TURNSTILE_INVALID" };
  }

  const result = await verifyTurnstileToken(turnstileToken, config, remoteIp);

  if (!result.ok) {
    return { ok: false, code: "TURNSTILE_INVALID" };
  }

  return { ok: true };
}
