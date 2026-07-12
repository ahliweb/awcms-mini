/**
 * validate-env.ts — `bun run config:validate`.
 *
 * Issue 12.2 (doc 18 §Prinsip konfigurasi #5 "Konfigurasi tervalidasi saat
 * boot; nilai wajib yang hilang menghentikan start dengan pesan jelas",
 * doc 18 §"Referensi environment variable", doc 18 §"Validasi konfigurasi
 * saat boot"). Validates the environment (as loaded by Bun's built-in
 * `.env` support — the same mechanism every other script in this repo
 * relies on, e.g. `scripts/security-readiness.ts` reading
 * `process.env.DATABASE_URL` directly) against doc 18's variable table:
 *
 *  1. Required, must be non-empty: APP_ENV, APP_URL, APP_TIMEZONE,
 *     DATABASE_URL, AUTH_JWT_SECRET.
 *  2. Conditional: if AWCMS_MINI_SYNC_ENABLED === "true", then
 *     AWCMS_MINI_SYNC_HMAC_SECRET must be set and not left at the
 *     `.env.example` placeholder ("change-me"). This reuses
 *     `checkSyncHmacSecretNotDefault` from `security-readiness.ts` (Issue
 *     10.3) verbatim rather than re-implementing the placeholder-detection
 *     logic a second, divergent way — its `status` field (not its
 *     `severity`, which is scoped to that script's own go-live gate) is
 *     what decides pass/fail here.
 *  3. Conditional: if R2_ENABLED === "true", then R2_ACCOUNT_ID,
 *     R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET must all be
 *     set. These four vars are not in the current minimal `.env.example`
 *     (doc 18 documents them as "bila R2" in its fuller reference table) —
 *     that's fine, they are validated conditionally regardless of whether
 *     `.env.example` carries commented-out placeholders for them.
 *  4. Conditional (Issue #493, epic #492): if EMAIL_ENABLED === "true",
 *     then EMAIL_FROM_ADDRESS must be set, EMAIL_PROVIDER must be one of
 *     `KNOWN_EMAIL_PROVIDERS` (`../src/modules/email/domain/email-config`),
 *     and — when EMAIL_PROVIDER === "mailketing" — EMAIL_MAILKETING_ACCOUNT_ID,
 *     EMAIL_MAILKETING_API_TOKEN, and EMAIL_MAILKETING_API_BASE_URL must all
 *     be set. Mirrors the R2 conditional check above; see
 *     `src/modules/email/README.md` for why these vars are namespaced
 *     `EMAIL_*`/`EMAIL_MAILKETING_*` rather than the illustrative
 *     `MAILKETING_*` rows in doc 18 §Provider CRM (opsional).
 *  5. Public tenant routing (Issue #556, epic #555, config-only — no
 *     tenant-domain schema/resolver/routes here yet):
 *       - PUBLIC_TENANT_RESOLUTION_MODE, if set, must be one of
 *         `PUBLIC_TENANT_RESOLUTION_MODES`. Left unset it is *not* an
 *         error — that is the backward-compatible default every existing
 *         offline/LAN deployment already runs (today's only public route
 *         is the legacy `/blog/{tenantCode}` path; see doc 18 §Public
 *         routing and `deployment-profiles.md`).
 *       - mode === "host_default" requires PUBLIC_PLATFORM_ROOT_DOMAIN:
 *         the host-based resolver landing in Issue #559 needs a root
 *         domain to tell a tenant subdomain apart from an unrelated host.
 *       - mode === "env_default" requires at least one of
 *         PUBLIC_DEFAULT_TENANT_ID / PUBLIC_DEFAULT_TENANT_CODE.
 *       - mode === "setup_default" / "tenant_code_legacy" need no extra
 *         var here (setup_default's default tenant lives in DB via the
 *         Setup Wizard; tenant_code_legacy needs nothing because it
 *         explicitly disables default-tenant guessing altogether — see
 *         below). This is a config-shape statement only (no *extra*
 *         required var for either mode); it does not claim the two modes
 *         behave the same at runtime.
 *       - `tenant_code_legacy` is NOT simply "leave PUBLIC_TENANT_RESOLUTION_MODE
 *         unset" under a different name, despite both needing no extra var
 *         here. Decided explicitly in Issue #560 (an ambiguity two Issue
 *         #559 reviewers flagged): `resolvePublicTenantFromRequest()`
 *         (`src/lib/tenant/public-host-tenant-resolver.ts`) returns `null`
 *         unconditionally for `tenant_code_legacy` — it never falls back to
 *         `PUBLIC_DEFAULT_TENANT_ID`/`_CODE`/the setup-wizard tenant either
 *         — because this mode means the operator explicitly opted OUT of
 *         any default-tenant guess (every route must carry its own
 *         `tenantCode`, which `/blog/{tenantCode}` does and `/news`, Issue
 *         #560, structurally cannot). Leaving the var unset, by contrast,
 *         still runs the full safe-fallback chain for `/news` — that
 *         deployment never made an explicit "no default tenant" choice.
 *       - PUBLIC_CANONICAL_BASE_PATH, if set, must be an absolute path
 *         (leading "/", no whitespace, no trailing slash unless it is
 *         exactly "/", no "//"). Left unset it defaults to `/news`
 *         at the code level (not enforced here, same convention as other
 *         defaulted vars like AUDIT_LOG_RETENTION_DAYS).
 *       - PUBLIC_TRUST_PROXY is intentionally not validated here (no
 *         format/conditional requirement, same as other boolean flags in
 *         this file) — its safe default is `false` in `.env.example`.
 *         Docs (doc 18, deployment-profiles.md) spell out that
 *         `PUBLIC_TRUST_PROXY=true` must only be used behind a trusted
 *         reverse proxy, since a future host-based resolver (#559) would
 *         otherwise trust a spoofable `X-Forwarded-Host` header.
 *  6. Optional Cloudflare DNS adapter (Issue #567, epic #555): if
 *     TENANT_DOMAIN_DNS_PROVIDER is set, it must be one of
 *     `KNOWN_TENANT_DOMAIN_DNS_PROVIDERS`
 *     (`../src/modules/tenant-domain/domain/tenant-domain-dns-config`) —
 *     `manual` (default/MVP, no extra var required) or `cloudflare` (then
 *     TENANT_DOMAIN_PLATFORM_ROOT_DOMAIN, TENANT_DOMAIN_CLOUDFLARE_ZONE_ID,
 *     and TENANT_DOMAIN_CLOUDFLARE_API_TOKEN must all be set). Left unset it
 *     is *not* an error — manual domain management
 *     (`POST /api/v1/tenant/domains/{id}/verify`, Issue #562) remains the
 *     default and keeps working with none of these vars present. Mirrors
 *     the EMAIL_PROVIDER conditional check above. See
 *     `src/modules/tenant-domain/README.md` §Cloudflare DNS adapter.
 *  7. Full-online-only auth security feature gate (Issue #587, epic:
 *     full-online auth hardening — #588-#592): if AUTH_ONLINE_SECURITY_ENABLED
 *     is not "true", nothing else is required and every online auth
 *     hardening feature (Turnstile, MFA/TOTP, Google login, generic SSO) is
 *     considered disabled — the default for every local/offline/LAN
 *     deployment. If AUTH_ONLINE_SECURITY_ENABLED=true, AUTH_ONLINE_SECURITY_PROFILE
 *     must be exactly "full_online" (`../src/lib/auth/online-security-config`);
 *     any other value (including the explicitly-contradictory "disabled")
 *     fails validation. Was the shared gate itself only when first added —
 *     this file now also validates the first concrete feature to consume
 *     it (item 8 below).
 *  8. Cloudflare Turnstile (Issue #588, epic: full-online auth hardening):
 *     if TURNSTILE_ENABLED is not "true", nothing else is required —
 *     independent of the #587 gate above, so a deployment can configure
 *     Turnstile credentials ahead of time without flipping
 *     AUTH_ONLINE_SECURITY_ENABLED on yet. TURNSTILE_ENABLED=true requires
 *     both TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY
 *     (`../src/lib/security/turnstile`). Whether Turnstile actually
 *     activates at runtime depends on BOTH this flag AND the #587 gate
 *     (`isTurnstileRequired()`), not on this validation alone.
 *  9. Full-online MFA/TOTP (Issue #589, epic: full-online auth hardening):
 *     if AUTH_MFA_ENABLED is not "true", nothing else is required —
 *     independent of the #587 gate, same rationale as item 8. AUTH_MFA_ENABLED=true
 *     requires AUTH_MFA_SECRET_ENCRYPTION_KEY, which must additionally
 *     decode as base64 to exactly 32 bytes (`../src/lib/auth/mfa-secret-crypto`'s
 *     `resolveMfaEncryptionKey`) — not just be present. Whether MFA actually
 *     activates at runtime depends on BOTH this flag AND the #587 gate
 *     (`isMfaRequired()`), not on this validation alone.
 * 10. Visitor analytics (Issue #617, epic: visitor analytics #617-#624):
 *     every VISITOR_ANALYTICS_* var is optional with a privacy-first
 *     default (`../src/modules/visitor-analytics/domain/visitor-analytics-config`) —
 *     leaving all of them unset always passes. If
 *     VISITOR_ANALYTICS_MODE is set, it must be one of
 *     `VISITOR_ANALYTICS_MODES` (`basic` | `detailed`). The four retention/
 *     window vars, if set, must each parse as a positive integer
 *     (`parsePositiveInt`). No conditional cross-field requirement exists
 *     yet (unlike EMAIL_PROVIDER/TENANT_DOMAIN_DNS_PROVIDER) — geolocation
 *     enrichment provider config lands in a later issue (#623).
 * 11. News portal full-online R2-only preset (Issue #632, epic `news_portal`
 *     #631-#642/#649): if NEWS_PORTAL_PROFILE is set, it must be one of
 *     `NEWS_PORTAL_PROFILES` (currently only "full_online_r2") —
 *     `../src/modules/news-portal/domain/news-portal-preset-readiness`. If
 *     NEWS_MEDIA_R2_ENABLED === "true", NEWS_MEDIA_R2_ACCOUNT_ID,
 *     NEWS_MEDIA_R2_ACCESS_KEY_ID, NEWS_MEDIA_R2_SECRET_ACCESS_KEY,
 *     NEWS_MEDIA_R2_BUCKET, and NEWS_MEDIA_R2_PUBLIC_BASE_URL must all be
 *     set (`../src/modules/news-portal/domain/news-media-r2-config`) —
 *     mirrors the R2_ENABLED conditional check above (item 3), deliberately
 *     namespaced `NEWS_MEDIA_R2_*` rather than reusing `R2_*` (see that
 *     file's header comment: news-portal media is a public bucket, wholly
 *     separate from sync-storage's private object queue — Issue #631
 *     architecture doc §2). Regardless of NEWS_MEDIA_R2_ENABLED, if BOTH a
 *     NEWS_MEDIA_R2_* var and its `sync-storage` R2_* counterpart
 *     (BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY) are set and equal, validation
 *     fails — this is enforced at config:validate as a hard boot-time
 *     failure, not merely a security:readiness warning, because sharing a
 *     credential between a private sync queue and a public media bucket is
 *     never a valid configuration in this repo, not just a risky one.
 *
 * 12. Social publishing full-online-only gate (Issue #643, epic
 *     `social_publishing` #643-#647): `SOCIAL_PUBLISHING_ENABLED` left unset
 *     (or anything other than "true") requires nothing else — mirrors
 *     `checkOnlineAuthSecurityConfig`'s exact shape (item 7). Only
 *     `SOCIAL_PUBLISHING_ENABLED=true` gates `SOCIAL_PUBLISHING_PROFILE`,
 *     which must then be exactly "full_online"
 *     (`../src/modules/social-publishing/domain/social-publishing-config`).
 *
 * Never prints actual secret values — only which variable name is
 * missing/invalid (doc 18: "Var wajib hilang → gagal start dengan pesan
 * jelas (tanpa membocorkan nilai)"). Exits non-zero on any failure. None of
 * the public-routing vars above are secrets, but they follow the same
 * name-only reporting style for consistency.
 *
 * Issue #689 (epic #679, platform-hardening): `src/lib/config/registry.ts`
 * is now the structured metadata source of truth for every var referenced
 * above (type/required/owner/sensitivity/profiles/default/deprecation) —
 * see that file's header for why its relationship to the ~30 `checkXxxConfig`
 * functions here is deliberately additive (registry = metadata + a
 * `validatorGroup` name pointing at the function below that governs each
 * var, not a replacement for these already-tested functions). The only
 * runtime behavior this file gains from the registry is
 * `collectDeprecationNotices`/`printDeprecationNotices` near the bottom —
 * an informational-only section, appended to the CLI report, that never
 * changes `runEnvValidation`'s return value or this script's exit code.
 * `bun run config:docs:check` (`scripts/config-docs-check.ts`) is the
 * companion CI gate keeping the registry, `.env.example`, and doc 18 in
 * sync.
 */
