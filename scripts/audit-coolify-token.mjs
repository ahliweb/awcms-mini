/**
 * audit-coolify-token.mjs
 *
 * Validates that the current COOLIFY_ACCESS_TOKEN in .env.local can
 * authenticate successfully against the Coolify API and has not been
 * revoked. Use this after rotating a Coolify token to confirm the new
 * token works before retiring the old one.
 *
 * Usage:
 *   pnpm audit:coolify-token
 *
 * Secrets:
 *   COOLIFY_ACCESS_TOKEN must be set in .env.local or the environment.
 *   Never commit a live token to tracked files.
 *
 * Output:
 *   JSON report. Secret-bearing fields are intentionally omitted.
 *   Exit code 0 = token valid. Exit code 1 = token invalid or revoked.
 */

import { loadLocalEnvFiles } from "./_local-env.mjs";

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const next = value.trim();
  return next.length > 0 ? next : null;
}

function readCoolifyConfig() {
  loadLocalEnvFiles();

  const baseUrl = normalizeOptionalString(process.env.COOLIFY_BASE_URL);
  const token = normalizeOptionalString(process.env.COOLIFY_ACCESS_TOKEN);

  if (!baseUrl) {
    throw new Error(
      "COOLIFY_BASE_URL must be set in .env, .env.local, or the environment",
    );
  }

  if (!token) {
    throw new Error(
      "COOLIFY_ACCESS_TOKEN must be set in .env.local or the environment. " +
        "After rotating the token in the Coolify dashboard, update .env.local with the new value.",
    );
  }

  return { baseUrl, token };
}

async function checkTokenValid({ baseUrl, token }) {
  const url = new URL("/api/v1/version", baseUrl);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  return {
    status: response.status,
    ok: response.ok,
  };
}

async function checkTokenScope({ baseUrl, token }) {
  // Try a read-only endpoint that requires authentication.
  const url = new URL("/api/v1/servers", baseUrl);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  return {
    status: response.status,
    ok: response.ok,
  };
}

async function main() {
  const config = readCoolifyConfig();

  const [versionCheck, scopeCheck] = await Promise.all([
    checkTokenValid(config),
    checkTokenScope(config),
  ]);

  const tokenOk = versionCheck.ok;
  const scopeOk = scopeCheck.ok;

  const result = {
    ok: tokenOk && scopeOk,
    service: "coolify-token-rotation-check",
    checks: {
      authentication: {
        endpoint: "/api/v1/version",
        httpStatus: versionCheck.status,
        passed: tokenOk,
        note: tokenOk
          ? "Token authenticates successfully."
          : "Token rejected. It may be revoked or invalid.",
      },
      readScope: {
        endpoint: "/api/v1/servers",
        httpStatus: scopeCheck.status,
        passed: scopeOk,
        note: scopeOk
          ? "Token has read access to server list."
          : scopeCheck.status === 403
            ? "Token authenticated but lacks server read scope. Confirm the token has the minimum required API scope."
            : "Server list request failed. Token may be revoked or scoped too narrowly.",
      },
    },
    guidance: {
      onRevoked:
        "In the Coolify dashboard, go to Keys & Tokens > API Tokens, create a new token with the smallest practical scope, update COOLIFY_ACCESS_TOKEN in .env.local, then rerun this check.",
      onSuccess:
        "Token is valid. Confirm the old (pre-rotation) token has been revoked in the Coolify dashboard.",
    },
    redaction:
      "Token values are intentionally omitted from this output. Never log or echo a live token.",
    timestamp: new Date().toISOString(),
  };

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");

  if (!result.ok) {
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(
    JSON.stringify(
      {
        ok: false,
        error: error.message,
        redaction:
          "Token values are intentionally omitted. Check COOLIFY_ACCESS_TOKEN in .env.local.",
      },
      null,
      2,
    ) + "\n",
  );
  process.exit(1);
});
