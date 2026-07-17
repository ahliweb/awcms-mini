/**
 * Typed configuration registry (Issue #689, epic #679 platform-hardening —
 * "add typed configuration schema and remove dead environment variables").
 *
 * Single source of truth for every environment variable this application
 * reads (or historically claimed to read) — one entry per variable, with
 * enough metadata to drive three things that used to drift independently:
 *
 * 1. `.env.example` (this repo's actual example file).
 * 2. `docs/awcms-mini/18_configuration_env_reference.md` (the prose
 *    reference tables).
 * 3. `scripts/validate-env.ts` (`bun run config:validate`'s boot-time
 *    checks).
 *
 * `scripts/config-docs-check.ts` (`bun run config:docs:check`) fails CI
 * when any of the three above disagrees with this registry (modulo the
 * explicit exemption lists below) — see that script's header comment for
 * the exact three-way comparison algorithm.
 *
 * ## Design notes (deliberately additive, see Issue #689's "blast radius
 * tinggi" warning)
 *
 * - This file is **pure metadata** — it imports nothing from
 *   `scripts/validate-env.ts` or any `src/modules/*` config helper, and
 *   nothing in this repo imports actual validation *logic* from here. The
 *   ~30 `checkXxxConfig` functions already in `scripts/validate-env.ts`
 *   remain the executable, unit-tested source of truth for boot-time
 *   pass/fail behavior — this registry additionally documents which
 *   function governs which variable (`validatorGroup`, a human-readable
 *   name, not a callable reference) so the mapping is discoverable and
 *   testable without a risky circular-import refactor of already-working
 *   validation code.
 * - `required` reflects **today's actual `scripts/validate-env.ts`
 *   enforcement** (`"required"` = boot fails if empty; `"conditional"` =
 *   boot fails only when some other flag/mode is active; `"optional"` =
 *   never enforced). Deliberately NOT a 4th `"deprecated"` bucket like the
 *   issue's illustrative sketch — `deprecated` below is an ORTHOGONAL flag
 *   that can attach to a `"required"` entry. Two variables in this
 *   registry (`AUTH_JWT_SECRET`, `APP_TIMEZONE`) are simultaneously
 *   `required: "required"` (boot still fails without them, unchanged, for
 *   backward compatibility with every existing deployment's `.env`) AND
 *   `deprecated` (verified dead — see each entry's `migrationGuidance`). A
 *   single `required`-doubles-as-`deprecated` union could not express
 *   "still enforced today, but going away" without contradiction, so this
 *   registry splits the two concerns. Documented as a deliberate deviation
 *   from the issue's suggested shape in the Issue #689 implementation
 *   report.
 * - Marking something `deprecated` here never by itself changes
 *   `scripts/validate-env.ts`'s pass/fail behavior — see each entry's
 *   `migrationGuidance` for what, if anything, changed operationally
 *   (usually: nothing yet, a future major version removes the variable
 *   entirely per `removalVersion`).
 */

export type ConfigVarType =
  "string" | "boolean" | "integer" | "url" | "enum" | "path" | "csv" | "uuid";

/** Reflects current `scripts/validate-env.ts` boot-time enforcement — see file header. */
export type ConfigVarRequirement = "required" | "optional" | "conditional";

export type ConfigVarSensitivity = "secret" | "non-secret";

/** Matches `docs/awcms-mini/deployment-profiles.md`'s four profiles. */
export type DeploymentProfile =
  "development" | "staging" | "production" | "offline-lan";

export type ConfigVarDeprecation = {
  /** Version this deprecation notice first shipped in (this issue). */
  since: string;
  /** Target version the variable is planned to be removed in — never the same release as `since` (compatibility window). */
  removalVersion: string;
  /** What an operator should do: what replaces it, or why it's safe to stop setting it. */
  guidance: string;
};

export type ConfigVarEntry = {
  name: string;
  type: ConfigVarType;
  required: ConfigVarRequirement;
  /** Module key (see AGENTS.md §Peta modul) or `"deployment"` for infra-only vars consumed by shell scripts/docker-compose, never by TypeScript. */
  ownerModule: string;
  sensitivity: ConfigVarSensitivity;
  profiles: readonly DeploymentProfile[];
  default?: string;
  description: string;
  /** Name of the `scripts/validate-env.ts` function that enforces this var, or `undefined` if nothing validates it (never read, or read without a shape check). */
  validatorGroup?: string;
  deprecated?: ConfigVarDeprecation;
};

const ALL_PROFILES: readonly DeploymentProfile[] = [
  "development",
  "staging",
  "production",
  "offline-lan"
];

const ONLINE_PROFILES: readonly DeploymentProfile[] = ["staging", "production"];

/**
 * Every environment variable this repository's application code (or its
 * deployment tooling) reads, is documented as reading, or historically
 * claimed to read. One entry per variable — see file header for field
 * semantics.
 */
