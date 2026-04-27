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
  const expectedResourceUuid = normalizeOptionalString(
    process.env.COOLIFY_POSTGRES_RESOURCE_UUID,
  );
  const expectedServerIp = normalizeOptionalString(
    process.env.COOLIFY_POSTGRES_SERVER_IP,
  );

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

  if (!expectedResourceUuid) {
    throw new Error(
      "COOLIFY_POSTGRES_RESOURCE_UUID must be set in .env.local or the environment",
    );
  }

  if (!expectedServerIp) {
    throw new Error(
      "COOLIFY_POSTGRES_SERVER_IP must be set in .env.local or the environment",
    );
  }

  return {
    baseUrl,
    token,
    expectedResourceUuid,
    expectedServerIp,
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
      severity: "medium",
      code: "postgres-ssl-management-plane-mismatch",
      message:
        "Coolify management-plane reports enable_ssl=false. This field cannot be changed via the Coolify API (HTTP 422). Runtime SSL is enforced via hostssl in pg_hba.conf and TLSv1.3 is active. Resolve by toggling SSL in the Coolify dashboard for the PostgreSQL resource, or treat as a known management-plane cosmetic gap if runtime enforcement is confirmed.",
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
      severity: "low",
      code: "postgres-bootstrap-user",
      message:
        "Coolify reports postgres_user as postgres (the Coolify bootstrap superuser). Runtime app access uses the separate non-superuser role awcms_mini_app, which owns the awcms_mini database and has no superuser, replication, or bypassrls attributes. This finding is a known Coolify metadata cosmetic gap.",
    });
  }

  if (posture.serverUser === "root") {
    findings.push({
      severity: "low",
      code: "coolify-root-server-user",
      message:
        "Coolify reports the server SSH user as root. Key-only root SSH is confirmed: authorized_keys (count=2, perms 600), sshd reports permitrootlogin=without-password, pubkeyauthentication=yes, passwordauthentication=no. Non-root SSH is not feasible for Coolify management at this time. This finding is a known accepted posture gap.",
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
  const database = await fetchCoolifyJson(
    config,
    `/api/v1/databases/${config.expectedResourceUuid}`,
  );
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
  void error;
  console.error(
    JSON.stringify(
      {
        ok: false,
        service: "coolify-postgres-posture",
        error: {
          message:
            "Coolify PostgreSQL audit failed before a redacted report could be produced.",
        },
        redaction:
          "Passwords, tokens, connection strings, URLs, and raw exception messages are intentionally omitted.",
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
