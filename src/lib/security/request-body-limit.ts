/**
 * Shared capped request-body reader (Issue #686, epic #679, platform-
 * hardening). Most `/api/*` handlers previously called `request.json()`/
 * `request.text()` directly with no application-level size cap — a
 * reverse-proxy `client_max_body_size` protects nothing for direct/local
 * access (offline/LAN deployments, doc 18), and does nothing for a request
 * that lies about `Content-Length` or streams via chunked transfer
 * encoding. This module is the ONE place body-size enforcement lives:
 * every handler that reads a body should go through `readJsonBody`/
 * `readTextBody` here instead of calling `request.json()`/`.text()`
 * directly.
 *
 * Two layers of defense, both enforced by the same function:
 * 1. `Content-Length` header, when present, is checked BEFORE any byte is
 *    read — an honestly-oversized declared body is rejected with zero
 *    stream consumption.
 * 2. The body stream itself is read in chunks with a running byte count,
 *    so a request that omits `Content-Length` (or lies — declares a small
 *    value, then streams more) is still capped: the read aborts
 *    (`reader.cancel()`) the instant the running total exceeds the limit,
 *    before the oversized payload is ever fully buffered in memory.
 *
 * Deliberately NOT implemented as Astro middleware wrapping/rewriting
 * `context.request` (a `next(request)` call in Astro middleware triggers
 * `pipeline.tryRewrite` — real route re-matching overhead per request,
 * intended for i18n-style internal rewrites, not a transparent per-request
 * body transform) — a plain function each handler calls explicitly is the
 * same shape as this codebase's other opt-in security checks
 * (`checkRateLimit`, `enforceTurnstileIfRequired`), and lets each endpoint
 * pick its own size tier.
 *
 * `checkContentLengthCeiling` (used by `src/middleware.ts`) is a SEPARATE,
 * cheap, global-only backstop: it rejects any `/api/*` request whose
 * declared `Content-Length` exceeds `BODY_SIZE_HARD_CEILING_BYTES` before
 * the request even reaches a route handler — defense-in-depth for any
 * future endpoint that forgets to call the reader below, not a
 * replacement for it (it cannot catch a chunked/no-`Content-Length` body,
 * only a declared one).
 */
import { fail } from "../../modules/_shared/api-response";

export type BodySizeTier = "default" | "large";

/**
 * `default` (128 KiB) covers ordinary CRUD/settings/auth JSON bodies.
 * `large` (5 MiB) covers content-heavy endpoints (blog post/page/template/
 * theme HTML, email templates, news-portal homepage sections) and batched
 * sync payloads (`sync/push`, `sync/pull`) — sized generously enough for
 * legitimate use without approaching the hard ceiling. Media/upload
 * endpoints (`media/news-images/upload-sessions/*`) stay on `default`:
 * they only ever exchange small JSON (object keys, checksums) — the
 * actual image bytes go straight to R2 via a presigned URL, never through
 * an Astro handler (`docs/awcms-mini/news-portal/full-online-r2-architecture.md`
 * §3.3/§3.4 "no local fallback, no temp file").
 */
export const BODY_SIZE_TIER_BYTES: Record<BodySizeTier, number> = {
  default: 128 * 1024,
  large: 5 * 1024 * 1024
};

/**
 * No tier may exceed this without an explicit, reviewed change to this
 * constant itself (acceptance criterion: "Endpoint overrides cannot
 * exceed the documented hard ceiling without explicit review") — enforced
 * by `tests/unit/request-body-limit.test.ts`, not just documented here.
 * Matches `NEWS_MEDIA_R2_MAX_UPLOAD_BYTES`'s existing 10 MiB default
 * (doc 18 §News portal) for a consistent order of magnitude across the
 * codebase's two size-limit conventions.
 */
export const BODY_SIZE_HARD_CEILING_BYTES = 10 * 1024 * 1024;

export type BodyReadResult<T> =
  { tooLarge: false; value: T } | { tooLarge: true; limitBytes: number };

function resolveLimitBytes(tier: BodySizeTier): number {
  return BODY_SIZE_TIER_BYTES[tier];
}