export const CONFIG_REGISTRY: readonly ConfigVarEntry[] = [
  // ---------------------------------------------------------------------
  // Inti aplikasi
  // ---------------------------------------------------------------------
  {
    name: "APP_ENV",
    type: "enum",
    required: "required",
    ownerModule: "foundation",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "development",
    description:
      "Deployment environment (development/staging/production) — read directly by scripts/production-preflight.ts and src/middleware.ts (cookie-secure gating), and validated against KNOWN_APP_ENV_VALUES.",
    validatorGroup: "checkRequiredVars + checkAppEnvValue"
  },
  {
    name: "APP_URL",
    type: "url",
    required: "required",
    ownerModule: "foundation",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "http://localhost:4321",
    description:
      "Base URL of the application — read by src/pages/api/v1/auth/password/forgot.ts to build the password-reset link.",
    validatorGroup: "checkRequiredVars"
  },
  {
    name: "APP_TIMEZONE",
    type: "string",
    required: "required",
    ownerModule: "foundation",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "Asia/Jakarta",
    description:
      "Documented as the application-wide default timezone, and still enforced non-empty at boot for backward compatibility.",
    validatorGroup: "checkRequiredVars",
    deprecated: {
      since: "0.24.0",
      removalVersion: "1.0.0",
      guidance:
        'Verified dead (Issue #689): no code reads process.env.APP_TIMEZONE. src/lib/i18n/format.ts hardcodes `const TIMEZONE = "Asia/Jakarta"` for all date/time formatting, and per-tenant timezone comes from `awcms_mini_tenant_settings.timezone` (DB, default "Asia/Jakarta" — src/modules/tenant-admin/application/tenant-settings-directory.ts), configurable per tenant via PATCH /api/v1/settings. This env var has zero runtime effect. Still required at boot for this release only to avoid a same-release behavior change for existing .env files; a future major version will drop the boot-time requirement and then the variable itself. Operators: use the tenant Settings screen (/admin/settings) to change a tenant\'s effective timezone, not this env var.'
    }
  },
  {
    name: "APP_DEFAULT_LOCALE",
    type: "enum",
    required: "optional",
    ownerModule: "foundation",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "id",
    description:
      "Documented as the default locale — not read by any request-time code path.",
    deprecated: {
      since: "0.24.0",
      removalVersion: "1.0.0",
      guidance:
        'Verified dead (Issue #689): `grep -rln "APP_DEFAULT_LOCALE" src scripts` returns no matches. The real source of truth is src/lib/i18n/locale.ts\'s hardcoded `DEFAULT_LOCALE: SupportedLocale = "en"`, used as the final fallback in the chain cookie locale -> tenant `awcms_mini_tenants.default_locale` (DB) -> `DEFAULT_LOCALE` (`resolveLocale`, doc 18 §Presedensi). This is the exact `id` (doc/.env.example) vs `en` (runtime) mismatch called out in Issue #689\'s evidence. Operators: set a tenant\'s default locale via the tenant record / Setup Wizard (DB `default_locale` column), not this env var. Do not rely on this variable to change the platform-wide fallback locale — it never has.'
    }
  },
  {
    name: "LOG_LEVEL",
    type: "enum",
    required: "optional",
    ownerModule: "observability-logging",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "info",
    description: "debug/info/warn/error — read by src/lib/logging/logger.ts."
  },
  {
    name: "AUDIT_LOG_RETENTION_DAYS",
    type: "integer",
    required: "optional",
    ownerModule: "observability-logging",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "730",
    description:
      "Retention (days) for awcms_mini_audit_events, consumed by `bun run logs:audit:purge` (scripts/audit-log-purge.ts); `--retention-days=<n>` CLI flag overrides it."
  },
  {
    name: "FORM_DRAFT_RETENTION_DAYS",
    type: "integer",
    required: "optional",
    ownerModule: "form-drafts",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "30",
    description:
      "Retention (days) for awcms_mini_form_drafts in expired/abandoned status, consumed by `bun run form-drafts:purge` (scripts/form-draft-purge.ts); `--retention-days=<n>` CLI flag takes precedence, then this var, then the code default FORM_DRAFT_DEFAULT_RETENTION_DAYS (30)."
  },

  // ---------------------------------------------------------------------
  // Database & pool
  // ---------------------------------------------------------------------
  {
    name: "DATABASE_URL",
    type: "url",
    required: "required",
    ownerModule: "database-connectivity",
    sensitivity: "secret",
    profiles: ALL_PROFILES,
    description:
      "PostgreSQL connection string for the least-privilege `awcms_mini_app` runtime role. A privileged/superuser URL is used ad hoc (override on the command line) for `bun run db:migrate` only.",
    validatorGroup: "checkRequiredVars"
  },
  {
    name: "AWCMS_MINI_APP_DB_PASSWORD",
    type: "string",
    required: "optional",
    ownerModule: "deployment",
    sensitivity: "secret",
    profiles: ["staging", "production", "offline-lan"],
    default: "awcms_mini_app_password",
    description:
      "Password used by deploy/postgres/10-create-app-role.sh and docker-compose.yml to create/connect the `awcms_mini_app` role at container init — must match the password embedded in DATABASE_URL. Not read by any TypeScript code (shell/compose only)."
  },
  {
    name: "DATABASE_POOL_MAX",
    type: "integer",
    required: "optional",
    ownerModule: "database-connectivity",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "20",
    description: "Max pool connections — src/lib/database/client.ts."
  },
  {
    name: "DATABASE_STATEMENT_TIMEOUT_MS",
    type: "integer",
    required: "optional",
    ownerModule: "database-connectivity",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "15000",
    description:
      "Per-connection statement_timeout GUC — src/lib/database/client.ts."
  },
  {
    name: "DATABASE_PGBOUNCER",
    type: "boolean",
    required: "optional",
    ownerModule: "database-connectivity",
    sensitivity: "non-secret",
    profiles: ["staging", "production"],
    default: "false",
    description:
      "Disables Bun.SQL automatic prepared statements when running behind PgBouncer transaction mode — src/lib/database/client.ts."
  },
  {
    name: "WORKER_DATABASE_URL",
    type: "url",
    required: "optional",
    ownerModule: "database-connectivity",
    sensitivity: "secret",
    profiles: ["staging", "production"],
    description:
      "Connection string for the least-privilege `awcms_mini_worker` role (Issue #683) used by the 9 unattended background scripts (count corrected by Issue #743). Falls back to DATABASE_URL (src/lib/database/client.ts's getWorkerDatabaseClient) when unset."
  },
  {
    name: "SETUP_DATABASE_URL",
    type: "url",
    required: "optional",
    ownerModule: "database-connectivity",
    sensitivity: "secret",
    profiles: ["staging", "production"],
    description:
      "Connection string for the least-privilege `awcms_mini_setup` role (Issue #683) used only by POST /api/v1/setup/initialize. Falls back to DATABASE_URL (src/lib/database/client.ts's getSetupDatabaseClient) when unset."
  },
  {
    name: "AWCMS_MINI_WORKER_DB_PASSWORD",
    type: "string",
    required: "optional",
    ownerModule: "deployment",
    sensitivity: "secret",
    profiles: ["staging", "production"],
    description:
      "Password used by deploy/postgres/11-create-worker-setup-roles.sh/docker-compose.yml to activate LOGIN on the optional `awcms_mini_worker` role. Not read by TypeScript code."
  },
  {
    name: "AWCMS_MINI_SETUP_DB_PASSWORD",
    type: "string",
    required: "optional",
    ownerModule: "deployment",
    sensitivity: "secret",
    profiles: ["staging", "production"],
    description:
      "Password used by deploy/postgres/11-create-worker-setup-roles.sh/docker-compose.yml to activate LOGIN on the optional `awcms_mini_setup` role. Not read by TypeScript code."
  },

  // ---------------------------------------------------------------------
  // Database capacity model (Issue #743, epic #738 platform-evolution).
  // ADDITIVE block — every entry below is optional with a conservative
  // default matching the existing single-instance offline/LAN profile (see
  // src/lib/database/capacity-config.ts's DEFAULT_* constants, the single
  // source of truth these defaults must stay in sync with). Keep this block
  // append-only/self-contained: a sibling issue in the same platform-
  // evolution epic (#745, data-lifecycle) may also add entries to this
  // file — resolve any merge conflict by keeping BOTH sides' additions,
  // never picking one over the other.
  // ---------------------------------------------------------------------
  {
    name: "DATABASE_POOL_MAX_WORKER",
    type: "integer",
    required: "optional",
    ownerModule: "database-connectivity",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    description:
      "Overrides the `awcms_mini_worker` pool's max connections independently of DATABASE_POOL_MAX — src/lib/database/client.ts's resolvePoolMaxForKind. Falls back to DATABASE_POOL_MAX when unset (pre-#743 behavior)."
  },
  {
    name: "DATABASE_POOL_MAX_SETUP",
    type: "integer",
    required: "optional",
    ownerModule: "database-connectivity",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    description:
      "Overrides the `awcms_mini_setup` pool's max connections independently of DATABASE_POOL_MAX — src/lib/database/client.ts's resolvePoolMaxForKind. Falls back to DATABASE_POOL_MAX when unset (pre-#743 behavior)."
  },
  {
    name: "DATABASE_WORK_CLASS_QUEUE_MULTIPLIER",
    type: "integer",
    required: "optional",
    ownerModule: "database-connectivity",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "4",
    description:
      "Bounded FIFO queue depth per work class = its concurrency max x this multiplier (clamped to [1, 20]) — src/lib/database/work-class.ts. Once a class's queue is at that cap, a new caller is rejected immediately (WorkClassQueueFullError, 503 + Retry-After) instead of queueing further."
  },
  {
    name: "DATABASE_CAPACITY_APP_INSTANCES_MIN",
    type: "integer",
    required: "optional",
    ownerModule: "database-connectivity",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "1",
    description:
      "Minimum expected concurrently-running web/SSR (`app`) instances — src/lib/database/capacity-config.ts, used by `database:capacity:check`/production-preflight's capacity stage."
  },
  {
    name: "DATABASE_CAPACITY_APP_INSTANCES_EXPECTED",
    type: "integer",
    required: "optional",
    ownerModule: "database-connectivity",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "1",
    description:
      "Steady-state expected concurrently-running `app` instances — src/lib/database/capacity-config.ts."
  },
  {
    name: "DATABASE_CAPACITY_APP_INSTANCES_MAX",
    type: "integer",
    required: "optional",
    ownerModule: "database-connectivity",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "1",
    description:
      "Configured horizontal ceiling on concurrently-running `app` instances — the number production:preflight's database:capacity stage validates `sum(instance_count x pool_max) + reserved_headroom <= approved capacity` against."
  },
  {
    name: "DATABASE_CAPACITY_WORKER_INSTANCES_MIN",
    type: "integer",
    required: "optional",
    ownerModule: "database-connectivity",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "0",
    description:
      "Minimum expected concurrently-running `worker` processes (the 9 scripts calling getWorkerDatabaseClient) — src/lib/database/capacity-config.ts. Default 0: worker scripts are periodic CLI invocations, not always-running daemons."
  },
  {
    name: "DATABASE_CAPACITY_WORKER_INSTANCES_EXPECTED",
    type: "integer",
    required: "optional",
    ownerModule: "database-connectivity",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "1",
    description:
      "Steady-state expected concurrently-running `worker` processes — src/lib/database/capacity-config.ts."
  },
  {
    name: "DATABASE_CAPACITY_WORKER_INSTANCES_MAX",
    type: "integer",
    required: "optional",
    ownerModule: "database-connectivity",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "1",
    description:
      "Configured horizontal ceiling on concurrently-running `worker` processes (e.g. multiple cron/scheduler hosts) — src/lib/database/capacity-config.ts."
  },
  {
    name: "DATABASE_CAPACITY_SETUP_INSTANCES_MIN",
    type: "integer",
    required: "optional",
    ownerModule: "database-connectivity",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "0",
    description:
      "Minimum expected concurrent `POST /api/v1/setup/initialize` callers — src/lib/database/capacity-config.ts. Default 0: the setup wizard is not steady-state traffic."
  },
  {
    name: "DATABASE_CAPACITY_SETUP_INSTANCES_EXPECTED",
    type: "integer",
    required: "optional",
    ownerModule: "database-connectivity",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "0",
    description:
      "Steady-state expected concurrent setup-wizard callers — src/lib/database/capacity-config.ts."
  },
  {
    name: "DATABASE_CAPACITY_SETUP_INSTANCES_MAX",
    type: "integer",
    required: "optional",
    ownerModule: "database-connectivity",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "1",
    description:
      "Configured ceiling on concurrent setup-wizard callers — src/lib/database/capacity-config.ts."
  },
  {
    name: "DATABASE_CAPACITY_PGBOUNCER_MAX_CLIENT_CONN",
    type: "integer",
    required: "optional",
    ownerModule: "database-connectivity",
    sensitivity: "non-secret",
    profiles: ["staging", "production"],
    default: "200",
    description:
      "Expected `pgbouncer.ini` max_client_conn — src/lib/database/capacity-config.ts's app-side capacity check when DATABASE_PGBOUNCER=true. Must match the operator's real pgbouncer.ini (deploy/pgbouncer/pgbouncer.ini.example) for the preflight capacity check to be meaningful; only read when DATABASE_PGBOUNCER=true."
  },
  {
    name: "DATABASE_CAPACITY_PGBOUNCER_DEFAULT_POOL_SIZE",
    type: "integer",
    required: "optional",
    ownerModule: "database-connectivity",
    sensitivity: "non-secret",
    profiles: ["staging", "production"],
    default: "20",
    description:
      "Expected `pgbouncer.ini` default_pool_size — src/lib/database/capacity-config.ts's server-side (PgBouncer-to-PostgreSQL) capacity check when DATABASE_PGBOUNCER=true."
  },
  {
    name: "DATABASE_CAPACITY_APPROVED_CONNECTIONS",
    type: "integer",
    required: "optional",
    ownerModule: "database-connectivity",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "100",
    description:
      "Approved PostgreSQL (or PgBouncer-fronted PostgreSQL) connection budget for this deployment — src/lib/database/capacity-config.ts. Defaults to PostgreSQL's own documented default max_connections (100); operators on a hosted/managed Postgres with a different approved budget MUST set this to the real approved number."
  },
  {
    name: "DATABASE_CAPACITY_RESERVED_ADMIN_CONNECTIONS",
    type: "integer",
    required: "optional",
    ownerModule: "database-connectivity",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "5",
    description:
      "Connections reserved for admin/migration/backup-restore recovery, carved out of DATABASE_CAPACITY_APPROVED_CONNECTIONS and NEVER available to app/worker/setup runtime pool sizing — src/lib/database/capacity-config.ts. `bun run db:migrate` and deploy/backup/*.sh connect ad hoc against this headroom, not a named pool."
  },

  // ---------------------------------------------------------------------
  // Auth & keamanan (core)
  // ---------------------------------------------------------------------
  {
    name: "AUTH_JWT_SECRET",
    type: "string",
    required: "required",
    ownerModule: "identity-access",
    sensitivity: "secret",
    profiles: ALL_PROFILES,
    default: "change-me-in-production",
    description:
      "HMAC key for the audit-log client-IP pseudonym (`ipHash`) written by the auth routes — src/lib/security/client-fingerprint.ts. Despite its name it does NOT sign session tokens: sessions are opaque random tokens (`awcms_mini_sessions.token_hash`) and src/lib/auth/jwt-verify.ts verifies provider ID tokens with RS256 against published JWKS, never with this secret. Must be a high-entropy value and must NOT be left at the documented placeholder: the audit `ipHash` is only as unguessable as this key (an unkeyed digest over the 2^32 IPv4 space is reversible in seconds). Rotating it breaks `ipHash` correlation across the rotation boundary — audit rows before and after no longer group by source.",
    validatorGroup: "checkRequiredVars + checkAuthJwtSecretNotDefault"
  },
  {
    name: "AUTH_SESSION_TTL_MIN",
    type: "integer",
    required: "optional",
    ownerModule: "identity-access",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "120",
    description: "Session lifetime (minutes) — auth/login.ts and friends."
  },
  {
    name: "AUTH_COOKIE_SECURE",
    type: "boolean",
    required: "optional",
    ownerModule: "identity-access",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "true",
    description:
      "Session cookie Secure flag — src/middleware.ts and every login/session-issuing route."
  },
  {
    name: "AUTH_LOGIN_MAX_ATTEMPTS",
    type: "integer",
    required: "optional",
    ownerModule: "identity-access",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "5",
    description: "Per-identity login lockout threshold — auth/login.ts."
  },
  {
    name: "AUTH_LOGIN_RATE_LIMIT_MAX",
    type: "integer",
    required: "optional",
    ownerModule: "identity-access",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "20",
    description:
      "Source+tenant volumetric rate limit for POST /auth/login (Issue #437)."
  },
  {
    name: "AUTH_LOGIN_RATE_LIMIT_WINDOW_SEC",
    type: "integer",
    required: "optional",
    ownerModule: "identity-access",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "60",
    description: "Window (seconds) for AUTH_LOGIN_RATE_LIMIT_MAX."
  },
  {
    name: "AUTH_PASSWORD_RESET_TOKEN_TTL_MIN",
    type: "integer",
    required: "optional",
    ownerModule: "identity-access",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "30",
    description:
      "Password-reset token lifetime (minutes) — auth/password/forgot.ts (Issue #496)."
  },
  {
    name: "AUTH_PASSWORD_RESET_RATE_LIMIT_MAX",
    type: "integer",
    required: "optional",
    ownerModule: "identity-access",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "5",
    description: "Rate limit for forgot/reset password per source+tenant."
  },
  {
    name: "AUTH_PASSWORD_RESET_RATE_LIMIT_WINDOW_SEC",
    type: "integer",
    required: "optional",
    ownerModule: "identity-access",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "900",
    description: "Window (seconds) for AUTH_PASSWORD_RESET_RATE_LIMIT_MAX."
  },

  // ---------------------------------------------------------------------
  // Full-online auth security hardening (Issue #587-#593)
  // ---------------------------------------------------------------------
  {
    name: "AUTH_ONLINE_SECURITY_ENABLED",
    type: "boolean",
    required: "optional",
    ownerModule: "identity-access",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "false",
    description:
      "Shared gate for Turnstile/MFA/Google login/SSO (Issue #587) — src/lib/auth/online-security-config.ts.",
    validatorGroup: "checkOnlineAuthSecurityConfig"
  },
  {
    name: "AUTH_ONLINE_SECURITY_PROFILE",
    type: "enum",
    required: "conditional",
    ownerModule: "identity-access",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "disabled",
    description:
      'Must be exactly "full_online" when AUTH_ONLINE_SECURITY_ENABLED=true.',
    validatorGroup: "checkOnlineAuthSecurityConfig"
  },
  {
    name: "TURNSTILE_ENABLED",
    type: "boolean",
    required: "optional",
    ownerModule: "identity-access",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "false",
    description:
      "Cloudflare Turnstile bot protection (Issue #588) — src/lib/security/turnstile.ts, src/pages/login.astro.",
    validatorGroup: "checkTurnstileConfig"
  },
  {
    name: "TURNSTILE_SITE_KEY",
    type: "string",
    required: "conditional",
    ownerModule: "identity-access",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    description:
      "Public Turnstile site key, rendered in the login widget (src/pages/login.astro) — required when TURNSTILE_ENABLED=true.",
    validatorGroup: "checkTurnstileConfig"
  },
  {
    name: "TURNSTILE_SECRET_KEY",
    type: "string",
    required: "conditional",
    ownerModule: "identity-access",
    sensitivity: "secret",
    profiles: ONLINE_PROFILES,
    description:
      "Server-side Turnstile verification secret — required when TURNSTILE_ENABLED=true.",
    validatorGroup: "checkTurnstileConfig"
  },
  {
    name: "TURNSTILE_VERIFY_TIMEOUT_MS",
    type: "integer",
    required: "optional",
    ownerModule: "identity-access",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "5000",
    description: "Timeout (ms) for the Cloudflare siteverify call."
  },
  {
    name: "AUTH_MFA_ENABLED",
    type: "boolean",
    required: "optional",
    ownerModule: "identity-access",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "false",
    description: "MFA/TOTP login challenge (Issue #589).",
    validatorGroup: "checkMfaConfig"
  },
  {
    name: "AUTH_MFA_SECRET_ENCRYPTION_KEY",
    type: "string",
    required: "conditional",
    ownerModule: "identity-access",
    sensitivity: "secret",
    profiles: ONLINE_PROFILES,
    description:
      "Base64-encoded 32-byte AES-256-GCM key encrypting TOTP secrets at rest — required when AUTH_MFA_ENABLED=true.",
    validatorGroup: "checkMfaConfig"
  },
  {
    name: "AUTH_MFA_TOTP_ISSUER",
    type: "string",
    required: "optional",
    ownerModule: "identity-access",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "AWCMS-Mini",
    description: "Issuer name shown in the authenticator app."
  },
  {
    name: "AUTH_MFA_TOTP_PERIOD_SEC",
    type: "integer",
    required: "optional",
    ownerModule: "identity-access",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "30",
    description: "TOTP time-step length (seconds)."
  },
  {
    name: "AUTH_MFA_TOTP_DIGITS",
    type: "integer",
    required: "optional",
    ownerModule: "identity-access",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "6",
    description: "TOTP code digit count (6 or 8)."
  },
  {
    name: "AUTH_MFA_CHALLENGE_TTL_SEC",
    type: "integer",
    required: "optional",
    ownerModule: "identity-access",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "300",
    description: "MFA login challenge lifetime (seconds)."
  },
  {
    name: "AUTH_MFA_RATE_LIMIT_MAX",
    type: "integer",
    required: "optional",
    ownerModule: "identity-access",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "5",
    description: "Rate limit for POST /auth/mfa/totp/verify per source+tenant."
  },
  {
    name: "AUTH_MFA_RATE_LIMIT_WINDOW_SEC",
    type: "integer",
    required: "optional",
    ownerModule: "identity-access",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "300",
    description: "Window (seconds) for AUTH_MFA_RATE_LIMIT_MAX."
  },
  {
    name: "AUTH_GOOGLE_LOGIN_ENABLED",
    type: "boolean",
    required: "optional",
    ownerModule: "identity-access",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "false",
    description: "Google OIDC login (Issue #590).",
    validatorGroup: "checkGoogleOidcConfig"
  },
  {
    name: "AUTH_GOOGLE_CLIENT_ID",
    type: "string",
    required: "conditional",
    ownerModule: "identity-access",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    description:
      "Google OAuth client ID — required when AUTH_GOOGLE_LOGIN_ENABLED=true.",
    validatorGroup: "checkGoogleOidcConfig"
  },
  {
    name: "AUTH_GOOGLE_CLIENT_SECRET",
    type: "string",
    required: "conditional",
    ownerModule: "identity-access",
    sensitivity: "secret",
    profiles: ONLINE_PROFILES,
    description:
      "Google OAuth client secret — required when AUTH_GOOGLE_LOGIN_ENABLED=true.",
    validatorGroup: "checkGoogleOidcConfig"
  },
  {
    name: "AUTH_GOOGLE_ALLOWED_DOMAINS",
    type: "csv",
    required: "optional",
    ownerModule: "identity-access",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    description:
      "Comma-separated email domains allowed to auto-link by email; empty = auto-link always denied (fail-closed)."
  },
  {
    name: "AUTH_GOOGLE_REDIRECT_PATH",
    type: "path",
    required: "optional",
    ownerModule: "identity-access",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "/api/v1/auth/providers/google/callback",
    description: "OAuth callback path under APP_URL."
  },
  {
    name: "AUTH_SSO_ENABLED",
    type: "boolean",
    required: "optional",
    ownerModule: "identity-access",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "false",
    description: "Generic tenant OIDC SSO (Issue #591).",
    validatorGroup: "checkSsoConfig"
  },
  {
    name: "AUTH_SSO_CREDENTIAL_ENCRYPTION_KEY",
    type: "string",
    required: "conditional",
    ownerModule: "identity-access",
    sensitivity: "secret",
    profiles: ONLINE_PROFILES,
    description:
      "Base64-encoded 32-byte AES-256-GCM key encrypting tenant SSO provider client secrets at rest — required when AUTH_SSO_ENABLED=true; must differ from AUTH_MFA_SECRET_ENCRYPTION_KEY.",
    validatorGroup: "checkSsoConfig"
  },
  {
    name: "AUTH_SSO_DISCOVERY_TIMEOUT_MS",
    type: "integer",
    required: "optional",
    ownerModule: "identity-access",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "5000",
    description: "Timeout (ms) for OIDC discovery/JWKS/token-exchange calls."
  },
  {
    name: "AUTH_SSO_MAX_PROVIDERS_PER_TENANT",
    type: "integer",
    required: "optional",
    ownerModule: "identity-access",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "20",
    description:
      "Caps active SSO provider rows per tenant (Issue #612), bounding per-tenant probing budget."
  },

  // ---------------------------------------------------------------------
  // Sync & node
  // ---------------------------------------------------------------------
  {
    name: "AWCMS_MINI_NODE_ID",
    type: "string",
    required: "optional",
    ownerModule: "sync-storage",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "local-dev-node",
    description:
      'Documented as "node identity" — not read by any application code.',
    deprecated: {
      since: "0.24.0",
      removalVersion: "1.0.0",
      guidance:
        'Verified dead (Issue #689): `grep -rn AWCMS_MINI_NODE_ID` across src/scripts finds zero consumers. Node identity is resolved from the database (`awcms_mini_sync_nodes`, node_code header/registration), not from this env var — see src/modules/sync-storage/application/sync-auth.ts\'s resolveOrRegisterSyncNode. Was already never enforced required by scripts/validate-env.ts (documented as "Wajib" in doc 18 but absent from REQUIRED_NON_EMPTY_VARS), so removing it changes nothing operationally. Operators: nothing to migrate — remove this line from .env whenever convenient.'
    }
  },
  {
    name: "AWCMS_MINI_SYNC_ENABLED",
    type: "boolean",
    required: "optional",
    ownerModule: "sync-storage",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "false",
    description:
      "Enables hybrid sync — src/modules/sync-storage/application/sync-auth.ts.",
    validatorGroup: "checkSyncConfig"
  },
  {
    name: "AWCMS_MINI_SYNC_HMAC_SECRET",
    type: "string",
    required: "conditional",
    ownerModule: "sync-storage",
    sensitivity: "secret",
    profiles: ALL_PROFILES,
    default: "change-me",
    description:
      "HMAC signing secret for sync requests — required (and must differ from the documented placeholder) when AWCMS_MINI_SYNC_ENABLED=true.",
    validatorGroup: "checkSyncConfig"
  },
  {
    name: "AWCMS_MINI_SYNC_MAX_SKEW_SEC",
    type: "integer",
    required: "optional",
    ownerModule: "sync-storage",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "300",
    description: "Anti-replay clock-skew tolerance (seconds)."
  },

  // ---------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------
  {
    name: "STORAGE_DRIVER",
    type: "enum",
    required: "optional",
    ownerModule: "sync-storage",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "local",
    description:
      "Documented as local/r2 storage driver selector — not actually branched on anywhere.",
    deprecated: {
      since: "0.24.0",
      removalVersion: "1.0.0",
      guidance:
        "Verified dead (Issue #689): `grep -rn STORAGE_DRIVER src scripts` only finds comments referencing the name, never `process.env.STORAGE_DRIVER`. The actual switch between local-only and R2 upload behavior is R2_ENABLED (src/modules/sync-storage/infrastructure/object-storage-uploader.ts's resolveObjectUploader, keyed off the object-sync queue row's own requires_upload flag, itself set from R2_ENABLED at enqueue time — src/pages/api/v1/sync/objects/index.ts). Operators: use R2_ENABLED=true/false; this variable has no effect regardless of its value."
    }
  },
  {
    name: "LOCAL_STORAGE_PATH",
    type: "path",
    required: "optional",
    ownerModule: "sync-storage",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "./storage",
    description: "Documented as the local file storage path — never read.",
    deprecated: {
      since: "0.24.0",
      removalVersion: "1.0.0",
      guidance:
        "Verified dead (Issue #689): `grep -rn LOCAL_STORAGE_PATH src scripts` finds zero reads (only comments/test fixtures asserting the news-portal R2-only preset never references it). No code path writes to this path today. Operators: nothing to migrate — remove this line from .env whenever convenient."
    }
  },
  {
    name: "OBJECT_SYNC_UPLOAD_TIMEOUT_MS",
    type: "integer",
    required: "optional",
    ownerModule: "sync-storage",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "10000",
    description:
      "Per-attempt timeout (ms) for the object-sync dispatcher (Issue #436)."
  },
  {
    name: "R2_ENABLED",
    type: "boolean",
    required: "optional",
    ownerModule: "sync-storage",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "false",
    description: "Enables Cloudflare R2 for the sync object queue.",
    validatorGroup: "checkR2Config"
  },
  {
    name: "R2_ACCOUNT_ID",
    type: "string",
    required: "conditional",
    ownerModule: "sync-storage",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    description:
      "Cloudflare R2 account id — required when R2_ENABLED=true. An account identifier, not a credential by itself (R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY are the actual secrets) — matches NEWS_MEDIA_R2_ACCOUNT_ID's classification (PR #709 review).",
    validatorGroup: "checkR2Config"
  },
  {
    name: "R2_ACCESS_KEY_ID",
    type: "string",
    required: "conditional",
    ownerModule: "sync-storage",
    sensitivity: "secret",
    profiles: ALL_PROFILES,
    description: "R2 credential — required when R2_ENABLED=true.",
    validatorGroup: "checkR2Config"
  },
  {
    name: "R2_SECRET_ACCESS_KEY",
    type: "string",
    required: "conditional",
    ownerModule: "sync-storage",
    sensitivity: "secret",
    profiles: ALL_PROFILES,
    description: "R2 credential — required when R2_ENABLED=true.",
    validatorGroup: "checkR2Config"
  },
  {
    name: "R2_BUCKET",
    type: "string",
    required: "conditional",
    ownerModule: "sync-storage",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    description:
      "R2 bucket name (private object queue) — required when R2_ENABLED=true; must differ from NEWS_MEDIA_R2_BUCKET.",
    validatorGroup: "checkR2Config"
  },

  // ---------------------------------------------------------------------
  // Email (base — Issue #493-#495)
  // ---------------------------------------------------------------------
  {
    name: "EMAIL_ENABLED",
    type: "boolean",
    required: "optional",
    ownerModule: "email",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "false",
    description: "Master switch for the generic email module.",
    validatorGroup: "checkEmailConfig"
  },
  {
    name: "EMAIL_PROVIDER",
    type: "enum",
    required: "conditional",
    ownerModule: "email",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    description: '"mailketing" or "log" — required when EMAIL_ENABLED=true.',
    validatorGroup: "checkEmailConfig"
  },
  {
    name: "EMAIL_FROM_ADDRESS",
    type: "string",
    required: "conditional",
    ownerModule: "email",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    description: "Default sender address — required when EMAIL_ENABLED=true.",
    validatorGroup: "checkEmailConfig"
  },
  {
    name: "EMAIL_FROM_NAME",
    type: "string",
    required: "optional",
    ownerModule: "email",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "AWCMS-Mini",
    description: "Default sender display name."
  },
  {
    name: "EMAIL_SEND_TIMEOUT_MS",
    type: "integer",
    required: "optional",
    ownerModule: "email",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "10000",
    description: "Timeout (ms) for one send attempt (dispatcher)."
  },
  {
    name: "EMAIL_SEND_MAX_RETRIES",
    type: "integer",
    required: "optional",
    ownerModule: "email",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "5",
    description: "Retry budget before marking an email `failed`."
  },
  {
    name: "EMAIL_MAILKETING_ACCOUNT_ID",
    type: "string",
    required: "conditional",
    ownerModule: "email",
    sensitivity: "secret",
    profiles: ALL_PROFILES,
    description:
      "Mailketing account id — required when EMAIL_PROVIDER=mailketing.",
    validatorGroup: "checkEmailConfig"
  },
  {
    name: "EMAIL_MAILKETING_API_TOKEN",
    type: "string",
    required: "conditional",
    ownerModule: "email",
    sensitivity: "secret",
    profiles: ALL_PROFILES,
    description:
      "Mailketing API token — required when EMAIL_PROVIDER=mailketing.",
    validatorGroup: "checkEmailConfig"
  },
  {
    name: "EMAIL_MAILKETING_API_BASE_URL",
    type: "url",
    required: "conditional",
    ownerModule: "email",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    description:
      "Mailketing API base URL — required when EMAIL_PROVIDER=mailketing.",
    validatorGroup: "checkEmailConfig"
  },

  // ---------------------------------------------------------------------
  // Public tenant routing (Issue #556, epic #555)
  // ---------------------------------------------------------------------
  {
    name: "PUBLIC_TENANT_RESOLUTION_MODE",
    type: "enum",
    required: "optional",
    ownerModule: "tenant-domain",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    description:
      "host_default/env_default/setup_default/tenant_code_legacy — unset keeps the legacy /blog/{tenantCode} behavior (offline/LAN default).",
    validatorGroup: "checkPublicRoutingConfig"
  },
  {
    name: "PUBLIC_DEFAULT_TENANT_ID",
    type: "uuid",
    required: "conditional",
    ownerModule: "tenant-domain",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    description:
      "Default tenant UUID for mode=env_default (one of ID/CODE required)."
  },
  {
    name: "PUBLIC_DEFAULT_TENANT_CODE",
    type: "string",
    required: "conditional",
    ownerModule: "tenant-domain",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    description:
      "Default tenant code for mode=env_default (one of ID/CODE required)."
  },
  {
    name: "PUBLIC_TENANT_CACHE_TTL_MS",
    type: "integer",
    required: "optional",
    ownerModule: "tenant-domain",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "60000",
    description:
      "TTL for the in-process host->tenant resolution cache (Issue #832). Bounds how long a tenant-domain change can stay stale on any app instance; 0 disables caching entirely."
  },
  {
    name: "PUBLIC_CANONICAL_BASE_PATH",
    type: "path",
    required: "optional",
    ownerModule: "tenant-domain",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "/news",
    description:
      "Public base path for /news — must be an absolute path when set.",
    validatorGroup: "checkPublicRoutingConfig"
  },
  {
    name: "PUBLIC_TRUST_PROXY",
    type: "boolean",
    required: "optional",
    ownerModule: "tenant-domain",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "false",
    description:
      "Trust X-Forwarded-Host — only safe true behind a trusted reverse proxy that overwrites the header."
  },
  {
    name: "PUBLIC_PLATFORM_ROOT_DOMAIN",
    type: "string",
    required: "conditional",
    ownerModule: "tenant-domain",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    description:
      "Root domain for the host-based resolver — required when mode=host_default.",
    validatorGroup: "checkPublicRoutingConfig"
  },

  // ---------------------------------------------------------------------
  // Cloudflare DNS adapter (Issue #567)
  // ---------------------------------------------------------------------
  {
    name: "TENANT_DOMAIN_DNS_PROVIDER",
    type: "enum",
    required: "optional",
    ownerModule: "tenant-domain",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "manual",
    description: "manual (default) or cloudflare.",
    validatorGroup: "checkTenantDomainDnsConfig"
  },
  {
    name: "TENANT_DOMAIN_PLATFORM_ROOT_DOMAIN",
    type: "string",
    required: "conditional",
    ownerModule: "tenant-domain",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    description:
      "Root domain the Cloudflare adapter may manage records under — required when TENANT_DOMAIN_DNS_PROVIDER=cloudflare. Deliberately separate from PUBLIC_PLATFORM_ROOT_DOMAIN (see doc 18).",
    validatorGroup: "checkTenantDomainDnsConfig"
  },
  {
    name: "TENANT_DOMAIN_CLOUDFLARE_ZONE_ID",
    type: "string",
    required: "conditional",
    ownerModule: "tenant-domain",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    description: "Cloudflare zone id — required when provider=cloudflare.",
    validatorGroup: "checkTenantDomainDnsConfig"
  },
  {
    name: "TENANT_DOMAIN_CLOUDFLARE_API_TOKEN",
    type: "string",
    required: "conditional",
    ownerModule: "tenant-domain",
    sensitivity: "secret",
    profiles: ONLINE_PROFILES,
    description: "Cloudflare API token — required when provider=cloudflare.",
    validatorGroup: "checkTenantDomainDnsConfig"
  },
  {
    name: "TENANT_DOMAIN_CLOUDFLARE_TIMEOUT_MS",
    type: "integer",
    required: "optional",
    ownerModule: "tenant-domain",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "8000",
    description: "Per-call timeout (ms) for the Cloudflare adapter."
  },

  // ---------------------------------------------------------------------
  // Visitor analytics (Issue #617-#624)
  // ---------------------------------------------------------------------
  {
    name: "VISITOR_ANALYTICS_ENABLED",
    type: "boolean",
    required: "optional",
    ownerModule: "visitor-analytics",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "false",
    description:
      "Master switch for visitor telemetry collection. Default-off since Issue #624 (2026-07-11 audit) — new installs collect nothing until explicitly enabled."
  },
  {
    name: "VISITOR_ANALYTICS_MODE",
    type: "enum",
    required: "optional",
    ownerModule: "visitor-analytics",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "basic",
    description: "basic/detailed.",
    validatorGroup: "checkVisitorAnalyticsConfig"
  },
  {
    name: "VISITOR_ANALYTICS_COLLECT_ADMIN",
    type: "boolean",
    required: "optional",
    ownerModule: "visitor-analytics",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "true",
    description: "Collect telemetry on /admin/* routes."
  },
  {
    name: "VISITOR_ANALYTICS_COLLECT_PUBLIC",
    type: "boolean",
    required: "optional",
    ownerModule: "visitor-analytics",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "true",
    description: "Collect telemetry on public routes."
  },
  {
    name: "VISITOR_ANALYTICS_COLLECT_API",
    type: "boolean",
    required: "optional",
    ownerModule: "visitor-analytics",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "false",
    description: "Collect telemetry on /api/v1/* calls."
  },
  {
    name: "VISITOR_ANALYTICS_DETAILED_ENABLED",
    type: "boolean",
    required: "optional",
    ownerModule: "visitor-analytics",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "false",
    description: "Reserve for detailed-mode session/event granularity."
  },
  {
    name: "VISITOR_ANALYTICS_RAW_IP_ENABLED",
    type: "boolean",
    required: "optional",
    ownerModule: "visitor-analytics",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "false",
    description: "Store raw IP addresses — default off (privacy-first)."
  },
  {
    name: "VISITOR_ANALYTICS_RAW_USER_AGENT_ENABLED",
    type: "boolean",
    required: "optional",
    ownerModule: "visitor-analytics",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "false",
    description:
      "Reserved — no raw user-agent column exists yet (migration 039 only stores a hash); currently a no-op."
  },
  {
    name: "VISITOR_ANALYTICS_GEO_ENABLED",
    type: "boolean",
    required: "optional",
    ownerModule: "visitor-analytics",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "false",
    description: "Enable geolocation enrichment (Issue #623)."
  },
  {
    name: "VISITOR_ANALYTICS_TRUST_PROXY",
    type: "boolean",
    required: "optional",
    ownerModule: "visitor-analytics",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "false",
    description:
      "Trust X-Forwarded-For — only safe true behind a trusted reverse proxy."
  },
  {
    name: "VISITOR_ANALYTICS_TRUST_CLOUDFLARE",
    type: "boolean",
    required: "optional",
    ownerModule: "visitor-analytics",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "false",
    description:
      "Trust CF-Connecting-IP/CF-IPCountry — only safe true when the origin is firewalled to Cloudflare's edge only."
  },
  {
    name: "VISITOR_ANALYTICS_ONLINE_WINDOW_SECONDS",
    type: "integer",
    required: "optional",
    ownerModule: "visitor-analytics",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "300",
    description: '"Online now" window.',
    validatorGroup: "checkVisitorAnalyticsConfig"
  },
  {
    name: "VISITOR_ANALYTICS_EVENT_RETENTION_DAYS",
    type: "integer",
    required: "optional",
    ownerModule: "visitor-analytics",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "90",
    description: "Event retention (days).",
    validatorGroup: "checkVisitorAnalyticsConfig"
  },
  {
    name: "VISITOR_ANALYTICS_RAW_DETAIL_RETENTION_DAYS",
    type: "integer",
    required: "optional",
    ownerModule: "visitor-analytics",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "30",
    description: "Raw detail retention (days).",
    validatorGroup: "checkVisitorAnalyticsConfig"
  },
  {
    name: "VISITOR_ANALYTICS_ROLLUP_RETENTION_DAYS",
    type: "integer",
    required: "optional",
    ownerModule: "visitor-analytics",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "730",
    description: "Rollup aggregate retention (days).",
    validatorGroup: "checkVisitorAnalyticsConfig"
  },
  {
    name: "VISITOR_ANALYTICS_HASH_SALT",
    type: "string",
    required: "optional",
    ownerModule: "visitor-analytics",
    sensitivity: "secret",
    profiles: ALL_PROFILES,
    default: "",
    description: "Salt for pseudonymous visitor fingerprinting (Issue #619)."
  },
  {
    name: "VISITOR_ANALYTICS_VISITOR_KEY_COOKIE_TTL_DAYS",
    type: "integer",
    required: "optional",
    ownerModule: "visitor-analytics",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "30",
    description:
      "Anonymous visitor-key cookie lifetime (days). Issue #624 audit addendum — replaces a previous hardcoded ~2-year lifetime with a short, configurable one.",
    validatorGroup: "checkVisitorAnalyticsConfig"
  },

  // ---------------------------------------------------------------------
  // News portal — full-online R2-only preset (Issue #632)
  // ---------------------------------------------------------------------
  {
    name: "NEWS_PORTAL_ENABLED",
    type: "boolean",
    required: "optional",
    ownerModule: "news-portal",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "false",
    description: "Master switch for the news_portal_full_online_r2 preset."
  },
  {
    name: "NEWS_PORTAL_PROFILE",
    type: "enum",
    required: "conditional",
    ownerModule: "news-portal",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    description: 'Must be "full_online_r2" when NEWS_PORTAL_ENABLED=true.',
    validatorGroup: "checkNewsPortalProfileConfig"
  },
  {
    name: "NEWS_MEDIA_R2_ENABLED",
    type: "boolean",
    required: "optional",
    ownerModule: "news-portal",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "false",
    description: "Master switch for R2-only news media storage.",
    validatorGroup: "checkNewsMediaR2Config"
  },
  {
    name: "NEWS_MEDIA_R2_ACCOUNT_ID",
    type: "string",
    required: "conditional",
    ownerModule: "news-portal",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    description:
      "May equal R2_ACCOUNT_ID (same Cloudflare account) or differ — required when NEWS_MEDIA_R2_ENABLED=true.",
    validatorGroup: "checkNewsMediaR2Config"
  },
  {
    name: "NEWS_MEDIA_R2_ACCESS_KEY_ID",
    type: "string",
    required: "conditional",
    ownerModule: "news-portal",
    sensitivity: "secret",
    profiles: ONLINE_PROFILES,
    description:
      "Must differ from R2_ACCESS_KEY_ID — enforced by config:validate/security:readiness.",
    validatorGroup:
      "checkNewsMediaR2Config + checkNewsMediaR2SeparationFromSyncR2"
  },
  {
    name: "NEWS_MEDIA_R2_SECRET_ACCESS_KEY",
    type: "string",
    required: "conditional",
    ownerModule: "news-portal",
    sensitivity: "secret",
    profiles: ONLINE_PROFILES,
    description:
      "Must differ from R2_SECRET_ACCESS_KEY — enforced by config:validate/security:readiness.",
    validatorGroup:
      "checkNewsMediaR2Config + checkNewsMediaR2SeparationFromSyncR2"
  },
  {
    name: "NEWS_MEDIA_R2_BUCKET",
    type: "string",
    required: "conditional",
    ownerModule: "news-portal",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    description:
      "Must differ from R2_BUCKET — enforced by config:validate/security:readiness.",
    validatorGroup:
      "checkNewsMediaR2Config + checkNewsMediaR2SeparationFromSyncR2"
  },
  {
    name: "NEWS_MEDIA_R2_PUBLIC_BASE_URL",
    type: "url",
    required: "conditional",
    ownerModule: "news-portal",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    description:
      "Absolute HTTPS custom domain — required when NEWS_MEDIA_R2_ENABLED=true; must not be *.r2.dev/localhost/127.0.0.1 when APP_ENV=production (Issue #635).",
    validatorGroup: "checkNewsMediaR2Config"
  },
  {
    name: "NEWS_MEDIA_R2_PRESIGNED_UPLOAD_TTL_SECONDS",
    type: "integer",
    required: "optional",
    ownerModule: "news-portal",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "300",
    description:
      "Presigned PUT upload TTL — maximum 3600 seconds (Issue #635).",
    validatorGroup: "checkNewsMediaR2PresignedTtlUpperBound"
  },
  {
    name: "NEWS_MEDIA_R2_MAX_UPLOAD_BYTES",
    type: "integer",
    required: "optional",
    ownerModule: "news-portal",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "10485760",
    description: "Per-file upload size limit (bytes)."
  },
  {
    name: "NEWS_MEDIA_R2_ALLOWED_MIME_TYPES",
    type: "csv",
    required: "optional",
    ownerModule: "news-portal",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "image/jpeg,image/png,image/webp,image/gif",
    description:
      "MIME allow-list — every entry must be a type the sniffer can recognize (Issue #635).",
    validatorGroup: "checkNewsMediaR2AllowedMimeTypesKnown"
  },
  {
    name: "NEWS_MEDIA_R2_PENDING_TTL_MINUTES",
    type: "integer",
    required: "optional",
    ownerModule: "news-portal",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "60",
    description:
      "Age threshold for stale pending_upload objects, reported by security:readiness."
  },
  {
    name: "NEWS_MEDIA_R2_ORPHAN_GRACE_DAYS",
    type: "integer",
    required: "optional",
    ownerModule: "news-portal",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "30",
    description:
      "Grace period (days) before bun run news-media:reconcile (Issue #690) physically deletes a grace-period-expired orphaned media object's R2 object + soft-deletes its metadata row. Minimum 30 days (r2-backup-lifecycle.md §3), enforced by config:validate."
  },

  // ---------------------------------------------------------------------
  // News portal — public social share buttons (Issue #642)
  // ---------------------------------------------------------------------
  {
    name: "NEWS_SHARE_BUTTONS_ENABLED",
    type: "boolean",
    required: "optional",
    ownerModule: "news-portal",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "true",
    description:
      "Master switch for the public share widget (native share/copy-link/WhatsApp/Telegram/Facebook/LinkedIn/X/email) on /news and /blog/{tenantCode} article pages — src/modules/blog-content/domain/social-share-links.ts."
  },
  {
    name: "NEWS_SHARE_NATIVE_ENABLED",
    type: "boolean",
    required: "optional",
    ownerModule: "news-portal",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "true",
    description:
      "Renders the native Web Share API button (navigator.share, revealed by public/js/news-share.js only in a secure context when supported)."
  },
  {
    name: "NEWS_SHARE_WHATSAPP_ENABLED",
    type: "boolean",
    required: "optional",
    ownerModule: "news-portal",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "true",
    description: "Renders the WhatsApp (wa.me) share link."
  },
  {
    name: "NEWS_SHARE_TELEGRAM_ENABLED",
    type: "boolean",
    required: "optional",
    ownerModule: "news-portal",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "true",
    description: "Renders the Telegram (t.me/share) share link."
  },
  {
    name: "NEWS_SHARE_FACEBOOK_ENABLED",
    type: "boolean",
    required: "optional",
    ownerModule: "news-portal",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "true",
    description: "Renders the Facebook Share Dialog link."
  },
  {
    name: "NEWS_SHARE_LINKEDIN_ENABLED",
    type: "boolean",
    required: "optional",
    ownerModule: "news-portal",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "true",
    description: "Renders the LinkedIn share-offsite link."
  },
  {
    name: "NEWS_SHARE_X_ENABLED",
    type: "boolean",
    required: "optional",
    ownerModule: "news-portal",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "true",
    description: "Renders the X/Twitter intent/tweet share link."
  },
  {
    name: "NEWS_SHARE_EMAIL_ENABLED",
    type: "boolean",
    required: "optional",
    ownerModule: "news-portal",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "true",
    description: "Renders the mailto: email share link."
  },
  {
    name: "NEWS_SHARE_INSTAGRAM_NATIVE_ONLY",
    type: "boolean",
    required: "optional",
    ownerModule: "news-portal",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "true",
    description:
      "There is no supported Instagram web-share intent URL, so this never renders a dedicated Instagram button — it only toggles a short text note clarifying that Instagram sharing goes through native share (when NEWS_SHARE_NATIVE_ENABLED=true) or copy-link, never a fake Instagram URL."
  },

  // ---------------------------------------------------------------------
  // Social publishing — provider-neutral auto-posting outbox foundation
  // (Issue #643, epic `social_publishing` #643-#647)
  // ---------------------------------------------------------------------
  {
    name: "SOCIAL_PUBLISHING_ENABLED",
    type: "boolean",
    required: "optional",
    ownerModule: "social-publishing",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "false",
    description:
      "Full-online-only master switch for the social publishing outbox/dispatcher (Issue #643) — src/modules/social-publishing/domain/social-publishing-config.ts.",
    validatorGroup: "checkSocialPublishingProfileConfig"
  },
  {
    name: "SOCIAL_PUBLISHING_PROFILE",
    type: "enum",
    required: "conditional",
    ownerModule: "social-publishing",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "disabled",
    description:
      'Must be exactly "full_online" when SOCIAL_PUBLISHING_ENABLED=true.',
    validatorGroup: "checkSocialPublishingProfileConfig"
  },

  // ---------------------------------------------------------------------
  // Social publishing — Meta (Facebook Page + Instagram Business) adapter
  // (Issue #644, epic `social_publishing` #643-#647)
  // ---------------------------------------------------------------------
  {
    name: "META_PROVIDER_ENABLED",
    type: "boolean",
    required: "optional",
    ownerModule: "social-publishing",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "false",
    description:
      "Adapter-level switch for the Meta (Facebook Page + Instagram Business) provider — independent of SOCIAL_PUBLISHING_ENABLED (a deployment can run social publishing with only a different provider configured). src/modules/social-publishing/domain/meta-provider-config.ts.",
    validatorGroup: "checkMetaSocialPublishingProviderConfig"
  },
  {
    name: "META_APP_ID",
    type: "string",
    required: "conditional",
    ownerModule: "social-publishing",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    description:
      "Meta App ID (developers.facebook.com) — required when META_PROVIDER_ENABLED=true. Not a credential by itself (public, used in appAccessToken construction alongside the app secret).",
    validatorGroup: "checkMetaSocialPublishingProviderConfig"
  },
  {
    name: "META_APP_SECRET_REFERENCE",
    type: "string",
    required: "conditional",
    ownerModule: "social-publishing",
    sensitivity: "secret",
    profiles: ONLINE_PROFILES,
    description:
      "Opaque reference into external secret storage for the Meta App Secret — required when META_PROVIDER_ENABLED=true. NEVER the raw app secret (rejected by checkMetaSocialPublishingProviderConfig if it looks like one — reuses social-account-validation.ts's looksLikeRawSecretToken, the same heuristic that protects awcms_mini_social_accounts.token_reference). Resolved to a real value the same way an account's token_reference is (meta-token-reference-resolver.ts) — only the \"env:VAR_NAME\" scheme is concretely supported today (no real secret-manager integration in this repo yet).",
    validatorGroup: "checkMetaSocialPublishingProviderConfig"
  },
  {
    name: "META_GRAPH_API_VERSION",
    type: "string",
    required: "conditional",
    ownerModule: "social-publishing",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "v21.0",
    description:
      "Graph API version this adapter targets (e.g. \"v21.0\") — required when META_PROVIDER_ENABLED=true. Operator responsibility to keep current with Meta's own deprecation schedule; only shape-validated here (^v\\d{1,2}\\.\\d{1,2}$), never checked against Meta's actually-supported versions.",
    validatorGroup: "checkMetaSocialPublishingProviderConfig"
  },
  {
    name: "META_OAUTH_REDIRECT_URI",
    type: "url",
    required: "conditional",
    ownerModule: "social-publishing",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    description:
      "Absolute HTTPS OAuth redirect URI registered in the Meta App dashboard — required when META_PROVIDER_ENABLED=true. Documented for app-review/Meta-dashboard configuration purposes; this issue ships no live OAuth authorization-code exchange route (accounts are connected via the existing generic POST /api/v1/social-publishing/accounts admin form, same as every other provider in this foundation) — see docs/awcms-mini/18_configuration_env_reference.md's Social publishing section.",
    validatorGroup: "checkMetaSocialPublishingProviderConfig"
  },
  {
    name: "META_REQUIRED_SCOPES",
    type: "csv",
    required: "conditional",
    ownerModule: "social-publishing",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default:
      "pages_manage_posts,pages_read_engagement,instagram_content_publish",
    description:
      "Comma-separated least-privilege Meta permission scopes this deployment requires a connected account's token to carry — required when META_PROVIDER_ENABLED=true. Enforced two ways: checkMetaSocialPublishingProviderConfig validates the list is non-empty/well-formed at boot, and the live 'verify connection' admin action (POST /api/v1/social-publishing/accounts/{id}/verify) compares this list against Meta's own debug_token response for a specific connected account.",
    validatorGroup: "checkMetaSocialPublishingProviderConfig"
  },

  // ---------------------------------------------------------------------
  // Social publishing — LinkedIn organization-page adapter (Issue #645,
  // epic `social_publishing` #643-#647). Independent of
  // SOCIAL_PUBLISHING_ENABLED/_PROFILE above — a deployment can run the
  // outbox without ever enabling LinkedIn specifically.
  // ---------------------------------------------------------------------
  {
    name: "LINKEDIN_PROVIDER_ENABLED",
    type: "boolean",
    required: "optional",
    ownerModule: "social-publishing",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "false",
    description:
      "Registers the LinkedIn organization-page provider adapter (Issue #645) into social-provider-registry.ts. No LinkedIn HTTP call happens when false.",
    validatorGroup: "checkLinkedInProviderConfig"
  },
  {
    name: "LINKEDIN_CLIENT_ID",
    type: "string",
    required: "conditional",
    ownerModule: "social-publishing",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    description:
      "LinkedIn App client ID — required when LINKEDIN_PROVIDER_ENABLED=true. Describes the LinkedIn App an operator registers in LinkedIn's Developer portal; this app does not implement an interactive OAuth redirect flow itself (see linkedin-provider-config.ts).",
    validatorGroup: "checkLinkedInProviderConfig"
  },
  {
    name: "LINKEDIN_CLIENT_SECRET_REFERENCE",
    type: "string",
    required: "conditional",
    ownerModule: "social-publishing",
    sensitivity: "secret",
    profiles: ONLINE_PROFILES,
    description:
      'A REFERENCE into external secret storage (e.g. "env:LINKEDIN_CLIENT_SECRET_ACTUAL"), never the raw client secret — rejected at readiness time if it looks like a raw secret/JWT (reuses social-account-validation.ts\'s looksLikeRawSecretToken). Required when LINKEDIN_PROVIDER_ENABLED=true.',
    validatorGroup: "checkLinkedInProviderConfig"
  },
  {
    name: "LINKEDIN_API_VERSION",
    type: "string",
    required: "conditional",
    ownerModule: "social-publishing",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    description:
      'LinkedIn versioned-API release string ("YYYYMM", e.g. "202506"), sent as the LinkedIn-Version header on every request. Required when LINKEDIN_PROVIDER_ENABLED=true.',
    validatorGroup: "checkLinkedInProviderConfig"
  },
  {
    name: "LINKEDIN_OAUTH_REDIRECT_URI",
    type: "string",
    required: "conditional",
    ownerModule: "social-publishing",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    description:
      "Redirect URI registered on the LinkedIn App — required for LinkedIn's own app-review/allow-list, even though this codebase does not implement the interactive authorize/callback flow itself. Required when LINKEDIN_PROVIDER_ENABLED=true.",
    validatorGroup: "checkLinkedInProviderConfig"
  },
  {
    name: "LINKEDIN_REQUIRED_SCOPES",
    type: "csv",
    required: "conditional",
    ownerModule: "social-publishing",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    description:
      "Comma-separated OAuth scopes a connected account must hold (e.g. \"w_organization_social,r_organization_social,rw_organization_admin\") — checked by the adapter's verifyCredentials against each account's stored scopes. Required when LINKEDIN_PROVIDER_ENABLED=true.",
    validatorGroup: "checkLinkedInProviderConfig"
  },

  // ---------------------------------------------------------------------
  // Social publishing — Telegram channel adapter (Issue #646)
  // ---------------------------------------------------------------------
  {
    name: "TELEGRAM_PROVIDER_ENABLED",
    type: "boolean",
    required: "optional",
    ownerModule: "social-publishing",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "false",
    description:
      "Provider-specific gate for the Telegram channel adapter, layered on top of SOCIAL_PUBLISHING_ENABLED/_PROFILE — src/modules/social-publishing/domain/telegram-config.ts.",
    validatorGroup: "checkTelegramProviderConfig"
  },
  {
    name: "TELEGRAM_BOT_TOKEN_SECRET_REFERENCE",
    type: "string",
    required: "conditional",
    ownerModule: "social-publishing",
    sensitivity: "secret",
    profiles: ONLINE_PROFILES,
    description:
      "Opaque reference into secret storage (e.g. env:MY_BOT_TOKEN_VAR) for this deployment's Telegram bot token — required when TELEGRAM_PROVIDER_ENABLED=true. Rejected at boot if it looks like a raw bot token (reuses social-account-validation.ts's looksLikeRawSecretToken). Kept primarily as a deployment-readiness signal; the adapter resolves the real token per-connected-account from that account's own token_reference using the same env: indirection.",
    validatorGroup: "checkTelegramProviderConfig"
  },
  {
    name: "TELEGRAM_DEFAULT_PARSE_MODE",
    type: "enum",
    required: "optional",
    ownerModule: "social-publishing",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    description:
      'Unset (default, plain text — safe, no formatting injection surface) or exactly "MarkdownV2"/"HTML" to opt into Telegram formatting. Every interpolated field is escaped per the active mode before being sent (telegram-message-formatting.ts). Legacy "Markdown" is deliberately not supported.',
    validatorGroup: "checkTelegramProviderConfig"
  },
  {
    name: "TELEGRAM_REQUEST_TIMEOUT_MS",
    type: "integer",
    required: "optional",
    ownerModule: "social-publishing",
    sensitivity: "non-secret",
    profiles: ONLINE_PROFILES,
    default: "10000",
    description:
      "Timeout (ms) for one Telegram Bot API request (publish or verify).",
    validatorGroup: "checkTelegramProviderConfig"
  },

  // ---------------------------------------------------------------------
  // Blog content — automatic internal tag linking (Issue #641)
  // ---------------------------------------------------------------------
  {
    name: "BLOG_AUTO_INTERNAL_TAG_LINKS_ENABLED",
    type: "boolean",
    required: "optional",
    ownerModule: "blog-content",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "true",
    description:
      "Deployment-wide kill switch for automatic internal tag linking — when false, no tenant can enable it regardless of its own per-tenant override.",
    validatorGroup: "checkBlogAutoInternalTagLinksConfig"
  },
  {
    name: "BLOG_AUTO_INTERNAL_TAG_LINKS_MAX_PER_POST",
    type: "integer",
    required: "optional",
    ownerModule: "blog-content",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "10",
    description:
      "Maximum total automatic internal tag links inserted per post (1-100).",
    validatorGroup: "checkBlogAutoInternalTagLinksConfig"
  },
  {
    name: "BLOG_AUTO_INTERNAL_TAG_LINKS_MAX_PER_TAG",
    type: "integer",
    required: "optional",
    ownerModule: "blog-content",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "1",
    description:
      "Maximum automatic links to the same tag within one post (1-20). Effectively capped at 1 when BLOG_AUTO_INTERNAL_TAG_LINKS_LINK_FIRST_OCCURRENCE_ONLY=true.",
    validatorGroup: "checkBlogAutoInternalTagLinksConfig"
  },
  {
    name: "BLOG_AUTO_INTERNAL_TAG_LINKS_MIN_TERM_LENGTH",
    type: "integer",
    required: "optional",
    ownerModule: "blog-content",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "3",
    description:
      "Tag names shorter than this (1-100 characters) are never auto-linked, to avoid noisy links on very short/common words.",
    validatorGroup: "checkBlogAutoInternalTagLinksConfig"
  },
  {
    name: "BLOG_AUTO_INTERNAL_TAG_LINKS_LINK_FIRST_OCCURRENCE_ONLY",
    type: "boolean",
    required: "optional",
    ownerModule: "blog-content",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "true",
    description:
      "When true, only the first occurrence of each matched tag in a post is linked (equivalent to capping BLOG_AUTO_INTERNAL_TAG_LINKS_MAX_PER_TAG at 1)."
  },
  {
    name: "BLOG_AUTO_INTERNAL_TAG_LINKS_EXCLUDE_HEADINGS",
    type: "boolean",
    required: "optional",
    ownerModule: "blog-content",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "true",
    description:
      "When true, text inside h1-h6 heading elements is never auto-linked (in addition to existing anchors, scripts, code/pre blocks, and figure captions, which are never linked regardless of this setting)."
  },
  // ---------------------------------------------------------------------
  // Data lifecycle (Issue #745, epic #738 platform-evolution)
  // ---------------------------------------------------------------------
  {
    name: "DATA_LIFECYCLE_ARCHIVE_ROOT_PATH",
    type: "path",
    required: "optional",
    ownerModule: "data-lifecycle",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "./var/data-lifecycle-archive",
    description:
      "Filesystem root the local/offline archive adapter (src/modules/data-lifecycle/infrastructure/local-archive-adapter.ts) writes archive artifacts under, one subdirectory per (tenantId, ownerModuleKey, tableShortName). The only new env var this issue adds — retention days/batch limits are already owned by each HighVolumeTableDescriptor in code (or, for a delegated adopter, by that module's own existing retention env var), never re-declared here."
  },
  // ---------------------------------------------------------------------
  // Integration Hub (Issue #754, epic #738 platform-evolution Wave 3) —
  // signed inbound webhooks, outbound event subscriptions, replay
  // protection, adapter health.
  // ---------------------------------------------------------------------
  {
    name: "INTEGRATION_HUB_ALLOW_PRIVATE_TARGETS",
    type: "boolean",
    required: "optional",
    ownerModule: "integration_hub",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "false",
    description:
      'The explicit "trusted deployment policy" opt-out from SSRF protection (src/modules/integration-hub/domain/ssrf-guard.ts) for outbound subscription delivery targets. Default false (private/link-local/metadata/reserved destinations blocked). A LAN-first deployment that legitimately wants to deliver webhooks to another system on the same private network sets this true — deployment-wide, never tenant/request-controlled.'
  },
  // ---------------------------------------------------------------------
  // Reporting projections/scheduled exports (Issue #753, epic #738
  // platform-evolution)
  // ---------------------------------------------------------------------
  {
    name: "REPORTING_EXPORT_ROOT_PATH",
    type: "path",
    required: "optional",
    ownerModule: "reporting",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "./var/reporting-exports",
    description:
      "Filesystem root the local/offline export adapter (src/modules/reporting/infrastructure/local-export-adapter.ts) writes scheduled/manual projection export artifacts under, one subdirectory per (tenantId, projectionKey). Same local-first posture as DATA_LIFECYCLE_ARCHIVE_ROOT_PATH — no external object storage dependency."
  },
  {
    name: "REPORTING_EXPORT_RETENTION_DAYS",
    type: "integer",
    required: "optional",
    ownerModule: "reporting",
    sensitivity: "non-secret",
    profiles: ALL_PROFILES,
    default: "7",
    description:
      "How many days a generated export artifact (and its awcms_mini_reporting_export_runs manifest row's expires_at) remains downloadable before GET /api/v1/reports/exports/{id}/download starts refusing it with 410 Gone."
  }
];