import { checkSyncHmacSecretNotDefault } from "./security-readiness";
import {
  EMAIL_MAILKETING_REQUIRED_WHEN_SELECTED,
  EMAIL_REQUIRED_WHEN_ENABLED,
  isKnownEmailProvider
} from "../src/modules/email/domain/email-config";
import {
  isKnownTenantDomainDnsProvider,
  KNOWN_TENANT_DOMAIN_DNS_PROVIDERS,
  TENANT_DOMAIN_CLOUDFLARE_REQUIRED_WHEN_SELECTED
} from "../src/modules/tenant-domain/domain/tenant-domain-dns-config";
import { isOnlineSecurityEnabled } from "../src/lib/auth/online-security-config";
import { isSocialPublishingEnabled } from "../src/modules/social-publishing/domain/social-publishing-config";
import {
  isKnownTelegramParseMode,
  isTelegramProviderEnabled,
  resolveTelegramBotTokenSecretReference
} from "../src/modules/social-publishing/domain/telegram-config";
import { looksLikeRawSecretToken } from "../src/modules/social-publishing/domain/social-account-validation";
import {
  isTurnstileEnabled,
  TURNSTILE_REQUIRED_WHEN_ENABLED
} from "../src/lib/security/turnstile";
import {
  AUTH_MFA_REQUIRED_WHEN_ENABLED,
  isMfaEnabled
} from "../src/lib/auth/mfa-config";
import { resolveMfaEncryptionKey } from "../src/lib/auth/mfa-secret-crypto";
import {
  GOOGLE_OIDC_REQUIRED_WHEN_ENABLED,
  isGoogleLoginEnabled
} from "../src/lib/auth/google-oidc-config";
import {
  isSsoEnabled,
  SSO_REQUIRED_WHEN_ENABLED
} from "../src/lib/auth/sso-config";
import { resolveSsoEncryptionKey } from "../src/lib/auth/sso-credential-crypto";
import {
  isKnownVisitorAnalyticsMode,
  parsePositiveInt,
  VISITOR_ANALYTICS_MODES,
  VISITOR_ANALYTICS_POSITIVE_INT_VARS
} from "../src/modules/visitor-analytics/domain/visitor-analytics-config";
import {
  findNewsMediaR2SeparationViolations,
  findUnknownNewsMediaR2MimeTypes,
  isOrphanGraceTooShort,
  isPresignedUploadTtlTooLong,
  NEWS_MEDIA_R2_MAX_PRESIGNED_UPLOAD_TTL_SECONDS,
  NEWS_MEDIA_R2_MIN_ORPHAN_GRACE_DAYS,
  NEWS_MEDIA_R2_REQUIRED_WHEN_ENABLED,
  resolveNewsMediaR2Config
} from "../src/modules/news-portal/domain/news-media-r2-config";
import {
  isKnownNewsPortalProfile,
  NEWS_PORTAL_PROFILES
} from "../src/modules/news-portal/domain/news-portal-preset-readiness";
import { findBlogAutoInternalTagLinksConfigIssues } from "../src/modules/blog-content/domain/internal-tag-linking-config";
import { CONFIG_REGISTRY } from "../src/lib/config/registry";

