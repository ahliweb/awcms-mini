/**
 * Privacy-first configuration gate for the `visitor_analytics` module
 * (Issue #617, epic: visitor analytics #617-#624). Pure — no
 * `process.env` reads here; `scripts/validate-env.ts` passes in whatever
 * `env` it was given, same split as `email/domain/email-config.ts` and
 * `tenant-domain/domain/tenant-domain-dns-config.ts`.
 *
 * This file only resolves/validates the env-var shape. It does not
 * collect, store, or process any visitor data — that is later issues:
 * schema (#618), identity/UA/bot classification (#619), the middleware
 * collector (#620), the API (#621), geolocation enrichment (#623), and
 * rollup/retention (#624).
 *
 * `VISITOR_ANALYTICS_MODE=basic` is the privacy-first default: raw IP,
 * raw user-agent, and geolocation collection are all disabled by
 * default and require an explicit opt-in env var, independent of
 * `VISITOR_ANALYTICS_MODE` itself (the mode only distinguishes
 * aggregate-only `basic` collection from a future `detailed` mode with
 * richer session/event granularity — it never implies the raw-detail
 * flags below turn on by itself).
 */
export const VISITOR_ANALYTICS_MODES = ["basic", "detailed"] as const;

export type VisitorAnalyticsMode = (typeof VISITOR_ANALYTICS_MODES)[number];

export function isKnownVisitorAnalyticsMode(
  value: string | undefined
): value is VisitorAnalyticsMode {
  return (VISITOR_ANALYTICS_MODES as readonly string[]).includes(value ?? "");
}

export type VisitorAnalyticsConfig = {
  enabled: boolean;
  mode: VisitorAnalyticsMode;
  collectAdmin: boolean;
  collectPublic: boolean;
  collectApi: boolean;
  detailedEnabled: boolean;
  rawIpEnabled: boolean;
  rawUserAgentEnabled: boolean;
  geoEnabled: boolean;
  trustProxy: boolean;
  trustCloudflare: boolean;
  onlineWindowSeconds: number;
  eventRetentionDays: number;
  rawDetailRetentionDays: number;
  rollupRetentionDays: number;
  hashSalt: string;
};

/** Safe defaults matching the issue's `.env.example` block exactly. */
export const VISITOR_ANALYTICS_DEFAULTS: VisitorAnalyticsConfig = {
  enabled: true,
  mode: "basic",
  collectAdmin: true,
  collectPublic: true,
  collectApi: false,
  detailedEnabled: false,
  rawIpEnabled: false,
  rawUserAgentEnabled: false,
  geoEnabled: false,
  trustProxy: false,
  trustCloudflare: false,
  onlineWindowSeconds: 300,
  eventRetentionDays: 90,
  rawDetailRetentionDays: 30,
  rollupRetentionDays: 730,
  hashSalt: ""
};

/**
 * The env var names whose value must parse as a positive integer when
 * set — checked by `checkVisitorAnalyticsConfig` in
 * `scripts/validate-env.ts` and reused here so both files agree on
 * exactly which keys are "positive integer" shaped.
 */
export const VISITOR_ANALYTICS_POSITIVE_INT_VARS = [
  "VISITOR_ANALYTICS_ONLINE_WINDOW_SECONDS",
  "VISITOR_ANALYTICS_EVENT_RETENTION_DAYS",
  "VISITOR_ANALYTICS_RAW_DETAIL_RETENTION_DAYS",
  "VISITOR_ANALYTICS_ROLLUP_RETENTION_DAYS"
] as const;

function isSet(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!isSet(value)) return fallback;
  return value === "true";
}

/** `undefined` when unset/blank/non-positive-integer — never throws, never NaN. */
export function parsePositiveInt(
  value: string | undefined
): number | undefined {
  if (!isSet(value)) return undefined;

  const trimmed = (value as string).trim();

  if (!/^\d+$/.test(trimmed)) return undefined;

  const parsed = Number.parseInt(trimmed, 10);

  return parsed > 0 ? parsed : undefined;
}

