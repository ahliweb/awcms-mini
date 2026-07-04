/**
 * Security readiness check (doc 07/13 — gate go-live).
 * Pemeriksaan statis repository; critical fail = exit non-zero (BLOCKED).
 *
 * Checks:
 * 1. .env tidak ter-track git; .gitignore meng-ignore .env.
 * 2. .env.example hanya placeholder (tanpa secret nyata).
 * 3. RLS coverage: semua tabel tenant-scoped di sql/ punya ENABLE+FORCE RLS + policy.
 * 4. File migration valid (nama, urutan, tanpa BEGIN/COMMIT).
 * 5. Bila APP_ENV=production: konfigurasi env valid (loadConfig).
 */
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/lib/config";
import { loadMigrationFiles } from "../src/lib/database/migrations";

const ROOT = join(import.meta.dirname, "..");
const failures: string[] = [];
const passes: string[] = [];

function record(okMessage: string, problem?: string): void {
  if (problem) failures.push(problem);
  else passes.push(okMessage);
}

async function checkEnvHygiene(): Promise<void> {
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const trackedEnv = tracked.filter(
    (file) => file === ".env" || (file.startsWith(".env.") && file !== ".env.example")
  );
  record(
    ".env tidak ter-track git",
    trackedEnv.length > 0 ? `File env ter-track git: ${trackedEnv.join(", ")}` : undefined
  );

  const gitignore = await readFile(join(ROOT, ".gitignore"), "utf8");
  record(
    ".gitignore meng-ignore .env",
    gitignore.includes(".env") ? undefined : ".gitignore tidak meng-ignore .env"
  );

  const example = await readFile(join(ROOT, ".env.example"), "utf8");
  const suspicious = example
    .split("\n")
    .filter((line) => /^(?:[A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD)[A-Z0-9_]*)=(?!\s*$)/.test(line))
    .filter((line) => {
      const value = line.split("=").slice(1).join("=").trim();
      const placeholders = ["change-me", "change-me-in-production", "awcms_password"];
      return value.length > 0 && !placeholders.includes(value);
    });
  record(
    ".env.example hanya placeholder",
    suspicious.length > 0
      ? `.env.example berisi nilai mencurigakan pada: ${suspicious
          .map((line) => line.split("=")[0])
          .join(", ")}`
      : undefined
  );
}

async function checkRlsCoverage(): Promise<void> {
  const sqlDir = join(ROOT, "sql");
  const files = (await readdir(sqlDir)).filter((name) => name.endsWith(".sql")).sort();
  let combined = "";
  for (const name of files) {
    combined += await readFile(join(sqlDir, name), "utf8");
  }

  // Tabel tenant-scoped = CREATE TABLE yang punya kolom tenant_id.
  const tableBlocks = combined.matchAll(
    /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\);/g
  );
  const tenantScoped: string[] = [];
  for (const match of tableBlocks) {
    const [, tableName, body] = match;
    if (tableName && body && /\btenant_id\s+uuid/.test(body)) tenantScoped.push(tableName);
  }
  record(
    `Ditemukan ${tenantScoped.length} tabel tenant-scoped di sql/`,
    tenantScoped.length === 0 ? "Tidak ada tabel tenant-scoped terdeteksi di sql/" : undefined
  );

  for (const table of tenantScoped) {
    const hasEnable = combined.includes(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    const hasForce = combined.includes(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    const hasPolicy = new RegExp(`CREATE POLICY \\w+\\s+ON ${table}\\b`).test(combined);
    record(
      `RLS aktif: ${table}`,
      hasEnable && hasForce && hasPolicy
        ? undefined
        : `Tabel tenant-scoped tanpa RLS lengkap (enable/force/policy): ${table}`
    );
  }
}

async function checkMigrations(): Promise<void> {
  try {
    const files = await loadMigrationFiles(join(ROOT, "sql"));
    record(`${files.length} file migration valid`);
  } catch (error) {
    record("", `Migration tidak valid: ${error instanceof Error ? error.message : error}`);
  }
}

function checkProductionConfig(): void {
  if (process.env.APP_ENV !== "production") {
    passes.push("APP_ENV bukan production — validasi env production dilewati");
    return;
  }
  try {
    loadConfig();
    passes.push("Konfigurasi env production valid");
  } catch (error) {
    failures.push(`Konfigurasi production tidak valid: ${error instanceof Error ? error.message : error}`);
  }
}

async function main(): Promise<void> {
  await checkEnvHygiene();
  await checkRlsCoverage();
  await checkMigrations();
  checkProductionConfig();

  for (const message of passes) console.log(`PASS ${message}`);
  for (const message of failures) console.error(`FAIL ${message}`);
  if (failures.length > 0) {
    console.error(`\nsecurity:readiness BLOCKED — ${failures.length} temuan.`);
    process.exitCode = 1;
  } else {
    console.log("\nsecurity:readiness PASS.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
