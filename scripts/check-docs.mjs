#!/usr/bin/env bun
/**
 * check-docs.mjs — pemeriksa kualitas dokumentasi (Bun-only, tanpa dependency).
 *
 * Memeriksa seluruh berkas Markdown yang di-track git:
 *  1. Mermaid: setiap blok ```mermaid tertutup dan diawali tipe diagram dikenal.
 *  2. Tautan relatif Markdown menunjuk ke berkas/anchor yang ada.
 *  3. Regresi penamaan identifier `awcms-mini_` / `AWCMS-Mini_`.
 *  4. Nama service `docker compose`/`docker-compose` dalam prosa benar-benar
 *     ada di `docker-compose*.yml` (Issue #688, epic #679).
 *
 * Logika murni ada di `scripts/lib/docs-checks.mjs`; berkas ini menangani
 * I/O (git, filesystem) dan exit code. Jalankan: `bun run check:docs`.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  checkMermaid,
  checkNaming,
  extractLinks,
  classifyLink,
  splitTarget,
  headingSlugs,
  parseComposeServiceNames,
  checkComposeServiceNames
} from "./lib/docs-checks.mjs";

const ROOT = resolve(import.meta.dirname, "..");

/**
 * Union of service names from every `docker-compose*.yml` at repo root —
 * Issue #688. Both files are read once at startup; a service defined in
 * either is considered valid in prose (docs don't distinguish which
 * compose file a given walkthrough targets).
 * @returns {Set<string>}
 */
function loadComposeServiceNames() {
  /** @type {Set<string>} */
  const names = new Set();
  for (const file of ["docker-compose.yml", "docker-compose.prod.yml"]) {
    const full = join(ROOT, file);
    if (!existsSync(full)) continue;
    for (const name of parseComposeServiceNames(readFileSync(full, "utf8"))) {
      names.add(name);
    }
  }
  return names;
}

/** @typedef {import("./lib/docs-checks.mjs").Problem} Problem */

/** @returns {string[]} */
function listMarkdown() {
  const out = execFileSync("git", ["ls-files", "*.md"], {
    cwd: ROOT,
    encoding: "utf8"
  });
  // `git ls-files` mencerminkan index, bukan working tree — berkas yang
  // dihapus tapi belum di-stage (mis. changeset yang baru dikonsumsi) masih
  // muncul di sini. Saring agar hanya berkas yang benar-benar ada di disk.
  return out
    .split("\n")
    .filter(Boolean)
    .filter((file) => existsSync(join(ROOT, file)));
}

/**
 * Verifikasi tautan relatif menunjuk berkas (dan anchor) yang ada di disk.
 * @param {string} file
 * @param {string} content
 * @returns {Problem[]}
 */
function checkLinks(file, content) {
  /** @type {Problem[]} */
  const problems = [];
  const dir = dirname(join(ROOT, file));
  for (const { target, line } of extractLinks(content)) {
    if (classifyLink(target) !== "relative") continue;
    const { path, hash } = splitTarget(target);
    if (!path) continue;
    const resolved = path.startsWith("/")
      ? join(ROOT, path)
      : resolve(dir, path);

    // One read attempt per path instead of a check (existsSync/statSync)
    // followed by a *separate* later read of the same path (CodeQL
    // js/file-system-race — wrapping the second call in try/catch still
    // trips this rule, since the race is the two syscalls against one
    // path, not whether the second one's error is handled). `readFileSync`
    // alone tells us everything: ENOENT -> doesn't exist, EISDIR -> it's a
    // directory (a valid link target, just nothing to anchor-check), any
    // other outcome -> content in hand for the anchor check below.
    let targetContent;
    try {
      targetContent = readFileSync(resolved, "utf8");
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "EISDIR") {
        continue;
      }
      problems.push({ file, line, message: `tautan rusak: ${target}` });
      continue;
    }

    if (hash && resolved.endsWith(".md")) {
      const slugs = headingSlugs(targetContent);
      if (!slugs.has(hash.toLowerCase())) {
        problems.push({
          file,
          line,
          message: `anchor tidak ditemukan: #${hash}`
        });
      }
    }
  }
  return problems;
}

/** @returns {Problem[]} */
export function runChecks() {
  /** @type {Problem[]} */
  const problems = [];
  const composeServiceNames = loadComposeServiceNames();
  for (const file of listMarkdown()) {
    const content = readFileSync(join(ROOT, file), "utf8");
    const lines = content.split("\n");
    problems.push(...checkMermaid(file, lines));
    problems.push(...checkLinks(file, content));
    problems.push(...checkNaming(file, lines));
    problems.push(
      ...checkComposeServiceNames(file, content, composeServiceNames)
    );
  }
  return problems;
}

if (import.meta.main) {
  const problems = runChecks();
  if (problems.length > 0) {
    console.error(`check:docs GAGAL — ${problems.length} temuan:`);
    for (const p of problems)
      console.error(`  - ${p.file}:${p.line}: ${p.message}`);
    process.exit(1);
  }
  console.log(
    "check:docs OK — mermaid, tautan internal, penamaan, dan nama service docker compose valid."
  );
}
