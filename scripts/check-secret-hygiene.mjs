import { readdir, readFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { extname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);

export const SECRET_HYGIENE_SCAN_TARGETS = [
  { path: ".env.example", type: "file" },
  { path: "README.md", type: "file" },
  { path: "scripts", type: "directory", extensions: [".mjs"] },
  { path: "docs/process", type: "directory", extensions: [".md"] },
  { path: "docs/security", type: "directory", extensions: [".md"] },
];

export const LOCAL_SECRET_FILE_PATTERNS = [
  ".env",
  ".env.*",
  ".dev.vars",
  ".dev.vars.*",
];

export const LOCAL_SECRET_FILE_ALLOWLIST = [".env.example"];

const SENSITIVE_ENV_SUFFIX_PATTERN =
  /(?:ACCESS_TOKEN|REFRESH_TOKEN|TOKEN|SECRET|SECRET_KEY|PASSWORD|ENCRYPTION_KEY|CLIENT_SECRET|PRIVATE_KEY|ACCESS_KEY)$/;
const SENSITIVE_ENV_ASSIGNMENT_PATTERN =
  /^\s*(?!#)([A-Z0-9_]+)=(.+?)\s*$/;
const SENSITIVE_PROCESS_ENV_ASSIGNMENT_PATTERN =
  /process\.env\.([A-Z0-9_]+)\s*=\s*(["'`])(.+?)\2/g;
const CREDENTIAL_URL_PATTERN =
  /\b(?:postgres(?:ql)?|mysql|mariadb|redis|amqps?|https?):\/\/[^\s`"'<>:@]+:[^\s`"'<>@]+@[^\s`"'<>]+/g;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g;

function isPlaceholderValue(value) {
  const normalized = value.trim();

  return (
    normalized.length === 0 ||
    normalized.includes("replace-with-") ||
    normalized.includes("<password>") ||
    normalized.includes("<local-only-secret>") ||
    normalized.includes("<") ||
    normalized.startsWith("$")
  );
}

function createFinding(filePath, lineNumber, kind, detail, line) {
  return {
    filePath,
    lineNumber,
    kind,
    detail,
    line: line.trim(),
  };
}

export function isTrackedLocalSecretFile(filePath) {
  const normalized = filePath.trim();

  if (!normalized || LOCAL_SECRET_FILE_ALLOWLIST.includes(normalized)) {
    return false;
  }

  return (
    normalized === ".env" ||
    normalized.startsWith(".env.") ||
    normalized === ".dev.vars" ||
    normalized.startsWith(".dev.vars.")
  );
}

export function scanSecretHygieneLine(filePath, line, lineNumber) {
  const findings = [];
  const envAssignmentMatch = line.match(SENSITIVE_ENV_ASSIGNMENT_PATTERN);

  if (envAssignmentMatch) {
    const [, key, value] = envAssignmentMatch;

    if (SENSITIVE_ENV_SUFFIX_PATTERN.test(key) && !isPlaceholderValue(value)) {
      findings.push(createFinding(filePath, lineNumber, "sensitive-env-assignment", key, line));
    }
  }

  for (const match of line.matchAll(SENSITIVE_PROCESS_ENV_ASSIGNMENT_PATTERN)) {
    const [, key, , value] = match;

    if (SENSITIVE_ENV_SUFFIX_PATTERN.test(key) && !isPlaceholderValue(value)) {
      findings.push(createFinding(filePath, lineNumber, "sensitive-process-env-assignment", key, line));
    }
  }

  for (const match of line.matchAll(CREDENTIAL_URL_PATTERN)) {
    findings.push(createFinding(filePath, lineNumber, "credential-url", match[0], line));
  }

  for (const match of line.matchAll(BEARER_TOKEN_PATTERN)) {
    findings.push(createFinding(filePath, lineNumber, "bearer-token", match[0], line));
  }

  return findings;
}

export function scanSecretHygieneText(filePath, text) {
  return text
    .split(/\r?\n/)
    .flatMap((line, index) => scanSecretHygieneLine(filePath, line, index + 1));
}

export async function listTrackedFiles(rootDir = process.cwd()) {
  const { stdout } = await execFile("git", ["ls-files", "--cached"], {
    cwd: rootDir,
    encoding: "utf8",
  });

  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

export async function findTrackedLocalSecretFiles(rootDir = process.cwd(), trackedFiles = null) {
  const files = trackedFiles ?? (await listTrackedFiles(rootDir));
  return files.filter(isTrackedLocalSecretFile);
}

async function collectFilesFromDirectory(rootDir, directoryPath, extensions) {
  const absoluteDirectoryPath = join(rootDir, directoryPath);
  const entries = await readdir(absoluteDirectoryPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = join(absoluteDirectoryPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectFilesFromDirectory(rootDir, relative(rootDir, entryPath), extensions)));
      continue;
    }

    if (extensions.includes(extname(entry.name))) {
      files.push(entryPath);
    }
  }

  return files;
}

export async function collectSecretHygieneTargets(rootDir = process.cwd()) {
  const files = [];

  for (const target of SECRET_HYGIENE_SCAN_TARGETS) {
    if (target.type === "file") {
      files.push(join(rootDir, target.path));
      continue;
    }

    files.push(...(await collectFilesFromDirectory(rootDir, target.path, target.extensions)));
  }

  return files.sort();
}

export async function scanSecretHygieneFiles(rootDir = process.cwd()) {
  const files = await collectSecretHygieneTargets(rootDir);
  const findings = [];
  const trackedLocalSecretFiles = await findTrackedLocalSecretFiles(rootDir);

  for (const filePath of files) {
    const contents = await readFile(filePath, "utf8");
    findings.push(...scanSecretHygieneText(relative(rootDir, filePath), contents));
  }

  for (const filePath of trackedLocalSecretFiles) {
    findings.push(createFinding(filePath, 0, "tracked-local-secret-file", filePath, filePath));
  }

  return { files, findings };
}

async function main() {
  const { files, findings } = await scanSecretHygieneFiles();

  if (findings.length === 0) {
    console.log(`Secret hygiene check passed for ${files.length} maintained files.`);
    return;
  }

  console.error(`Secret hygiene check failed with ${findings.length} finding(s):`);

  for (const finding of findings) {
    console.error(`- ${finding.filePath}:${finding.lineNumber} [${finding.kind}] ${finding.detail}`);
    console.error(`  ${finding.line}`);
  }

  process.exit(1);
}

const entryScriptPath = process.argv[1] ? fileURLToPath(new URL(import.meta.url)) : null;

if (entryScriptPath && resolve(process.argv[1]) === entryScriptPath) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