export type EnvCheckResult = {
  name: string;
  status: "pass" | "fail";
  detail: string;
};

const REQUIRED_NON_EMPTY_VARS = [
  "APP_ENV",
  "APP_URL",
  "APP_TIMEZONE",
  "DATABASE_URL",
  "AUTH_JWT_SECRET"
] as const;

/**
 * doc 18 §Referensi environment variable's own documented value set
 * (`development`/`staging`/`production`) — previously only checked for
 * non-emptiness (`checkRequiredVars`), never validated against this list.
 * Security-auditor review of PR #705 (Issue #684, epic #679) flagged this
 * as a foundation gap: `scripts/production-preflight.ts`'s new
 * `APP_ENV=production` blocking-skip rule (a skipped `db:pool:health`
 * blocks go-live) and its `--acknowledge-target=<APP_ENV value>` mutation
 * gate both compare against `APP_ENV` verbatim — an unvalidated typo/
 * casing variant (e.g. `Production`, `prod`) would silently opt an
 * operator OUT of that production-only safety net without any error
 * surfaced anywhere, since `--acknowledge-target` would still "match"
 * whatever wrong value `APP_ENV` happened to hold.
 */
const KNOWN_APP_ENV_VALUES = ["development", "staging", "production"] as const;

export function checkAppEnvValue(env: NodeJS.ProcessEnv): EnvCheckResult {
  const name = "APP_ENV (known value)";
  const raw = env.APP_ENV;

  if (!isSet(raw)) {
    return {
      name,
      status: "pass",
      detail: "APP_ENV is not set — covered by the required-vars check above."
    };
  }

  const value = (raw as string).trim();

  if ((KNOWN_APP_ENV_VALUES as readonly string[]).includes(value)) {
    return {
      name,
      status: "pass",
      detail: `APP_ENV="${value}" is a known value.`
    };
  }

  return {
    name,
    status: "fail",
    detail: `APP_ENV="${value}" is not one of ${KNOWN_APP_ENV_VALUES.join("/")} — a typo or unexpected casing here would silently weaken production-only safety checks (e.g. scripts/production-preflight.ts's db:pool:health blocking-skip rule).`
  };
}

const R2_REQUIRED_WHEN_ENABLED = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET"
] as const;

/**
 * The four documented public tenant resolution modes (Issue #556, epic
 * #555). See the file header comment §5 for what each mode requires.
 */
const PUBLIC_TENANT_RESOLUTION_MODES = [
  "host_default",
  "env_default",
  "setup_default",
  "tenant_code_legacy"
] as const;

type PublicTenantResolutionMode =
  (typeof PUBLIC_TENANT_RESOLUTION_MODES)[number];

function isKnownPublicTenantResolutionMode(
  value: string
): value is PublicTenantResolutionMode {
  return (PUBLIC_TENANT_RESOLUTION_MODES as readonly string[]).includes(value);
}