/** Explicit exemptions from `bun run config:docs:check`'s three-way parity gate (Issue #689 acceptance criteria: "every runtime env read registered or explicitly exempted"). */
export type ConfigExemption = {
  name: string;
  reason: string;
};

export const CONFIG_EXEMPTIONS: readonly ConfigExemption[] = [
  {
    name: "NODE_ENV",
    reason:
      "Platform-level Node.js/Bun convention, not read anywhere in this repo's application code (grep confirms zero matches) — not application-specific configuration."
  },
  {
    name: "PORT",
    reason:
      "Consumed internally by the @astrojs/node standalone adapter's own server bootstrap, not read by this repo's application code directly — platform-level, not application-specific configuration."
  },
  {
    name: "STARSENDER_ENABLED",
    reason:
      "Illustrative example content in doc 18 §Provider CRM for a retail/POS derived application (WhatsApp receipt) — not read anywhere in this base repo's code, not part of .env.example. Derived apps (e.g. AWPOS) add their own registry entry for it."
  },
  {
    name: "STARSENDER_API_KEY",
    reason: "Same as STARSENDER_ENABLED above."
  },
  {
    name: "MAILKETING_ENABLED",
    reason:
      "Illustrative example content in doc 18 §Provider CRM for a retail/POS derived application (\"email receipt\", historical issue #390, closed not planned) — deliberately distinct from this base's real EMAIL_ENABLED (generic email module, Issue #493). Not read anywhere in this base repo's code."
  },
  {
    name: "MAILKETING_API_TOKEN",
    reason: "Same as MAILKETING_ENABLED above."
  },
  {
    name: "AI_ANALYST_ENABLED",
    reason:
      "Illustrative example content in doc 18 §AI analyst for a derived application — not read anywhere in this base repo's code."
  },
  {
    name: "AI_PROVIDER_API_KEY",
    reason: "Same as AI_ANALYST_ENABLED above."
  },
  {
    name: "AI_MODEL",
    reason: "Same as AI_ANALYST_ENABLED above."
  }
];

export function findConfigVarEntry(name: string): ConfigVarEntry | undefined {
  return CONFIG_REGISTRY.find((entry) => entry.name === name);
}

export function listSecretConfigVarNames(): readonly string[] {
  return CONFIG_REGISTRY.filter((entry) => entry.sensitivity === "secret").map(
    (entry) => entry.name
  );
}

export function listDeprecatedConfigVarEntries(): readonly ConfigVarEntry[] {
  return CONFIG_REGISTRY.filter((entry) => entry.deprecated !== undefined);
}
