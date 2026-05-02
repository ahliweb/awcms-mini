import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const patchPath = path.resolve(repoRoot, "patches/emdash@0.9.0.patch");

function resolveReferenceRoot() {
  const envReferenceRoot = process.env.EMDASH_REFERENCE_ROOT?.trim();
  const candidates = [
    envReferenceRoot ? path.resolve(envReferenceRoot) : null,
    path.resolve(repoRoot, "../emdash/packages/core"),
    path.resolve(repoRoot, "../emdash-awcms/packages/core"),
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

const referenceRoot = resolveReferenceRoot();

function runGitApply(args) {
  return spawnSync("git", args, {
    cwd: referenceRoot,
    encoding: "utf8",
  });
}

function printCommandOutput(result) {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
}

if (!existsSync(referenceRoot)) {
  throw new Error(`Missing reference checkout: ${referenceRoot}`);
}

if (!existsSync(patchPath)) {
  throw new Error(`Missing compatibility patch: ${patchPath}`);
}

const checkArgs = ["apply", "--check", "--exclude=dist/**", patchPath];
const applyResult = runGitApply(checkArgs);

if ((applyResult.status ?? 1) === 0) {
  console.log("EmDash compatibility patch applies cleanly against the reference checkout.");
  process.exit(0);
}

printCommandOutput(applyResult);

const reverseResult = runGitApply(["apply", "--reverse", "--check", "--exclude=dist/**", patchPath]);

if ((reverseResult.status ?? 1) === 0) {
  console.log("Reference checkout already reflects the tracked compatibility patch; no drift detected.");
  process.exit(0);
}

printCommandOutput(reverseResult);
throw new Error("EmDash compatibility patch drift detected. Update the tracked patch or the reference checkout before merging.");
