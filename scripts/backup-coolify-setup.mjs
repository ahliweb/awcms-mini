import { loadLocalEnvFiles } from "./_local-env.mjs";

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const next = value.trim();
  return next.length > 0 ? next : null;
}

function readConfig() {
  loadLocalEnvFiles();

  const baseUrl = normalizeOptionalString(process.env.COOLIFY_BASE_URL);
  const token = normalizeOptionalString(process.env.COOLIFY_ACCESS_TOKEN);
  const databaseUuid = normalizeOptionalString(
    process.env.COOLIFY_POSTGRES_RESOURCE_UUID,
  );

  if (!baseUrl || !token || !databaseUuid) {
    throw new Error(
      "COOLIFY_BASE_URL, COOLIFY_ACCESS_TOKEN, and COOLIFY_POSTGRES_RESOURCE_UUID must be set",
    );
  }

  return { baseUrl, token, databaseUuid };
}

async function fetchCoolifyJson({ baseUrl, token }, pathname, options) {
  const response = await fetch(new URL(pathname, baseUrl), {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...options,
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Coolify API request failed for ${pathname}: HTTP ${response.status} — ${text.substring(0, 500)}`,
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Coolify API response for ${pathname} was not valid JSON`);
  }
}

async function updateBackupConfig(config, backupUuid, updates) {
  return fetchCoolifyJson(
    config,
    `/api/v1/databases/${config.databaseUuid}/backups/${backupUuid}`,
    {
      method: "PATCH",
      body: JSON.stringify(updates),
    },
  );
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  pnpm coolify:backup-setup [options]",
      "",
      "Options:",
      "  --s3-storage-uuid <uuid>  Enable S3 backups with the given S3 storage UUID",
      "  --disable                 Disable the backup schedule",
      "  --enable                  Enable the backup schedule",
      "  --backup-now              Trigger an immediate backup",
      "  --status                  Show current backup configuration status",
      "",
      "Environment:",
      "  COOLIFY_BASE_URL              Coolify API base URL",
      "  COOLIFY_ACCESS_TOKEN          Coolify API token",
      "  COOLIFY_POSTGRES_RESOURCE_UUID  PostgreSQL resource UUID",
      "",
      "Backup config UUID: r3tr47lhqhoz9pd8m49stln2",
    ].join("\n"),
  );
}

async function showStatus(config) {
  const results = await fetchCoolifyJson(
    config,
    `/api/v1/databases/${config.databaseUuid}/backups`,
  );

  if (!Array.isArray(results) || results.length === 0) {
    console.log("No backup configuration found.");
    return;
  }

  for (const cfg of results) {
    const latest = (cfg.executions || [])[0];

    console.log(`Backup Config: ${cfg.uuid}`);
    console.log(`  Enabled:           ${cfg.enabled}`);
    console.log(`  Save to S3:        ${cfg.save_s3}`);
    console.log(`  S3 Storage UUID:   ${cfg.s3_storage_id ?? "not set"}`);
    console.log(`  Frequency:         ${cfg.frequency}`);
    console.log(`  Databases:         ${cfg.databases_to_backup}`);
    console.log(`  Dump All:          ${cfg.dump_all}`);
    console.log(`  Retention (local): ${cfg.database_backup_retention_amount_locally} copies / ${cfg.database_backup_retention_days_locally} days`);
    console.log(`  Retention (S3):    ${cfg.database_backup_retention_amount_s3} copies / ${cfg.database_backup_retention_days_s3} days`);

    if (latest) {
      console.log(`  Last Backup:`);
      console.log(`    Status:          ${latest.status}`);
      console.log(`    Size:            ${latest.size} bytes`);
      console.log(`    Database:        ${latest.database_name}`);
      console.log(`    S3 Uploaded:     ${latest.s3_uploaded ?? "no"}`);
      console.log(`    Finished:        ${latest.finished_at}`);
      console.log(`    File:            ${latest.filename}`);
    } else {
      console.log(`  No executions recorded.`);
    }

    console.log();
  }
}

async function main() {
  const config = readConfig();
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    printUsage();
    return;
  }

  if (args.includes("--status")) {
    await showStatus(config);
    return;
  }

  const backupUuid = "r3tr47lhqhoz9pd8m49stln2";
  const updates = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--s3-storage-uuid": {
        const uuid = args[++i];
        if (!uuid) {
          console.error("Error: --s3-storage-uuid requires a value");
          process.exit(1);
        }
        updates.save_s3 = true;
        updates.s3_storage_uuid = uuid;
        break;
      }
      case "--disable": {
        updates.enabled = false;
        break;
      }
      case "--enable": {
        updates.enabled = true;
        break;
      }
      case "--backup-now": {
        updates.backup_now = true;
        break;
      }
    }
  }

  if (Object.keys(updates).length === 0) {
    printUsage();
    return;
  }

  console.log(`Updating backup config ${backupUuid} with:`, updates);
  const result = await updateBackupConfig(config, backupUuid, updates);
  console.log("Result:", JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
