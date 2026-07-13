/**
 * Meta Graph API error normalization (Issue #644 acceptance criterion:
 * "Provider errors normalized into safe internal status/error codes";
 * security note: "Do not log full provider request/response bodies when
 * they may contain secrets or user/page identifiers beyond what's
 * needed"). Every `errorMessage` returned here is a FIXED, generic string
 * from a small hand-written catalog below — Meta's own `error.message`
 * text is NEVER passed through verbatim, even though it is typically safe
 * descriptive text, because the issue explicitly asks for identifiers
 * "beyond what's needed" to be kept out, and a fixed catalog gives that
 * guarantee unconditionally rather than trusting a third party's response
 * shape/content forever. The numeric `error.code`/`error.error_subcode`
 * Meta returns IS included in the internal `errorCode` string (e.g.
 * `"meta_oauth_exception_190"`) for operator grep-ability — those are
 * small stable integers Meta documents publicly, not secrets.
 *
 * Reference: Meta's own documented error code families
 * (developers.facebook.com/docs/graph-api/guides/error-handling) —
 * 190/`OAuthException` (invalid/expired token), 10/200-299 (permissions),
 * 4/17/32/613 (rate limiting). This is a best-effort mapping of the
 * families this adapter's two actions can realistically hit, not an
 * exhaustive implementation of Meta's entire error catalog.
 */
import type { SocialProviderPublishFailure } from "./social-provider-adapter";

const OAUTH_ERROR_CODE = 190;
const PERMISSION_ERROR_CODES = new Set([10, 200, 210, 299]);
const RATE_LIMIT_ERROR_CODES = new Set([4, 17, 32, 613]);
const DEFAULT_RATE_LIMIT_RETRY_AFTER_SECONDS = 60;

type MetaErrorShape = {
  code?: number;
  subcode?: number;
  type?: string;
};

function extractMetaErrorShape(body: unknown): MetaErrorShape | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const errorField = (body as Record<string, unknown>).error;

  if (!errorField || typeof errorField !== "object") {
    return null;
  }

  const errorRecord = errorField as Record<string, unknown>;

  return {
    code: typeof errorRecord.code === "number" ? errorRecord.code : undefined,
    subcode:
      typeof errorRecord.error_subcode === "number"
        ? errorRecord.error_subcode
        : undefined,
    type: typeof errorRecord.type === "string" ? errorRecord.type : undefined
  };
}

function codeSuffix(error: MetaErrorShape | null): string {
  return error?.code !== undefined ? `_${error.code}` : "";
}

/**
 * Never throws. `httpStatus` is used only when the response body has no
 * recognizable Meta error shape at all (e.g. a proxy/CDN error page).
 */
export function normalizeMetaGraphApiError(
  httpStatus: number,
  errorBody: unknown
): SocialProviderPublishFailure {
  const error = extractMetaErrorShape(errorBody);

  if (error?.code === OAUTH_ERROR_CODE || error?.type === "OAuthException") {
    return {
      outcome: "needs_reauth",
      errorCode: `meta_oauth_exception${codeSuffix(error)}`,
      errorMessage:
        "Meta access token is invalid, expired, or was revoked. Reconnect this account.",
      retryable: false
    };
  }

  if (error?.code !== undefined && PERMISSION_ERROR_CODES.has(error.code)) {
    return {
      outcome: "needs_reauth",
      errorCode: `meta_permission_error${codeSuffix(error)}`,
      errorMessage:
        "Meta reports insufficient permissions for this action. Reconnect with the required scopes.",
      retryable: false
    };
  }

  if (error?.code !== undefined && RATE_LIMIT_ERROR_CODES.has(error.code)) {
    return {
      outcome: "rate_limited",
      errorCode: `meta_rate_limited${codeSuffix(error)}`,
      errorMessage: "Meta API rate limit reached.",
      retryable: true,
      retryAfterSeconds: DEFAULT_RATE_LIMIT_RETRY_AFTER_SECONDS
    };
  }

  if (httpStatus >= 500) {
    return {
      outcome: "failed",
      errorCode: "meta_server_error",
      errorMessage: "Meta API returned a server error.",
      retryable: true
    };
  }

  if (httpStatus === 429) {
    return {
      outcome: "rate_limited",
      errorCode: "meta_http_429",
      errorMessage: "Meta API rate limit reached.",
      retryable: true,
      retryAfterSeconds: DEFAULT_RATE_LIMIT_RETRY_AFTER_SECONDS
    };
  }

  return {
    outcome: "failed",
    errorCode: error ? `meta_api_error${codeSuffix(error)}` : "meta_api_error",
    errorMessage: "Meta API rejected the request.",
    retryable: false
  };
}
