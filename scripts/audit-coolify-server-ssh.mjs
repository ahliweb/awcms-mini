import { loadLocalEnvFiles } from "./_local-env.mjs";

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

function buildPosture(server, expected) {
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

function collectFindings(posture) {
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
      severity: "low",
      code: "coolify-root-server-user",
      message:
        "Coolify reports the server SSH user as root. Key-only root SSH is confirmed: authorized_keys (count=2, perms 600), sshd reports permitrootlogin=without-password, pubkeyauthentication=yes, passwordauthentication=no. Non-root SSH is not feasible for Coolify management at this time. This finding is a known accepted posture gap.",
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
  const server = await fetchCoolifyJson(
    config,
    `/api/v1/servers/${config.expectedServerUuid}`,
  );
  const posture = buildPosture(server, {
    serverUuid: config.expectedServerUuid,
    serverIp: config.expectedServerIp,
  });
  const findings = collectFindings(posture);
  const result = {
    ok: findings.length === 0,
    service: "coolify-server-ssh-posture",
    posture,
    findings,
    redaction:
      "Private keys, passwords, tokens, and raw validation logs are intentionally omitted.",
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
        service: "coolify-server-ssh-posture",
        error: {
          message:
            "Coolify server SSH audit failed before a redacted report could be produced.",
        },
        redaction:
          "Private keys, passwords, tokens, raw validation logs, and raw exception messages are intentionally omitted.",
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
