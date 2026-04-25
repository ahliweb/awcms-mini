import { loadLocalEnvFiles } from "./_local-env.mjs";

const DEFAULT_EXPECTED_DATABASE_UUID = "kbzbui977dnkhdzl8xcw6v90";
const DEFAULT_EXPECTED_SERVER_UUID = "z7mcy4r3ejl6kno5neellf1f";
const DEFAULT_EXPECTED_SERVER_IP = "202.10.45.224";

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
      "COOLIFY_ACCESS_TOKEN must be set in .env.local or the environment",
    );
  }

  return {
    baseUrl,
    token,
    expectedDatabaseUuid:
      normalizeOptionalString(process.env.COOLIFY_POSTGRES_RESOURCE_UUID) ||
      DEFAULT_EXPECTED_DATABASE_UUID,
    expectedServerUuid:
      normalizeOptionalString(process.env.COOLIFY_POSTGRES_SERVER_UUID) ||
      DEFAULT_EXPECTED_SERVER_UUID,
    expectedServerIp:
      normalizeOptionalString(process.env.COOLIFY_POSTGRES_SERVER_IP) ||
      DEFAULT_EXPECTED_SERVER_IP,
  };
}

async function fetchCoolifyJson({ baseUrl, token }, pathname) {
  const response = await fetch(new URL(pathname, baseUrl), {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Coolify API request failed for ${pathname}: HTTP ${response.status}`,
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Coolify API response for ${pathname} was not valid JSON`);
  }
}

function buildPostgresPosture(database, expected) {
  return {
    uuid: database.uuid ?? null,
    name: database.name ?? null,
    databaseType: database.database_type ?? database.type ?? null,
    status: database.status ?? null,
    image: database.image ?? null,
    isPublic: database.is_public ?? null,
    hasExternalDbUrl: Boolean(
      normalizeOptionalString(database.external_db_url),
    ),
    enableSsl: database.enable_ssl ?? null,
    sslMode: database.ssl_mode ?? null,
    postgresUser: database.postgres_user ?? null,
    serverIp: normalizeOptionalString(database?.destination?.server?.ip),
    serverUser: database?.destination?.server?.user ?? null,
    expected,
  };
}

function buildServerPosture(server, expected) {
  return {
    uuid: server.uuid ?? null,
    name: server.name ?? null,
    ip: server.ip ?? null,
    port: server.port ?? null,
    user: server.user ?? null,
    isReachable: server.is_reachable ?? server.settings?.is_reachable ?? null,
    isUsable: server.is_usable ?? server.settings?.is_usable ?? null,
    isTerminalEnabled: server.settings?.is_terminal_enabled ?? null,
    isBuildServer: server.settings?.is_build_server ?? null,
    isCloudflareTunnel: server.settings?.is_cloudflare_tunnel ?? null,
    isJumpServer: server.settings?.is_jump_server ?? null,
    hasPrivateKeyReference: Boolean(server.private_key_id),
    proxyType: server.proxy?.type ?? server.proxy_type ?? null,
    proxyStatus: server.proxy?.status ?? null,
    expected,
  };
}

function collectPostgresFindings(posture) {
  const findings = [];

  if (posture.isPublic !== false) {
    findings.push({
      severity: "high",
      code: "postgres-public-exposure",
      message: "Coolify does not report the database as private.",
    });
  }

  if (posture.hasExternalDbUrl) {
    findings.push({
      severity: "high",
      code: "postgres-external-url",
      message: "Coolify reports an external database URL.",
    });
  }

  if (posture.enableSsl !== true) {
    findings.push({
      severity: "high",
      code: "postgres-ssl-disabled",
      message: "Coolify reports enable_ssl is not true.",
    });
  }

  if (posture.sslMode !== "require" && posture.sslMode !== "verify-full") {
    findings.push({
      severity: "medium",
      code: "postgres-ssl-mode",
      message: "Coolify reports an unexpected ssl_mode value.",
    });
  }

  if (posture.postgresUser === "postgres") {
    findings.push({
      severity: "medium",
      code: "postgres-bootstrap-user",
      message:
        "Coolify reports postgres_user as postgres; confirm the app runtime uses a separate non-superuser role.",
    });
  }

  if (posture.serverIp !== posture.expected.serverIp) {
    findings.push({
      severity: "medium",
      code: "postgres-server-ip",
      message:
        "Coolify reports a different server IP than the reviewed inventory.",
    });
  }

  return findings;
}

function collectServerFindings(posture) {
  const findings = [];

  if (posture.ip !== posture.expected.serverIp) {
    findings.push({
      severity: "medium",
      code: "coolify-server-ip",
      message:
        "Coolify reports a different server IP than the reviewed inventory.",
    });
  }

  if (posture.user === "root") {
    findings.push({
      severity: "medium",
      code: "coolify-root-server-user",
      message:
        "Coolify reports the server SSH user as root; confirm key-only SSH and non-root feasibility separately.",
    });
  }

  if (posture.isReachable !== true) {
    findings.push({
      severity: "high",
      code: "coolify-server-unreachable",
      message: "Coolify does not report the server as reachable.",
    });
  }

  if (posture.isUsable !== true) {
    findings.push({
      severity: "high",
      code: "coolify-server-unusable",
      message: "Coolify does not report the server as usable.",
    });
  }

  if (posture.hasPrivateKeyReference !== true) {
    findings.push({
      severity: "medium",
      code: "coolify-server-no-private-key-reference",
      message: "Coolify did not report a private-key reference for the server.",
    });
  }

  return findings;
}

async function main() {
  const config = readCoolifyConfig();
  const [database, server] = await Promise.all([
    fetchCoolifyJson(
      config,
      `/api/v1/databases/${config.expectedDatabaseUuid}`,
    ),
    fetchCoolifyJson(config, `/api/v1/servers/${config.expectedServerUuid}`),
  ]);
  const postgresPosture = buildPostgresPosture(database, {
    resourceUuid: config.expectedDatabaseUuid,
    serverIp: config.expectedServerIp,
  });
  const serverPosture = buildServerPosture(server, {
    serverUuid: config.expectedServerUuid,
    serverIp: config.expectedServerIp,
  });
  const findings = [
    ...collectPostgresFindings(postgresPosture).map((finding) => ({
      ...finding,
      area: "postgres",
    })),
    ...collectServerFindings(serverPosture).map((finding) => ({
      ...finding,
      area: "server",
    })),
  ];
  const result = {
    ok: findings.length === 0,
    service: "coolify-posture",
    checks: {
      postgres: postgresPosture,
      server: serverPosture,
    },
    findings,
    redaction:
      "Passwords, tokens, private keys, raw validation logs, connection strings, and URLs are intentionally omitted.",
    timestamp: new Date().toISOString(),
  };

  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        service: "coolify-posture",
        error: {
          message:
            error instanceof Error
              ? error.message
              : "Coolify posture audit failed",
        },
        redaction:
          "Passwords, tokens, private keys, raw validation logs, connection strings, and URLs are intentionally omitted.",
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
