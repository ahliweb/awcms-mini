import { loadLocalEnvFiles } from "./_local-env.mjs";

const DEFAULT_EXPECTED_RESOURCE_UUID = "kbzbui977dnkhdzl8xcw6v90";
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
    expectedResourceUuid:
      normalizeOptionalString(process.env.COOLIFY_POSTGRES_RESOURCE_UUID) ||
      DEFAULT_EXPECTED_RESOURCE_UUID,
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

function getNestedServerIp(database) {
  return normalizeOptionalString(database?.destination?.server?.ip);
}

function selectDatabase(databases, expectedResourceUuid) {
  if (!Array.isArray(databases)) {
    throw new Error("Coolify database list response was not an array");
  }

  const exact = databases.find(
    (database) => database?.uuid === expectedResourceUuid,
  );

  if (exact) {
    return exact;
  }

  if (databases.length === 1) {
    return databases[0];
  }

  throw new Error(
    `Could not find Coolify PostgreSQL resource ${expectedResourceUuid}`,
  );
}

function buildPosture(database, expected) {
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
    serverIp: getNestedServerIp(database),
    serverUser: database?.destination?.server?.user ?? null,
    expected,
  };
}

function collectFindings(posture) {
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

  if (posture.serverUser === "root") {
    findings.push({
      severity: "medium",
      code: "coolify-root-server-user",
      message:
        "Coolify reports the server SSH user as root; confirm key-only SSH and non-root feasibility separately.",
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

async function main() {
  const config = readCoolifyConfig();
  const databases = await fetchCoolifyJson(config, "/api/v1/databases");
  const database = selectDatabase(databases, config.expectedResourceUuid);
  const posture = buildPosture(database, {
    resourceUuid: config.expectedResourceUuid,
    serverIp: config.expectedServerIp,
  });
  const findings = collectFindings(posture);

  const result = {
    ok: findings.length === 0,
    service: "coolify-postgres-posture",
    posture,
    findings,
    redaction:
      "Passwords, tokens, connection strings, and URLs are intentionally omitted.",
    timestamp: new Date().toISOString(),
  };

  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
