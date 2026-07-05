#!/usr/bin/env bun
/**
 * check-docs.mjs — pemeriksa kualitas dokumentasi (Bun-only, tanpa dependency).
 *
 * Memeriksa seluruh berkas Markdown yang di-track git:
 *  1. Mermaid: setiap blok ```mermaid tertutup dan diawali tipe diagram dikenal.
 *  2. Tautan relatif Markdown menunjuk ke berkas/anchor yang ada.
 *  3. Regresi penamaan identifier `awcms-mini_` / `AWCMS-Mini_`.
 *
 * Logika murni ada di `scripts/lib/docs-checks.mjs`; berkas ini menangani
 * I/O (git, filesystem) dan exit code. Jalankan: `bun run check:docs`.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  checkMermaid,
  checkNaming,
  extractLinks,
  classifyLink,
  splitTarget,
  headingSlugs
} from "./lib/docs-checks.mjs";

const ROOT = resolve(import.meta.dirname, "..");

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
    if (!existsSync(resolved)) {
      problems.push({ file, line, message: `tautan rusak: ${target}` });
      continue;
    }
    if (hash && resolved.endsWith(".md") && statSync(resolved).isFile()) {
      const slugs = headingSlugs(readFileSync(resolved, "utf8"));
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
  for (const file of listMarkdown()) {
    const content = readFileSync(join(ROOT, file), "utf8");
    const lines = content.split("\n");
    problems.push(...checkMermaid(file, lines));
    problems.push(...checkLinks(file, content));
    problems.push(...checkNaming(file, lines));
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
  console.log("check:docs OK — mermaid, tautan internal, dan penamaan valid.");
}