/**
 * Resolves the full config from `env`, falling back to
 * `VISITOR_ANALYTICS_DEFAULTS` for anything unset or malformed. Never
 * throws — malformed numeric values are reported by
 * `checkVisitorAnalyticsConfig` (`scripts/validate-env.ts`), not here;
 * this resolver always returns a usable config so later issues (#619,
 * #620) can call it unconditionally.
 */
export function resolveVisitorAnalyticsConfig(
  env: NodeJS.ProcessEnv = process.env
): VisitorAnalyticsConfig {
  const modeRaw = env.VISITOR_ANALYTICS_MODE;

  return {
    enabled: parseBoolean(
      env.VISITOR_ANALYTICS_ENABLED,
      VISITOR_ANALYTICS_DEFAULTS.enabled
    ),
    mode: isKnownVisitorAnalyticsMode(modeRaw)
      ? modeRaw
      : VISITOR_ANALYTICS_DEFAULTS.mode,
    collectAdmin: parseBoolean(
      env.VISITOR_ANALYTICS_COLLECT_ADMIN,
      VISITOR_ANALYTICS_DEFAULTS.collectAdmin
    ),
    collectPublic: parseBoolean(
      env.VISITOR_ANALYTICS_COLLECT_PUBLIC,
      VISITOR_ANALYTICS_DEFAULTS.collectPublic
    ),
    collectApi: parseBoolean(
      env.VISITOR_ANALYTICS_COLLECT_API,
      VISITOR_ANALYTICS_DEFAULTS.collectApi
    ),
    detailedEnabled: parseBoolean(
      env.VISITOR_ANALYTICS_DETAILED_ENABLED,
      VISITOR_ANALYTICS_DEFAULTS.detailedEnabled
    ),
    rawIpEnabled: parseBoolean(
      env.VISITOR_ANALYTICS_RAW_IP_ENABLED,
      VISITOR_ANALYTICS_DEFAULTS.rawIpEnabled
    ),
    rawUserAgentEnabled: parseBoolean(
      env.VISITOR_ANALYTICS_RAW_USER_AGENT_ENABLED,
      VISITOR_ANALYTICS_DEFAULTS.rawUserAgentEnabled
    ),
    geoEnabled: parseBoolean(
      env.VISITOR_ANALYTICS_GEO_ENABLED,
      VISITOR_ANALYTICS_DEFAULTS.geoEnabled
    ),
    trustProxy: parseBoolean(
      env.VISITOR_ANALYTICS_TRUST_PROXY,
      VISITOR_ANALYTICS_DEFAULTS.trustProxy
    ),
    trustCloudflare: parseBoolean(
      env.VISITOR_ANALYTICS_TRUST_CLOUDFLARE,
      VISITOR_ANALYTICS_DEFAULTS.trustCloudflare
    ),
    onlineWindowSeconds:
      parsePositiveInt(env.VISITOR_ANALYTICS_ONLINE_WINDOW_SECONDS) ??
      VISITOR_ANALYTICS_DEFAULTS.onlineWindowSeconds,
    eventRetentionDays:
      parsePositiveInt(env.VISITOR_ANALYTICS_EVENT_RETENTION_DAYS) ??
      VISITOR_ANALYTICS_DEFAULTS.eventRetentionDays,
    rawDetailRetentionDays:
      parsePositiveInt(env.VISITOR_ANALYTICS_RAW_DETAIL_RETENTION_DAYS) ??
      VISITOR_ANALYTICS_DEFAULTS.rawDetailRetentionDays,
    rollupRetentionDays:
      parsePositiveInt(env.VISITOR_ANALYTICS_ROLLUP_RETENTION_DAYS) ??
      VISITOR_ANALYTICS_DEFAULTS.rollupRetentionDays,
    hashSalt:
      env.VISITOR_ANALYTICS_HASH_SALT ?? VISITOR_ANALYTICS_DEFAULTS.hashSalt
  };
}

/**
 * The single boolean every later issue (#619 identity helpers, #620
 * middleware collector) should gate real work on — mirrors
 * `isFullOnlineSecurityActive`'s role in `online-security-config.ts`.
 */
export function isVisitorAnalyticsEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return resolveVisitorAnalyticsConfig(env).enabled;
}
