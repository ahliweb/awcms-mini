/**
 * Production-target safety interlock for the DR/chaos drill (Issue #699,
 * epic #679 platform-hardening). Pure functions, no I/O — mirrors
 * `scripts/production-preflight.ts`'s `authorizeApply` (Issue #684) in
 * shape (a single testable gate function, default-deny, an explicit
 * `--confirm-...=<value>` typo-catcher) but is STRICTER in one important
 * way: `authorizeApply` lets an operator apply migrations to a real
 * production database given the right flags; `authorizeDrDrill` NEVER
 * allows that, for ANY flag combination — a chaos/failure-injection tool
 * mutates state in ways a migration apply does not (killing workers,
 * forcing provider outages, dropping/recreating disposable databases), so
 * there is no legitimate reason it should ever be allowed to run against
 * anything that looks like production. `authorizeDrDrill`'s `APP_ENV`
 * check below has no bypass at all.
 *
 * Two independent checks, both must pass:
 * 1. `APP_ENV !== "production"` — hard refusal, no override.
 * 2. The DATABASE_URL host must look like an isolated/local/CI database
 *    (allowlist), and must NOT match a known production-hosting pattern
 *    (denylist) — anything else (an unrecognized host) is ALSO refused by
 *    default (default-deny: unrecognized is treated as "assume
 *    production-like" rather than "assume safe").
 *
 * Even once both checks pass, `--confirm-non-production=<APP_ENV value>`
 * is still required and must match `APP_ENV` exactly — the same
 * deliberate typo-catcher `production-preflight.ts`'s `--acknowledge-
 * target` uses, so an operator who runs this against the wrong shell/
 * `.env` gets a hard refusal instead of a silent chaos run.
 */

export type TargetLikelihood = {
  likely: boolean;
  reason: string;
};

/**
 * Hostnames that are DEFINITELY not an isolated dev/CI database, no matter
 * what APP_ENV claims — matched against the DATABASE_URL's hostname AND
 * against the full connection string (so a suffix like
 * `something.prod.internal` is also caught even when it's not the whole
 * hostname component boundary a strict hostname-only match might miss).
 */
const KNOWN_PRODUCTION_HOST_PATTERNS: RegExp[] = [
  /\.rds\.amazonaws\.com/i,
  /\.database\.azure\.com/i,
  /\.neon\.tech/i,
  /supabase\.co/i,
  /\.digitalocean\.com/i,
  /\bprod\b/i,
  /production/i
];

/** Hostnames recognized as local/isolated dev or CI infrastructure. */
const KNOWN_SAFE_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "postgres",
  "db",
  "0.0.0.0"
]);

/**
 * Pure inspection of a DATABASE_URL — never connects to anything. Default
 * deny: an unset, unparsable, or unrecognized-host URL is treated as
 * `likely: true` (production-like), never `false`.
 */
export function isProductionLikeTarget(
  databaseUrl: string | undefined
): TargetLikelihood {
  if (!databaseUrl) {
    return { likely: true, reason: "DATABASE_URL is not set." };
  }

  let hostname: string;

  try {
    hostname = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    return {
      likely: true,
      reason: "DATABASE_URL could not be parsed as a URL."
    };
  }

  const productionMatch = KNOWN_PRODUCTION_HOST_PATTERNS.find(
    (pattern) => pattern.test(hostname) || pattern.test(databaseUrl)
  );

  if (productionMatch) {
    return {
      likely: true,
      reason: `Database host "${hostname}" matches a known production-hosting pattern (${productionMatch}).`
    };
  }

  if (KNOWN_SAFE_HOSTS.has(hostname)) {
    return {
      likely: false,
      reason: `Database host "${hostname}" is in the recognized local/isolated allowlist.`
    };
  }

  return {
    likely: true,
    reason:
      `Database host "${hostname}" is not in the recognized local/isolated ` +
      `allowlist (${[...KNOWN_SAFE_HOSTS].join("/")}) — treated as ` +
      "production-like by default (default-deny)."
  };
}

export type AuthorizeDrDrillOptions = {
  appEnv: string | undefined;
  databaseUrl: string | undefined;
  confirmNonProduction: string | null;
};

export type AuthorizeDrDrillResult =
  { ok: true } | { ok: false; reason: string };

/**
 * The single gate every `dr-drill.ts` run must pass before ANY scenario
 * executes. Pure — no I/O — so this exact invariant is unit-testable
 * without a database or environment.
 */
export function authorizeDrDrill(
  options: AuthorizeDrDrillOptions
): AuthorizeDrDrillResult {
  if (options.appEnv === "production") {
    return {
      ok: false,
      reason:
        'APP_ENV="production" — DR/chaos drills are never permitted against ' +
        "a production-flagged environment. Unlike production:preflight's " +
        "migration-apply gate, this refusal has NO override flag."
    };
  }

  const targetCheck = isProductionLikeTarget(options.databaseUrl);

  if (targetCheck.likely) {
    return {
      ok: false,
      reason:
        `Refusing to run: ${targetCheck.reason} Point DATABASE_URL at an ` +
        "isolated/local/CI database. If this host is genuinely isolated " +
        "infrastructure, add it to the allowlist in " +
        "src/lib/resilience/target-guard.ts (KNOWN_SAFE_HOSTS) as a " +
        "deliberate, reviewed change — never by passing a flag."
    };
  }

  if (!options.confirmNonProduction) {
    return {
      ok: false,
      reason:
        "--confirm-non-production=<APP_ENV value> is required (typo-catcher, " +
        "mirrors production-preflight.ts's --acknowledge-target)."
    };
  }

  if (options.confirmNonProduction !== (options.appEnv ?? "")) {
    return {
      ok: false,
      reason:
        `--confirm-non-production="${options.confirmNonProduction}" does not ` +
        `match APP_ENV="${options.appEnv ?? ""}". Refusing to run against a ` +
        "target you have not explicitly acknowledged."
    };
  }

  return { ok: true };
}
