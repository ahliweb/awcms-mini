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
  const expectedDatabaseUuid = normalizeOptionalString(
    process.env.COOLIFY_POSTGRES_RESOURCE_UUID,
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

  if (!expectedDatabaseUuid) {
    throw new Error(
      "COOLIFY_POSTGRES_RESOURCE_UUID must be set in .env.local or the environment",
    );
  }

  return { baseUrl, token, expectedDatabaseUuid };
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

function buildBackupPosture(backupConfig) {
  const latestExecution =
    Array.isArray(backupConfig.executions) && backupConfig.executions.length > 0
      ? backupConfig.executions[0]
      : null;

  return {
    uuid: backupConfig.uuid ?? null,
    enabled: backupConfig.enabled ?? null,
    saveS3: backupConfig.save_s3 ?? null,
    s3StorageId: backupConfig.s3_storage_id ?? null,
    frequency: backupConfig.frequency ?? null,
    databasesToBackup: backupConfig.databases_to_backup ?? null,
    dumpAll: backupConfig.dump_all ?? null,
    retentionLocalAmount: backupConfig.database_backup_retention_amount_locally ?? null,
    retentionLocalDays: backupConfig.database_backup_retention_days_locally ?? null,
    retentionS3Amount: backupConfig.database_backup_retention_amount_s3 ?? null,
    retentionS3Days: backupConfig.database_backup_retention_days_s3 ?? null,
    latestExecution: latestExecution
      ? {
          uuid: latestExecution.uuid ?? null,
          status: latestExecution.status ?? null,
          size: latestExecution.size ?? null,
          databaseName: latestExecution.database_name ?? null,
          filename: latestExecution.filename ?? null,
          s3Uploaded: latestExecution.s3_uploaded ?? null,
          finishedAt: latestExecution.finished_at ?? null,
          createdAt: latestExecution.created_at ?? null,
        }
      : null,
  };
}

function collectBackupFindings(posture) {
  const findings = [];

  if (posture.enabled !== true) {
    findings.push({
      severity: "critical",
      code: "backup-disabled",
      message: "Database backup schedule is not enabled.",
    });
  }

  if (!posture.latestExecution) {
    findings.push({
      severity: "high",
      code: "backup-no-execution",
      message: "No backup execution has been recorded.",
    });
  } else {
    if (posture.latestExecution.status !== "success") {
      findings.push({
        severity: "high",
        code: "backup-last-execution-failed",
        message:
          `Latest backup execution status is "${posture.latestExecution.status}". ` +
          `Last attempt: ${posture.latestExecution.finishedAt ?? posture.latestExecution.createdAt}.`,
      });
    }

    if (posture.saveS3 === true && posture.latestExecution.s3Uploaded !== true) {
      findings.push({
        severity: "medium",
        code: "backup-s3-not-uploaded",
        message:
          "S3 backup is enabled but the latest execution was not uploaded to S3.",
      });
    }
  }

  if (posture.saveS3 === false && posture.s3StorageId === null) {
    findings.push({
      severity: "low",
      code: "backup-s3-not-configured",
      message:
        "S3 backup destination is not configured. " +
        "Backups are stored locally only. " +
        "Set up R2 bucket coolify-backup-awcms-mini and link via Coolify dashboard.",
    });
  }

  if (posture.databasesToBackup !== "awcms_mini") {
    findings.push({
      severity: "medium",
      code: "backup-database-mismatch",
      message:
        `Backup targets "${posture.databasesToBackup}" instead of expected "awcms_mini".`,
    });
  }

  return findings;
}

async function main() {
  const config = readCoolifyConfig();

  const backupConfigs = await fetchCoolifyJson(
    config,
    `/api/v1/databases/${config.expectedDatabaseUuid}/backups`,
  );

  if (!Array.isArray(backupConfigs) || backupConfigs.length === 0) {
    const result = {
      ok: false,
      service: "coolify-backup",
      error: {
        code: "backup-no-config",
        message: "No backup configuration found for this database.",
      },
      redaction:
        "Passwords, tokens, private keys, raw validation logs, connection strings, and URLs are intentionally omitted.",
      timestamp: new Date().toISOString(),
    };
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  const backupPostures = backupConfigs.map((cfg) => buildBackupPosture(cfg));
  const allFindings = backupConfigs.flatMap((cfg) =>
    collectBackupFindings(buildBackupPosture(cfg)),
  );

  const result = {
    ok: allFindings.length === 0,
    service: "coolify-backup",
    checks: {
      backupConfigs: backupPostures,
    },
    findings: allFindings,
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
  void error;
  console.error(
    JSON.stringify(
      {
        ok: false,
        service: "coolify-backup",
        error: {
          message:
            "Coolify backup audit failed before a redacted report could be produced.",
        },
        redaction:
          "Passwords, tokens, private keys, raw validation logs, connection strings, URLs, and raw exception messages are intentionally omitted.",
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