function isSet(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** `NEWS_MEDIA_R2_PUBLIC_BASE_URL` must be an absolute HTTPS URL — news media is public-by-design (architecture doc §11), never `r2.dev` over plain HTTP in a real deployment. */
function isHttpsAbsoluteUrl(value: string): boolean {
  try {
    return new URL(value.trim()).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Absolute-path check for PUBLIC_CANONICAL_BASE_PATH: leading "/", no
 * whitespace, no "//" collapse, and no trailing slash unless the whole
 * value is the root "/" itself.
 */
function isValidCanonicalBasePath(value: string): boolean {
  if (!value.startsWith("/")) return false;
  if (/\s/.test(value)) return false;
  if (value.includes("//")) return false;
  if (value.length > 1 && value.endsWith("/")) return false;
  return true;
}

function checkPublicCanonicalBasePath(env: NodeJS.ProcessEnv): EnvCheckResult {
  const name = "PUBLIC_CANONICAL_BASE_PATH";
  const raw = env.PUBLIC_CANONICAL_BASE_PATH;

  if (!isSet(raw)) {
    return {
      name,
      status: "pass",
      detail: `${name} is not set — defaults to /news.`
    };
  }

  const value = (raw as string).trim();

  if (isValidCanonicalBasePath(value)) {
    return {
      name,
      status: "pass",
      detail: `${name} is a valid absolute path.`
    };
  }

  return {
    name,
    status: "fail",
    detail: `${name} must be an absolute path starting with "/" (no whitespace, no "//", no trailing slash unless it is exactly "/").`
  };
}

export function checkRequiredVars(
  env: NodeJS.ProcessEnv = process.env
): EnvCheckResult[] {
  return REQUIRED_NON_EMPTY_VARS.map((name) => {
    if (isSet(env[name])) {
      return { name, status: "pass", detail: `${name} is set.` };
    }

    return {
      name,
      status: "fail",
      detail: `${name} is required but missing or empty.`
    };
  });
}

export function checkSyncConfig(
  env: NodeJS.ProcessEnv = process.env
): EnvCheckResult {
  const name = "AWCMS_MINI_SYNC_HMAC_SECRET (conditional on sync enabled)";

  if (env.AWCMS_MINI_SYNC_ENABLED !== "true") {
    return {
      name,
      status: "pass",
      detail:
        'AWCMS_MINI_SYNC_ENABLED is not "true" — sync HMAC secret not required.'
    };
  }

  // Reuses the exact same placeholder-detection function security-readiness
  // uses (Issue 10.3) — do not re-implement this comparison a second way.
  const result = checkSyncHmacSecretNotDefault(env);

  if (result.status === "fail") {
    return {
      name,
      status: "fail",
      detail:
        "AWCMS_MINI_SYNC_ENABLED=true but AWCMS_MINI_SYNC_HMAC_SECRET is unset or still the documented placeholder."
    };
  }

  return {
    name,
    status: "pass",
    detail:
      "AWCMS_MINI_SYNC_ENABLED=true and AWCMS_MINI_SYNC_HMAC_SECRET has been changed from its documented placeholder."
  };
}

export function checkR2Config(
  env: NodeJS.ProcessEnv = process.env
): EnvCheckResult[] {
  if (env.R2_ENABLED !== "true") {
    return [
      {
        name: "R2 credentials (conditional on R2 enabled)",
        status: "pass",
        detail: 'R2_ENABLED is not "true" — R2 credentials not required.'
      }
    ];
  }

  return R2_REQUIRED_WHEN_ENABLED.map((name) => {
    if (isSet(env[name])) {
      return { name, status: "pass", detail: `${name} is set.` };
    }

    return {
      name,
      status: "fail",
      detail: `R2_ENABLED=true but ${name} is missing or empty.`
    };
  });
}

export function checkEmailConfig(
  env: NodeJS.ProcessEnv = process.env
): EnvCheckResult[] {
  if (env.EMAIL_ENABLED !== "true") {
    return [
      {
        name: "Email config (conditional on EMAIL_ENABLED)",
        status: "pass",
        detail: 'EMAIL_ENABLED is not "true" — email config not required.'
      }
    ];
  }

  const results: EnvCheckResult[] = EMAIL_REQUIRED_WHEN_ENABLED.map((name) => {
    if (isSet(env[name])) {
      return { name, status: "pass", detail: `${name} is set.` };
    }

    return {
      name,
      status: "fail",
      detail: `EMAIL_ENABLED=true but ${name} is missing or empty.`
    };
  });

  const provider = env.EMAIL_PROVIDER;

  if (!isKnownEmailProvider(provider)) {
    results.push({
      name: "EMAIL_PROVIDER",
      status: "fail",
      detail:
        'EMAIL_ENABLED=true but EMAIL_PROVIDER is missing or not a known provider ("mailketing").'
    });
    return results;
  }

  results.push({
    name: "EMAIL_PROVIDER",
    status: "pass",
    detail: `EMAIL_PROVIDER is a known provider (${provider}).`
  });

  if (provider === "mailketing") {
    for (const name of EMAIL_MAILKETING_REQUIRED_WHEN_SELECTED) {
      if (isSet(env[name])) {
        results.push({ name, status: "pass", detail: `${name} is set.` });
        continue;
      }

      results.push({
        name,
        status: "fail",
        detail: `EMAIL_PROVIDER=mailketing but ${name} is missing or empty.`
      });
    }
  }

  return results;
}

export function checkPublicRoutingConfig(
  env: NodeJS.ProcessEnv = process.env
): EnvCheckResult[] {
  const results: EnvCheckResult[] = [];
  const rawMode = env.PUBLIC_TENANT_RESOLUTION_MODE;

  if (!isSet(rawMode)) {
    results.push({
      name: "PUBLIC_TENANT_RESOLUTION_MODE",
      status: "pass",
      detail:
        "PUBLIC_TENANT_RESOLUTION_MODE is not set — offline/LAN deployments keep today's legacy /blog/{tenantCode} behavior; no public-host config is required."
    });
    results.push(checkPublicCanonicalBasePath(env));
    return results;
  }

  const mode = (rawMode as string).trim();

  if (!isKnownPublicTenantResolutionMode(mode)) {
    results.push({
      name: "PUBLIC_TENANT_RESOLUTION_MODE",
      status: "fail",
      detail: `PUBLIC_TENANT_RESOLUTION_MODE must be one of ${PUBLIC_TENANT_RESOLUTION_MODES.join(", ")}; got "${mode}".`
    });
    // Unknown mode — cross-field rules below are meaningless for it.
    results.push(checkPublicCanonicalBasePath(env));
    return results;
  }

  results.push({
    name: "PUBLIC_TENANT_RESOLUTION_MODE",
    status: "pass",
    detail: `PUBLIC_TENANT_RESOLUTION_MODE is a known mode (${mode}).`
  });

  if (mode === "host_default") {
    if (isSet(env.PUBLIC_PLATFORM_ROOT_DOMAIN)) {
      results.push({
        name: "PUBLIC_PLATFORM_ROOT_DOMAIN",
        status: "pass",
        detail: "PUBLIC_PLATFORM_ROOT_DOMAIN is set."
      });
    } else {
      results.push({
        name: "PUBLIC_PLATFORM_ROOT_DOMAIN",
        status: "fail",
        detail:
          "PUBLIC_TENANT_RESOLUTION_MODE=host_default but PUBLIC_PLATFORM_ROOT_DOMAIN is missing or empty — the host-based resolver (Issue #559) needs a root domain to tell tenant subdomains apart from unrelated hosts."
      });
    }
  }

  if (mode === "env_default") {
    const hasId = isSet(env.PUBLIC_DEFAULT_TENANT_ID);
    const hasCode = isSet(env.PUBLIC_DEFAULT_TENANT_CODE);

    if (hasId || hasCode) {
      results.push({
        name: "PUBLIC_DEFAULT_TENANT_ID or PUBLIC_DEFAULT_TENANT_CODE",
        status: "pass",
        detail:
          "At least one of PUBLIC_DEFAULT_TENANT_ID/PUBLIC_DEFAULT_TENANT_CODE is set."
      });
    } else {
      results.push({
        name: "PUBLIC_DEFAULT_TENANT_ID or PUBLIC_DEFAULT_TENANT_CODE",
        status: "fail",
        detail:
          "PUBLIC_TENANT_RESOLUTION_MODE=env_default requires at least one of PUBLIC_DEFAULT_TENANT_ID or PUBLIC_DEFAULT_TENANT_CODE to be set."
      });
    }
  }

  // mode === "setup_default" | "tenant_code_legacy": no extra required var.

  results.push(checkPublicCanonicalBasePath(env));

  return results;
}

/**
 * Optional Cloudflare DNS adapter (Issue #567, epic #555). Manual domain
 * management stays the default: `TENANT_DOMAIN_DNS_PROVIDER` left unset (or
 * explicitly `"manual"`) requires none of the Cloudflare vars below and
 * `config:validate` passes exactly as it does today. Only
 * `"cloudflare"` gates the three extra vars, mirroring `checkEmailConfig`'s
 * `EMAIL_PROVIDER=mailketing` conditional above.
 */
export function checkTenantDomainDnsConfig(
  env: NodeJS.ProcessEnv = process.env
): EnvCheckResult[] {
  const results: EnvCheckResult[] = [];
  const raw = env.TENANT_DOMAIN_DNS_PROVIDER;

  if (!isSet(raw)) {
    results.push({
      name: "TENANT_DOMAIN_DNS_PROVIDER",
      status: "pass",
      detail:
        "TENANT_DOMAIN_DNS_PROVIDER is not set — defaults to manual domain verification (Issue #562's POST .../verify); no Cloudflare credentials required."
    });
    return results;
  }

  const provider = (raw as string).trim();

  if (!isKnownTenantDomainDnsProvider(provider)) {
    results.push({
      name: "TENANT_DOMAIN_DNS_PROVIDER",
      status: "fail",
      detail: `TENANT_DOMAIN_DNS_PROVIDER must be one of ${KNOWN_TENANT_DOMAIN_DNS_PROVIDERS.join(", ")}; got "${provider}".`
    });
    return results;
  }

  results.push({
    name: "TENANT_DOMAIN_DNS_PROVIDER",
    status: "pass",
    detail: `TENANT_DOMAIN_DNS_PROVIDER is a known provider (${provider}).`
  });

  if (provider === "cloudflare") {
    for (const name of TENANT_DOMAIN_CLOUDFLARE_REQUIRED_WHEN_SELECTED) {
      if (isSet(env[name])) {
        results.push({ name, status: "pass", detail: `${name} is set.` });
        continue;
      }

      results.push({
        name,
        status: "fail",
        detail: `TENANT_DOMAIN_DNS_PROVIDER=cloudflare but ${name} is missing or empty.`
      });
    }
  }

  return results;
}

/**
 * Full-online-only auth security feature gate (Issue #587, epic: full-online
 * auth hardening). `AUTH_ONLINE_SECURITY_ENABLED` left unset (or anything
 * other than `"true"`) requires nothing else and `config:validate` passes
 * exactly as it does today — mirrors `checkTenantDomainDnsConfig`'s
 * "manual/unset requires nothing" shape. Only `AUTH_ONLINE_SECURITY_ENABLED=true`
 * gates `AUTH_ONLINE_SECURITY_PROFILE`, which must then be exactly
 * `"full_online"` (the only other known value, `"disabled"`, would be a
 * contradiction — enabled but explicitly disabled profile).
 */
export function checkOnlineAuthSecurityConfig(
  env: NodeJS.ProcessEnv = process.env
): EnvCheckResult[] {
  const name =
    "AUTH_ONLINE_SECURITY_PROFILE (conditional on AUTH_ONLINE_SECURITY_ENABLED)";

  if (!isOnlineSecurityEnabled(env)) {
    return [
      {
        name,
        status: "pass",
        detail:
          'AUTH_ONLINE_SECURITY_ENABLED is not "true" — full-online auth hardening (Turnstile/MFA/Google login/SSO) is disabled; no online auth provider config required.'
      }
    ];
  }

  const profile = env.AUTH_ONLINE_SECURITY_PROFILE;

  if (profile !== "full_online") {
    return [
      {
        name,
        status: "fail",
        detail: `AUTH_ONLINE_SECURITY_ENABLED=true requires AUTH_ONLINE_SECURITY_PROFILE=full_online; got ${
          profile ? `"${profile}"` : "unset"
        }.`
      }
    ];
  }

  return [
    {
      name,
      status: "pass",
      detail:
        "AUTH_ONLINE_SECURITY_ENABLED=true and AUTH_ONLINE_SECURITY_PROFILE=full_online."
    }
  ];
}

/**
 * Cloudflare Turnstile (Issue #588, epic: full-online auth hardening).
 * `TURNSTILE_ENABLED` left unset (or anything other than `"true"`) requires
 * nothing else — mirrors `checkTenantDomainDnsConfig`'s "unset/off requires
 * nothing" shape. Validated independently of the #587 full-online gate
 * (`AUTH_ONLINE_SECURITY_ENABLED`/`_PROFILE`) — a deployment can have its
 * Turnstile credentials configured ahead of time without yet flipping the
 * outer gate on; the outer gate (checked separately by
 * `checkOnlineAuthSecurityConfig` above) is what actually decides whether
 * `isTurnstileRequired()` returns true at runtime.
 */
export function checkTurnstileConfig(
  env: NodeJS.ProcessEnv = process.env
): EnvCheckResult[] {
  if (!isTurnstileEnabled(env)) {
    return [
      {
        name: "Turnstile config (conditional on TURNSTILE_ENABLED)",
        status: "pass",
        detail:
          'TURNSTILE_ENABLED is not "true" — Turnstile config not required.'
      }
    ];
  }

  return TURNSTILE_REQUIRED_WHEN_ENABLED.map((name) => {
    if (isSet(env[name])) {
      return { name, status: "pass", detail: `${name} is set.` };
    }

    return {
      name,
      status: "fail",
      detail: `TURNSTILE_ENABLED=true but ${name} is missing or empty.`
    };
  });
}

/**
 * Full-online MFA/TOTP (Issue #589, epic: full-online auth hardening).
 * `AUTH_MFA_ENABLED` left unset (or anything other than `"true"`) requires
 * nothing else — same "unset/off requires nothing" shape as
 * `checkTurnstileConfig`, and validated independently of the #587 gate for
 * the same reason (an operator can provision the encryption key ahead of
 * time). `AUTH_MFA_SECRET_ENCRYPTION_KEY` is checked for more than presence
 * — it must decode as base64 to exactly 32 bytes (AES-256-GCM), the same
 * validity `resolveMfaEncryptionKey` itself enforces at runtime, so a
 * deployment that passes `config:validate` never later hits the
 * `MFA_MISCONFIGURED` fail-closed path due to a malformed key.
 */
/**
 * Only whether the key decodes correctly — never the key material itself —
 * crosses out of this function. Deliberately isolated from
 * `checkMfaConfig`'s report-building below (a plain boolean computed once,
 * not inlined into the same expression that also builds the logged
 * `name`/`detail` strings) so a static analyzer can't mistake "we checked
 * the key's *validity*" for "we logged the key's *value*" — `detail` below
 * only ever contains the env var's NAME (`AUTH_MFA_SECRET_ENCRYPTION_KEY`),
 * a compile-time constant, never `env.AUTH_MFA_SECRET_ENCRYPTION_KEY`'s
 * actual value.
 */
function isMfaEncryptionKeyWellFormed(env: NodeJS.ProcessEnv): boolean {
  return resolveMfaEncryptionKey(env) !== null;
}

export function checkMfaConfig(
  env: NodeJS.ProcessEnv = process.env
): EnvCheckResult[] {
  if (!isMfaEnabled(env)) {
    return [
      {
        name: "MFA config (conditional on AUTH_MFA_ENABLED)",
        status: "pass",
        detail: 'AUTH_MFA_ENABLED is not "true" — MFA config not required.'
      }
    ];
  }

  const encryptionKeyWellFormed = isMfaEncryptionKeyWellFormed(env);

  return AUTH_MFA_REQUIRED_WHEN_ENABLED.map((name) => {
    if (!isSet(env[name])) {
      return {
        name,
        status: "fail",
        detail: `AUTH_MFA_ENABLED=true but ${name} is missing or empty.`
      };
    }

    if (name === "AUTH_MFA_SECRET_ENCRYPTION_KEY" && !encryptionKeyWellFormed) {
      return {
        name,
        status: "fail",
        detail: `${name} must be a base64-encoded 32-byte (AES-256) key, e.g. from "openssl rand -base64 32".`
      };
    }

    return { name, status: "pass", detail: `${name} is set.` };
  });
}

/**
 * Google OIDC login (Issue #590, epic: full-online auth hardening).
 * `AUTH_GOOGLE_LOGIN_ENABLED` left unset (or anything other than `"true"`)
 * requires nothing else — same "unset/off requires nothing" shape as
 * `checkTurnstileConfig`/`checkMfaConfig`, and validated independently of
 * the #587 gate for the same reason (an operator can provision Google
 * OAuth credentials ahead of time). `AUTH_GOOGLE_ALLOWED_DOMAINS` is
 * intentionally never required here — leaving it unset simply means
 * auto-linking-by-email is never allowed (`isEmailDomainAllowed` fails
 * closed), a safe default, not a misconfiguration.
 */
export function checkGoogleOidcConfig(
  env: NodeJS.ProcessEnv = process.env
): EnvCheckResult[] {
  if (!isGoogleLoginEnabled(env)) {
    return [
      {
        name: "Google OIDC config (conditional on AUTH_GOOGLE_LOGIN_ENABLED)",
        status: "pass",
        detail:
          'AUTH_GOOGLE_LOGIN_ENABLED is not "true" — Google OIDC config not required.'
      }
    ];
  }

  return GOOGLE_OIDC_REQUIRED_WHEN_ENABLED.map((name) => {
    if (!isSet(env[name])) {
      return {
        name,
        status: "fail",
        detail: `AUTH_GOOGLE_LOGIN_ENABLED=true but ${name} is missing or empty.`
      };
    }

    return { name, status: "pass", detail: `${name} is set.` };
  });
}

/**
 * Generic tenant OIDC SSO (Issue #591, epic: full-online auth hardening).
 * `AUTH_SSO_ENABLED` left unset (or anything other than `"true"`) requires
 * nothing else — same "unset/off requires nothing" shape as
 * `checkTurnstileConfig`/`checkMfaConfig`/`checkGoogleOidcConfig`, validated
 * independently of the #587 gate for the same reason (an operator can
 * provision the credential encryption key ahead of time). Per-provider
 * issuer/client id/secret are tenant-configured DATA
 * (`awcms_mini_auth_providers`, migration 036), not deployment-level env
 * vars, so unlike Google OIDC there is nothing provider-specific to check
 * here — only the shared encryption key, checked for validity (decodes as
 * base64 to exactly 32 bytes) the same way `checkMfaConfig` validates
 * `AUTH_MFA_SECRET_ENCRYPTION_KEY`, so a deployment that passes
 * `config:validate` never later hits the `SSO_MISCONFIGURED` fail-closed
 * path due to a malformed key.
 */
export function checkSsoConfig(
  env: NodeJS.ProcessEnv = process.env
): EnvCheckResult[] {
  if (!isSsoEnabled(env)) {
    return [
      {
        name: "SSO config (conditional on AUTH_SSO_ENABLED)",
        status: "pass",
        detail: 'AUTH_SSO_ENABLED is not "true" — SSO config not required.'
      }
    ];
  }

  const encryptionKeyWellFormed = resolveSsoEncryptionKey(env) !== null;

  return SSO_REQUIRED_WHEN_ENABLED.map((name) => {
    if (!isSet(env[name])) {
      return {
        name,
        status: "fail",
        detail: `AUTH_SSO_ENABLED=true but ${name} is missing or empty.`
      };
    }

    if (
      name === "AUTH_SSO_CREDENTIAL_ENCRYPTION_KEY" &&
      !encryptionKeyWellFormed
    ) {
      return {
        name,
        status: "fail",
        detail: `${name} must be a base64-encoded 32-byte (AES-256) key, e.g. from "openssl rand -base64 32".`
      };
    }

    return { name, status: "pass", detail: `${name} is set.` };
  });
}

/**
 * Visitor analytics (Issue #617, epic: visitor analytics #617-#624). Every
 * var is optional — unset always passes, mirroring
 * `resolveVisitorAnalyticsConfig`'s own fall-back-to-default behavior so a
 * deployment that never touches these vars stays privacy-first by
 * default (see file header comment §10).
 */
export function checkVisitorAnalyticsConfig(
  env: NodeJS.ProcessEnv = process.env
): EnvCheckResult[] {
  const results: EnvCheckResult[] = [];
  const rawMode = env.VISITOR_ANALYTICS_MODE;

  if (!isSet(rawMode)) {
    results.push({
      name: "VISITOR_ANALYTICS_MODE",
      status: "pass",
      detail: "VISITOR_ANALYTICS_MODE is not set — defaults to basic."
    });
  } else if (isKnownVisitorAnalyticsMode((rawMode as string).trim())) {
    results.push({
      name: "VISITOR_ANALYTICS_MODE",
      status: "pass",
      detail: `VISITOR_ANALYTICS_MODE is a known mode (${(rawMode as string).trim()}).`
    });
  } else {
    results.push({
      name: "VISITOR_ANALYTICS_MODE",
      status: "fail",
      detail: `VISITOR_ANALYTICS_MODE must be one of ${VISITOR_ANALYTICS_MODES.join(", ")}; got "${(rawMode as string).trim()}".`
    });
  }

  for (const name of VISITOR_ANALYTICS_POSITIVE_INT_VARS) {
    const raw = env[name];

    if (!isSet(raw)) {
      results.push({
        name,
        status: "pass",
        detail: `${name} is not set — a privacy-first default applies.`
      });
      continue;
    }

    if (parsePositiveInt(raw) !== undefined) {
      results.push({
        name,
        status: "pass",
        detail: `${name} is a positive integer.`
      });
      continue;
    }

    results.push({
      name,
      status: "fail",
      detail: `${name} must be a positive integer when set; got "${(raw as string).trim()}".`
    });
  }

  return results;
}

/**
 * News portal full-online R2-only preset (Issue #632, epic `news_portal`
 * #631-#642/#649). `NEWS_PORTAL_PROFILE` shape check first, then
 * `NEWS_MEDIA_R2_*` conditional-required-vars (mirrors `checkR2Config`
 * exactly, different namespace), then the hard separation-from-sync-R2
 * check (Keputusan kunci #1 — never a warning, always a boot-blocking
 * failure when violated).
 */
export function checkNewsPortalProfileConfig(
  env: NodeJS.ProcessEnv = process.env
): EnvCheckResult {
  const name = "NEWS_PORTAL_PROFILE";
  const raw = env.NEWS_PORTAL_PROFILE;

  if (!isSet(raw)) {
    return {
      name,
      status: "pass",
      detail: `${name} is not set — the news_portal_full_online_r2 preset is not requested.`
    };
  }

  if (isKnownNewsPortalProfile((raw as string).trim())) {
    return {
      name,
      status: "pass",
      detail: `${name} is a known profile (${(raw as string).trim()}).`
    };
  }

  return {
    name,
    status: "fail",
    detail: `${name} must be one of ${NEWS_PORTAL_PROFILES.join(", ")}; got "${(raw as string).trim()}".`
  };
}

export function checkNewsMediaR2Config(
  env: NodeJS.ProcessEnv = process.env
): EnvCheckResult[] {
  if (env.NEWS_MEDIA_R2_ENABLED !== "true") {
    return [
      {
        name: "News media R2 credentials (conditional on NEWS_MEDIA_R2_ENABLED)",
        status: "pass",
        detail:
          'NEWS_MEDIA_R2_ENABLED is not "true" — news media R2 credentials not required.'
      }
    ];
  }

  const results: EnvCheckResult[] = NEWS_MEDIA_R2_REQUIRED_WHEN_ENABLED.map(
    (name) => {
      if (isSet(env[name])) {
        return { name, status: "pass", detail: `${name} is set.` };
      }

      return {
        name,
        status: "fail",
        detail: `NEWS_MEDIA_R2_ENABLED=true but ${name} is missing or empty.`
      };
    }
  );

  const publicBaseUrlName = "NEWS_MEDIA_R2_PUBLIC_BASE_URL";
  const publicBaseUrl = env.NEWS_MEDIA_R2_PUBLIC_BASE_URL;

  if (isSet(publicBaseUrl)) {
    results.push(
      isHttpsAbsoluteUrl(publicBaseUrl as string)
        ? {
            name: `${publicBaseUrlName} (format)`,
            status: "pass",
            detail: `${publicBaseUrlName} is an absolute HTTPS URL.`
          }
        : {
            name: `${publicBaseUrlName} (format)`,
            status: "fail",
            detail: `${publicBaseUrlName} must be an absolute HTTPS URL (news media is public-by-design — architecture doc §11); got "${(publicBaseUrl as string).trim()}".`
          }
    );
  }

  return results;
}

export function checkNewsMediaR2SeparationFromSyncR2(
  env: NodeJS.ProcessEnv = process.env
): EnvCheckResult {
  const name =
    "News media R2 bucket/credentials separated from sync-storage's R2_*";
  const violations = findNewsMediaR2SeparationViolations(env);

  if (violations.length === 0) {
    return {
      name,
      status: "pass",
      detail:
        "No NEWS_MEDIA_R2_* value is equal to its sync-storage R2_* counterpart."
    };
  }

  return {
    name,
    status: "fail",
    detail: `NEWS_MEDIA_R2_* must never share a bucket/credential with sync-storage's R2_* config (Issue #631 architecture doc §2): ${violations.join(", ")}.`
  };
}

/**
 * Issue #635: an allow-list entry the MIME sniffer (`news-media-mime-sniffer.ts`)
 * could never recognize is a misconfiguration — every real upload claiming
 * it would fail-safe reject at `finalize` regardless, so this is a hard
 * error, not just a warning.
 */
export function checkNewsMediaR2AllowedMimeTypesKnown(
  env: NodeJS.ProcessEnv = process.env
): EnvCheckResult {
  const name = "NEWS_MEDIA_R2_ALLOWED_MIME_TYPES (known types only)";
  const unknown = findUnknownNewsMediaR2MimeTypes(env);

  if (unknown.length === 0) {
    return {
      name,
      status: "pass",
      detail:
        env.NEWS_MEDIA_R2_ENABLED === "true"
          ? "NEWS_MEDIA_R2_ALLOWED_MIME_TYPES contains only known image MIME types."
          : 'NEWS_MEDIA_R2_ENABLED is not "true" — no MIME allow-list in effect.'
    };
  }

  return {
    name,
    status: "fail",
    detail: `NEWS_MEDIA_R2_ALLOWED_MIME_TYPES contains type(s) the MIME sniffer can never recognize, so uploads claiming them would always be rejected at finalize: ${unknown.join(", ")}.`
  };
}

/** Issue #635: a presigned PUT URL is reusable for its whole TTL — an excessively long expiry undermines that mitigation (architecture doc §8). */
export function checkNewsMediaR2PresignedTtlUpperBound(
  env: NodeJS.ProcessEnv = process.env
): EnvCheckResult {
  const name = "NEWS_MEDIA_R2_PRESIGNED_UPLOAD_TTL_SECONDS (upper bound)";

  if (isPresignedUploadTtlTooLong(env)) {
    const ttl = resolveNewsMediaR2Config(env).presignedUploadTtlSeconds;

    return {
      name,
      status: "fail",
      detail: `NEWS_MEDIA_R2_PRESIGNED_UPLOAD_TTL_SECONDS=${ttl} exceeds the maximum of ${NEWS_MEDIA_R2_MAX_PRESIGNED_UPLOAD_TTL_SECONDS}s (1 hour) — a presigned PUT URL is not single-use, so a long expiry weakens the "short-lived URL" mitigation (architecture doc §8).`
    };
  }

  return {
    name,
    status: "pass",
    detail:
      env.NEWS_MEDIA_R2_ENABLED === "true"
        ? `NEWS_MEDIA_R2_PRESIGNED_UPLOAD_TTL_SECONDS is within the ${NEWS_MEDIA_R2_MAX_PRESIGNED_UPLOAD_TTL_SECONDS}s maximum.`
        : 'NEWS_MEDIA_R2_ENABLED is not "true" — no presigned upload TTL in effect.'
  };
}

/** Issue #690: the R2 lifecycle/reconciliation job's orphan grace period must be at least `NEWS_MEDIA_R2_MIN_ORPHAN_GRACE_DAYS` (`r2-backup-lifecycle.md` §3's "minimum 30 hari") — a shorter window would physically delete recently-orphaned media before an editor has a realistic chance to notice/undo an accidental unlink. */
export function checkNewsMediaR2OrphanGraceLowerBound(
  env: NodeJS.ProcessEnv = process.env
): EnvCheckResult {
  const name = `NEWS_MEDIA_R2_ORPHAN_GRACE_DAYS (lower bound)`;

  if (isOrphanGraceTooShort(env)) {
    const days = resolveNewsMediaR2Config(env).orphanGraceDays;

    return {
      name,
      status: "fail",
      detail: `NEWS_MEDIA_R2_ORPHAN_GRACE_DAYS=${days} is below the minimum of ${NEWS_MEDIA_R2_MIN_ORPHAN_GRACE_DAYS} days (r2-backup-lifecycle.md §3) — too short a grace window risks scripts/news-media-r2-reconcile.ts physically deleting an orphaned object before an editor could realistically notice/undo an accidental unlink.`
    };
  }

  return {
    name,
    status: "pass",
    detail:
      env.NEWS_MEDIA_R2_ENABLED === "true"
        ? `NEWS_MEDIA_R2_ORPHAN_GRACE_DAYS is at least the ${NEWS_MEDIA_R2_MIN_ORPHAN_GRACE_DAYS}-day minimum.`
        : 'NEWS_MEDIA_R2_ENABLED is not "true" — no orphan grace period in effect.'
  };
}

/**
 * Full-online-only social publishing gate (Issue #643, epic
 * `social_publishing` #643-#647). `SOCIAL_PUBLISHING_ENABLED` left unset (or
 * anything other than `"true"`) requires nothing else and `config:validate`
 * passes exactly as it does today — mirrors `checkOnlineAuthSecurityConfig`'s
 * "manual/unset requires nothing" shape verbatim. Only
 * `SOCIAL_PUBLISHING_ENABLED=true` gates `SOCIAL_PUBLISHING_PROFILE`, which
 * must then be exactly `"full_online"` (the only other known value,
 * `"disabled"`, would be a contradiction — enabled but explicitly disabled
 * profile).
 */
export function checkSocialPublishingProfileConfig(
  env: NodeJS.ProcessEnv = process.env
): EnvCheckResult {
  const name =
    "SOCIAL_PUBLISHING_PROFILE (conditional on SOCIAL_PUBLISHING_ENABLED)";

  if (!isSocialPublishingEnabled(env)) {
    return {
      name,
      status: "pass",
      detail:
        'SOCIAL_PUBLISHING_ENABLED is not "true" — social publishing outbox/dispatcher is disabled; no social publishing config required.'
    };
  }

  const profile = env.SOCIAL_PUBLISHING_PROFILE;

  if (profile !== "full_online") {
    return {
      name,
      status: "fail",
      detail: `SOCIAL_PUBLISHING_ENABLED=true requires SOCIAL_PUBLISHING_PROFILE=full_online; got ${
        profile ? `"${profile}"` : "unset"
      }.`
    };
  }

  return {
    name,
    status: "pass",
    detail:
      "SOCIAL_PUBLISHING_ENABLED=true and SOCIAL_PUBLISHING_PROFILE=full_online."
  };
}

/**
 * Telegram channel adapter config (Issue #646, epic `social_publishing`
 * #643-#647). No-op pass when `TELEGRAM_PROVIDER_ENABLED` is not `"true"` —
 * mirrors `checkSocialPublishingProfileConfig`'s shape, and is deliberately
 * INDEPENDENT of the outer `SOCIAL_PUBLISHING_ENABLED` gate (a deployment
 * could enable social publishing for Meta/LinkedIn only, with Telegram never
 * turned on). When enabled, validates:
 *
 *   - `TELEGRAM_BOT_TOKEN_SECRET_REFERENCE` is set and does not itself look
 *     like a raw bot token (reuses `looksLikeRawSecretToken` — the SAME
 *     write-time heuristic `social-account-validation.ts` uses for
 *     per-account `token_reference` values, per this epic's own established
 *     "reuse the existing heuristic, don't invent a new one" precedent from
 *     PR #731's 3-round security-auditor history).
 *   - `TELEGRAM_DEFAULT_PARSE_MODE`, if set, is one of the two supported
 *     values (`MarkdownV2`/`HTML`) — anything else (including legacy
 *     `Markdown`) fails loudly at boot rather than silently falling back to
 *     plain text without the operator noticing a typo.
 *   - `TELEGRAM_REQUEST_TIMEOUT_MS`, if set, is a positive integer.
 */
export function checkTelegramProviderConfig(
  env: NodeJS.ProcessEnv = process.env
): EnvCheckResult[] {
  const tokenName =
    "TELEGRAM_BOT_TOKEN_SECRET_REFERENCE (conditional on TELEGRAM_PROVIDER_ENABLED)";

  if (!isTelegramProviderEnabled(env)) {
    return [
      {
        name: tokenName,
        status: "pass",
        detail:
          'TELEGRAM_PROVIDER_ENABLED is not "true" — Telegram channel publishing is disabled; no Telegram config required.'
      }
    ];
  }

  const results: EnvCheckResult[] = [];
  const reference = resolveTelegramBotTokenSecretReference(env);

  if (!reference) {
    results.push({
      name: tokenName,
      status: "fail",
      detail:
        "TELEGRAM_PROVIDER_ENABLED=true requires TELEGRAM_BOT_TOKEN_SECRET_REFERENCE to be set."
    });
  } else if (looksLikeRawSecretToken(reference)) {
    results.push({
      name: tokenName,
      status: "fail",
      detail:
        "TELEGRAM_BOT_TOKEN_SECRET_REFERENCE looks like a raw bot token, not a secret-storage reference. Store the real token in your secret manager/env var and pass only its reference here."
    });
  } else {
    results.push({
      name: tokenName,
      status: "pass",
      detail:
        "TELEGRAM_BOT_TOKEN_SECRET_REFERENCE is set and does not look like a raw secret."
    });
  }

  const parseModeName = "TELEGRAM_DEFAULT_PARSE_MODE (optional)";
  const rawParseMode = env.TELEGRAM_DEFAULT_PARSE_MODE;

  if (
    rawParseMode !== undefined &&
    rawParseMode !== "" &&
    !isKnownTelegramParseMode(rawParseMode)
  ) {
    results.push({
      name: parseModeName,
      status: "fail",
      detail: `TELEGRAM_DEFAULT_PARSE_MODE="${rawParseMode}" is not supported — must be unset (plain text, safe default) or exactly "MarkdownV2"/"HTML". Legacy "Markdown" is deliberately not supported.`
    });
  } else {
    results.push({
      name: parseModeName,
      status: "pass",
      detail: rawParseMode
        ? `TELEGRAM_DEFAULT_PARSE_MODE=${rawParseMode}.`
        : "TELEGRAM_DEFAULT_PARSE_MODE is unset — messages send as plain text (safe default, no formatting injection surface)."
    });
  }

  const timeoutName = "TELEGRAM_REQUEST_TIMEOUT_MS (optional)";
  const rawTimeout = env.TELEGRAM_REQUEST_TIMEOUT_MS;
  const parsedTimeout = Number(rawTimeout);

  if (
    rawTimeout !== undefined &&
    rawTimeout !== "" &&
    (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0)
  ) {
    results.push({
      name: timeoutName,
      status: "fail",
      detail: `TELEGRAM_REQUEST_TIMEOUT_MS="${rawTimeout}" must be a positive integer when set.`
    });
  } else {
    results.push({
      name: timeoutName,
      status: "pass",
      detail:
        "TELEGRAM_REQUEST_TIMEOUT_MS is unset or a valid positive integer."
    });
  }

  return results;
}

/** Issue #641: `BLOG_AUTO_INTERNAL_TAG_LINKS_MAX_PER_POST`/`_MAX_PER_TAG`/`_MIN_TERM_LENGTH` must each be within their documented reasonable bounds (`internal-tag-linking-config.ts`'s ceiling constants) — an out-of-range value would either no-op the feature or risk turning normal prose into a link farm. */
export function checkBlogAutoInternalTagLinksConfig(
  env: NodeJS.ProcessEnv = process.env
): EnvCheckResult {
  const name = "BLOG_AUTO_INTERNAL_TAG_LINKS_* (bounds)";
  const issues = findBlogAutoInternalTagLinksConfigIssues(env);

  if (issues.length > 0) {
    return {
      name,
      status: "fail",
      detail: `Out-of-range automatic internal tag linking configuration: ${issues.join(", ")}.`
    };
  }

  return {
    name,
    status: "pass",
    detail:
      "BLOG_AUTO_INTERNAL_TAG_LINKS_MAX_PER_POST/_MAX_PER_TAG/_MIN_TERM_LENGTH are within their documented bounds."
  };
}

export function runEnvValidation(
  env: NodeJS.ProcessEnv = process.env
): EnvCheckResult[] {
  return [
    ...checkRequiredVars(env),
    checkAppEnvValue(env),
    checkSyncConfig(env),
    ...checkR2Config(env),
    ...checkEmailConfig(env),
    ...checkPublicRoutingConfig(env),
    ...checkTenantDomainDnsConfig(env),
    ...checkTurnstileConfig(env),
    ...checkMfaConfig(env),
    ...checkGoogleOidcConfig(env),
    ...checkSsoConfig(env),
    ...checkOnlineAuthSecurityConfig(env),
    ...checkVisitorAnalyticsConfig(env),
    checkNewsPortalProfileConfig(env),
    ...checkNewsMediaR2Config(env),
    checkNewsMediaR2SeparationFromSyncR2(env),
    checkNewsMediaR2AllowedMimeTypesKnown(env),
    checkNewsMediaR2PresignedTtlUpperBound(env),
    checkNewsMediaR2OrphanGraceLowerBound(env),
    checkSocialPublishingProfileConfig(env),
    ...checkTelegramProviderConfig(env),
    checkBlogAutoInternalTagLinksConfig(env)
  ];
}

/**
 * Deprecation notices (Issue #689, epic #679 platform-hardening) — driven
 * by `src/lib/config/registry.ts`'s `deprecated` field, purely additive to
 * the pass/fail checks above: a deprecated variable that is currently SET
 * only ever produces an informational notice here, never an `EnvCheckResult`
 * `"fail"`. This deliberately keeps `runEnvValidation`'s return shape/length
 * untouched (existing tests import and assert against it directly) — the
 * CLI report below prints these as a separate section instead. Never prints
 * the variable's actual value, only its name and the registry's own
 * `guidance` text (which never contains a real secret/example value either).
 */
function collectDeprecationNotices(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  return CONFIG_REGISTRY.filter(
    (entry) => entry.deprecated !== undefined && isSet(env[entry.name])
  ).map((entry) => {
    const { since, removalVersion, guidance } = entry.deprecated!;
    return `${entry.name} is deprecated since ${since} (planned removal in ${removalVersion}): ${guidance}`;
  });
}

function printReport(results: EnvCheckResult[]): boolean {
  console.log("config:validate — environment variable validation (doc 18)");
  console.log("");

  for (const result of results) {
    const label = result.status === "pass" ? "PASS" : "FAIL";
    console.log(`[${label}] ${result.name}\n    ${result.detail}`);
  }

  const failed = results.filter((result) => result.status === "fail");

  console.log("");

  if (failed.length > 0) {
    console.log(
      `config:validate FAILED — ${failed.length} check(s) failed: ${failed
        .map((result) => result.name)
        .join(", ")}.`
    );
    return false;
  }

  console.log(`config:validate OK — ${results.length} check(s) passed.`);
  return true;
}

function printDeprecationNotices(notices: string[]): void {
  if (notices.length === 0) {
    return;
  }

  console.log("");
  console.log(
    `config:validate — ${notices.length} deprecation notice(s) (informational, does not fail this check — src/lib/config/registry.ts):`
  );

  for (const notice of notices) {
    console.log(`[DEPRECATED] ${notice}`);
  }
}

async function main() {
  const results = runEnvValidation();
  const passed = printReport(results);

  printDeprecationNotices(collectDeprecationNotices());

  if (!passed) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
