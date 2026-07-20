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

export type BodySizeTier = "default" | "large" | "webhook";

/**
 * `default` (128 KiB) covers ordinary CRUD/settings/auth JSON bodies —
 * including `sync/pull`, whose body is only an optional `{ limit? }`.
 * `large` (5 MiB) covers content-heavy endpoints (blog post/page/template/
 * theme HTML, email templates, news-portal homepage sections) and the
 * batched `sync/push`/`sync/objects` payloads — sized generously enough
 * for legitimate use without approaching the hard ceiling. Media/upload
 * endpoints (`media/news-images/upload-sessions/*`) stay on `default`:
 * they only ever exchange small JSON (object keys, checksums) — the
 * actual image bytes go straight to R2 via a presigned URL, never through
 * an Astro handler (`docs/awcms-mini/news-portal/full-online-r2-architecture.md`
 * §3.3/§3.4 "no local fallback, no temp file").
 */
export const BODY_SIZE_TIER_BYTES: Record<BodySizeTier, number> = {
  default: 128 * 1024,
  large: 5 * 1024 * 1024,
  // `webhook` (1 MiB) is the tier for signed inbound PROVIDER webhook receivers
  // (e.g. `payment-gateway/webhook/{providerAccountId}`), which are
  // UNAUTHENTICATED at the transport edge (no tenant JWT). It is aligned with the
  // per-account `max_webhook_body_bytes` DB hard-cap (<= 1 MiB, sql/093): a much
  // stricter buffering ceiling than `large` so a hostile caller cannot make the
  // receiver buffer a multi-MiB body before the per-account limit rejects it
  // (DoS/storage-surface reduction). 1 MiB == the DB cap, so no legitimate,
  // per-account-permitted body is ever wrongly rejected here.
  webhook: 1024 * 1024
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

/**
 * Result of {@link readJsonObjectBody}. `ok: false` carries `reason` so the
 * handler can say which of the rejected shapes arrived instead of a generic
 * "invalid body".
 */
export type InvalidJsonObjectBodyReason = "absent" | "malformed" | "not_object";

export type JsonObjectBodyResult =
  | { tooLarge: true; limitBytes: number }
  | { tooLarge: false; ok: true; value: Record<string, unknown> }
  | { tooLarge: false; ok: false; reason: InvalidJsonObjectBodyReason };

/**
 * `readJsonBody` collapses "absent body", "malformed JSON" and "the literal
 * `null`" into the same `value: null`, and passes a well-formed array/number/
 * string straight through. Handlers that require a JSON *object* cannot tell
 * those apart, so they reach for `bodyRead.value ?? {}` — which silently turns
 * an empty, malformed, or non-object body into a valid empty request. For a
 * PATCH whose empty body is a legitimate no-op that is not a harmless default:
 * garbage passes authorization and idempotency and lands as a real write.
 *
 * Use this instead whenever the endpoint's request body is a required JSON
 * object. `{}` is returned as `ok: true` — an empty *object* is a real body,
 * distinct from no body at all.
 */
export async function readJsonObjectBody(
  request: Request,
  tier: BodySizeTier = "default"
): Promise<JsonObjectBodyResult> {
  const limitBytes = resolveLimitBytes(tier);
  const textResult = await readCappedText(request, limitBytes);

  if (textResult.tooLarge) {
    return { tooLarge: true, limitBytes };
  }

  if (textResult.text.trim().length === 0) {
    return { tooLarge: false, ok: false, reason: "absent" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(textResult.text);
  } catch {
    return { tooLarge: false, ok: false, reason: "malformed" };
  }

  // `typeof null === "object"`, and arrays are objects too — both must be
  // rejected here rather than reaching a field-by-field patch parser, which
  // would find no known keys on them and report a clean empty patch.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { tooLarge: false, ok: false, reason: "not_object" };
  }

  return {
    tooLarge: false,
    ok: true,
    value: parsed as Record<string, unknown>
  };
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

/**
 * The standard `413` response for any `tooLarge: true` result above.
 *
 * Always sends `Connection: close` — security-auditor review of PR #704
 * (Issue #686) found that on a real HTTP/1.1 keep-alive connection, an
 * oversized request's body is abandoned mid-stream (never drained to its
 * end), which desyncs the connection: Node's HTTP parser then reads the
 * client's NEXT, unrelated, perfectly valid request as leftover garbage
 * from the first one and returns it a spurious `400 Bad Request`. This
 * only reproduces against a real socket (`tests/integration/...` uses an
 * in-process harness that never touches HTTP framing, so it can't catch
 * this) — `Connection: close` tells the client to open a fresh connection
 * instead of reusing this now-desynced one, closing that gap.
 */
export function bodyTooLargeResponse(limitBytes: number): Response {
  return fail(
    413,
    "PAYLOAD_TOO_LARGE",
    `Request body exceeds the maximum allowed size of ${limitBytes} bytes.`,
    {},
    undefined,
    { connection: "close" }
  );
}

const INVALID_JSON_OBJECT_BODY_MESSAGE: Record<
  InvalidJsonObjectBodyReason,
  string
> = {
  absent: "A JSON object request body is required; none was sent.",
  malformed: "Request body is not valid JSON.",
  not_object:
    "Request body must be a JSON object. Send {} for a no-op; null, arrays and scalars are not accepted."
};

/**
 * Maps a {@link readJsonObjectBody} rejection to the `400` the endpoint's
 * required-object request body implies. Kept next to the reader so a new
 * `reason` cannot be added without the compiler demanding a message for it.
 */
export function invalidJsonObjectBodyResponse(
  reason: InvalidJsonObjectBodyReason
): Response {
  return fail(
    400,
    "VALIDATION_ERROR",
    INVALID_JSON_OBJECT_BODY_MESSAGE[reason]
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