function parseDeclaredLength(request: Request): number | null {
  const header = request.headers.get("content-length");

  if (header === null) {
    return null;
  }

  const parsed = Number(header);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Reads the full body as text, capped at `limitBytes`. Never throws for a
 * "too large" outcome (that's the `tooLarge: true` branch) — only a
 * genuine stream error propagates as a rejected promise, same as
 * `request.text()` would.
 */
async function readCappedText(
  request: Request,
  limitBytes: number
): Promise<{ tooLarge: false; text: string } | { tooLarge: true }> {
  const declaredLength = parseDeclaredLength(request);

  if (declaredLength !== null && declaredLength > limitBytes) {
    return { tooLarge: true };
  }

  const body = request.body;

  if (!body) {
    return { tooLarge: false, text: "" };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    total += value.byteLength;

    if (total > limitBytes) {
      await reader.cancel().catch(() => {});
      return { tooLarge: true };
    }

    chunks.push(value);
  }

  const combined = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { tooLarge: false, text: new TextDecoder().decode(combined) };
}

/**
 * Drop-in replacement for `await request.json().catch(() => null)`:
 * `value` is `null` for an empty or malformed body (same as the old
 * pattern — callers keep passing it straight into their existing
 * validator, which already treats `null` as invalid input), and the
 * `tooLarge: true` branch is the ONE new case callers must check first
 * and map to a `413`, via `bodyTooLargeResponse` below.
 */
export async function readJsonBody<T = unknown>(
  request: Request,
  tier: BodySizeTier = "default"
): Promise<BodyReadResult<T | null>> {
  const limitBytes = resolveLimitBytes(tier);
  const textResult = await readCappedText(request, limitBytes);

  if (textResult.tooLarge) {
    return { tooLarge: true, limitBytes };
  }

  if (textResult.text.length === 0) {
    return { tooLarge: false, value: null };
  }

  try {
    return { tooLarge: false, value: JSON.parse(textResult.text) as T };
  } catch {
    return { tooLarge: false, value: null };
  }
}

/** Drop-in replacement for `await request.text()`, capped at `tier`'s limit. */
export async function readTextBody(
  request: Request,
  tier: BodySizeTier = "default"
): Promise<BodyReadResult<string>> {
  const limitBytes = resolveLimitBytes(tier);
  const textResult = await readCappedText(request, limitBytes);

  if (textResult.tooLarge) {
    return { tooLarge: true, limitBytes };
  }

  return { tooLarge: false, value: textResult.text };
}

/**
 * Drop-in replacement for `await request.formData()`, capped at `tier`'s
 * limit. No handler uses this yet (no endpoint accepts
 * `multipart/form-data` or `application/x-www-form-urlencoded` today —
 * confirmed by grep across `src/pages/api/`), but the issue's scope
 * explicitly names form/multipart support as part of the shared reader;
 * provided now so a future form-accepting endpoint doesn't have to
 * reinvent this. Reuses the same capped-text read, then re-parses via a
 * synthetic `Request` — `FormData` parsing itself has no separate
 * size-relevant step once the bytes are already capped.
 */
export async function readFormBody(
  request: Request,
  tier: BodySizeTier = "default"
): Promise<BodyReadResult<FormData | null>> {
  const limitBytes = resolveLimitBytes(tier);
  const textResult = await readCappedText(request, limitBytes);

  if (textResult.tooLarge) {
    return { tooLarge: true, limitBytes };
  }

  const contentType = request.headers.get("content-type") ?? "";

  try {
    const synthetic = new Request(request.url, {
      method: request.method,
      headers: { "content-type": contentType },
      body: textResult.text
    });

    return { tooLarge: false, value: await synthetic.formData() };
  } catch {
    return { tooLarge: false, value: null };
  }
}

/** The standard `413` response for any `tooLarge: true` result above. */
export function bodyTooLargeResponse(limitBytes: number): Response {
  return fail(
    413,
    "PAYLOAD_TOO_LARGE",
    `Request body exceeds the maximum allowed size of ${limitBytes} bytes.`
  );
}

/**
 * Cheap, global-only pre-check for `src/middleware.ts` — see this file's
 * header for why this is a separate backstop, not the primary
 * enforcement mechanism. Only ever compares against the HARD ceiling
 * (never a per-endpoint tier — middleware has no route-specific
 * knowledge), so it can only reject requests no tier would ever have
 * accepted anyway; it never rejects a request a correctly-tiered handler
 * would have allowed.
 */
export function checkContentLengthCeiling(request: Request): boolean {
  const declaredLength = parseDeclaredLength(request);

  return (
    declaredLength === null || declaredLength <= BODY_SIZE_HARD_CEILING_BYTES
  );
}
