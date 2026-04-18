export const DEFAULT_DATABASE_URL = "postgres://localhost:5432/awcms_mini_dev";
export const DEFAULT_RUNTIME_TARGET = "cloudflare";
export const DEFAULT_TRUSTED_PROXY_MODE = "direct";
export const DEFAULT_R2_MEDIA_BUCKET_BINDING = "MEDIA_BUCKET";
export const DEFAULT_R2_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const DEFAULT_EDGE_API_MAX_BODY_BYTES = 16 * 1024;
export const DEFAULT_EDGE_API_JWT_AUDIENCE = "awcms-mini-edge-api";
export const DEFAULT_EDGE_API_JWT_ISSUER = "urn:awcms-mini:edge-api";
export const DEFAULT_EDGE_API_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const DEFAULT_EDGE_API_REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

function normalizeSiteUrl(value) {
  if (typeof value !== "string") {
    return null;
  }

  const next = value.trim();
  return next.length > 0 ? next : null;
}

function normalizeRuntimeTarget(value) {
  return ["cloudflare", "node"].includes(value) ? value : DEFAULT_RUNTIME_TARGET;
}

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const next = value.trim();
  return next.length > 0 ? next : null;
}

function normalizeTurnstileExpectedHostname(value, siteUrl) {
  const explicit = normalizeOptionalString(value);

  if (explicit) {
    return explicit;
  }

  if (!siteUrl) {
    return null;
  }

  try {
    return new URL(siteUrl).hostname || null;
  } catch {
    return null;
  }
}

function normalizePositiveInteger(value, fallback) {
  const next = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(next) && next > 0 ? next : fallback;
}

function normalizeCommaSeparatedList(value, fallback = []) {
  if (typeof value !== "string") {
    return fallback;
  }

  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries.length > 0 ? entries : fallback;
}

function normalizeEdgeApiJwtIssuer(value, siteUrl) {
  const explicit = normalizeOptionalString(value);

  if (explicit) {
    return explicit;
  }

  if (!siteUrl) {
    return DEFAULT_EDGE_API_JWT_ISSUER;
  }

  try {
    return new URL("/api/v1", siteUrl).toString();
  } catch {
    return DEFAULT_EDGE_API_JWT_ISSUER;
  }
}

export function getRuntimeConfig() {
  const siteUrl = normalizeSiteUrl(process.env.SITE_URL);
  const appSecret = normalizeOptionalString(process.env.APP_SECRET);
  const turnstileSecretKey = normalizeOptionalString(process.env.TURNSTILE_SECRET_KEY);
  const turnstileSiteKey = normalizeOptionalString(process.env.TURNSTILE_SITE_KEY);
  const edgeApiJwtSecret = normalizeOptionalString(process.env.EDGE_API_JWT_SECRET) || appSecret;

  return {
    databaseUrl: process.env.DATABASE_URL || DEFAULT_DATABASE_URL,
    runtimeTarget: normalizeRuntimeTarget(process.env.MINI_RUNTIME_TARGET),
    siteUrl,
    appSecret,
    miniTotpEncryptionKey: process.env.MINI_TOTP_ENCRYPTION_KEY || null,
    trustedProxyMode: process.env.TRUSTED_PROXY_MODE || DEFAULT_TRUSTED_PROXY_MODE,
    turnstile: {
      siteKey: turnstileSiteKey,
      secretKey: turnstileSecretKey,
      enabled: Boolean(turnstileSecretKey),
      expectedHostname: normalizeTurnstileExpectedHostname(process.env.TURNSTILE_EXPECTED_HOSTNAME, siteUrl),
    },
    r2: {
      mediaBucketBinding: normalizeOptionalString(process.env.R2_MEDIA_BUCKET_BINDING) || DEFAULT_R2_MEDIA_BUCKET_BINDING,
      mediaBucketName: normalizeOptionalString(process.env.R2_MEDIA_BUCKET_NAME),
      maxUploadBytes: normalizePositiveInteger(process.env.R2_MAX_UPLOAD_BYTES, DEFAULT_R2_MAX_UPLOAD_BYTES),
      allowedContentTypes: normalizeCommaSeparatedList(process.env.R2_ALLOWED_CONTENT_TYPES, ["image/jpeg", "image/png", "image/webp", "application/pdf"]),
    },
    edgeApi: {
      allowedOrigins: normalizeCommaSeparatedList(process.env.EDGE_API_ALLOWED_ORIGINS, []),
      maxBodyBytes: normalizePositiveInteger(process.env.EDGE_API_MAX_BODY_BYTES, DEFAULT_EDGE_API_MAX_BODY_BYTES),
      jwt: {
        secret: edgeApiJwtSecret,
        enabled: Boolean(edgeApiJwtSecret),
        issuer: normalizeEdgeApiJwtIssuer(process.env.EDGE_API_JWT_ISSUER, siteUrl),
        audience: normalizeOptionalString(process.env.EDGE_API_JWT_AUDIENCE) || DEFAULT_EDGE_API_JWT_AUDIENCE,
        accessTokenTtlSeconds: normalizePositiveInteger(
          process.env.EDGE_API_ACCESS_TOKEN_TTL_SECONDS,
          DEFAULT_EDGE_API_ACCESS_TOKEN_TTL_SECONDS,
        ),
        refreshTokenTtlSeconds: normalizePositiveInteger(
          process.env.EDGE_API_REFRESH_TOKEN_TTL_SECONDS,
          DEFAULT_EDGE_API_REFRESH_TOKEN_TTL_SECONDS,
        ),
      },
    },
  };
}
