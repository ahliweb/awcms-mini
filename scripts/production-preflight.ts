/**
 * Production preflight (doc 09 — pre-deploy checklist).
 * Menjalankan rangkaian check; berhenti FAIL pada langkah pertama yang gagal.
 * Set PREFLIGHT_SKIP_DB=1 untuk melewati langkah yang butuh database.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const skipDb = process.env.PREFLIGHT_SKIP_DB === "1";

type Step = { name: string; command: string[]; needsDb?: boolean };

const steps: Step[] = [
  { name: "api:spec:check", command: ["bun", "scripts/api-spec-check.ts"] },
  { name: "security:readiness", command: ["bun", "scripts/security-readiness.ts"] },
  { name: "test", command: ["bun", "test", "tests/"] },
  { name: "db:migrate:status", command: ["bun", "scripts/db-migrate.ts", "status"], needsDb: true },
  { name: "db:pool:health", command: ["bun", "scripts/db-pool-health.ts"], needsDb: true },
  { name: "build", command: ["bun", "run", "build"] }
];

let failed = false;
for (const step of steps) {
  if (step.needsDb && skipDb) {
    console.log(`SKIP ${step.name} (PREFLIGHT_SKIP_DB=1)`);
    continue;
  }
  console.log(`\n=== ${step.name} ===`);
  const result = spawnSync(step.command[0]!, step.command.slice(1), {
    cwd: ROOT,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    console.error(`\nproduction:preflight FAIL pada langkah: ${step.name}`);
    failed = true;
    break;
  }
}

if (!failed) console.log("\nproduction:preflight PASS — siap deploy.");
process.exitCode = failed ? 1 : 0;
