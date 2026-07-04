#!/usr/bin/env bun
/**
 * check-docs.mjs — pemeriksa kualitas dokumentasi (Bun-only, tanpa dependency).
 *
 * Memeriksa seluruh berkas Markdown yang di-track git:
 *  1. Mermaid: setiap blok ```mermaid tertutup dan diawali tipe diagram yang dikenal.
 *  2. Tautan relatif Markdown menunjuk ke berkas/anchor yang ada.
 *  3. Regresi penamaan: pola rusak `awcms-mini_` / `AWCMS-Mini_` (identifier SQL/env
 *     yang benar adalah `awcms_mini_` / `AWCMS_MINI_`).
 *
 * Exit non-zero bila ada temuan. Jalankan: `bun run check:docs`.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");

const MERMAID_TYPES = [
  "flowchart",
  "graph",
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "journey",
  "gantt",
  "pie",
  "gitGraph",
  "mindmap",
  "timeline",
  "quadrantChart",
  "requirementDiagram",
  "C4Context",
  "block-beta"
];

/** @returns {string[]} */
function listMarkdown() {
  const out = execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" });
  // `git ls-files` mencerminkan index, bukan working tree — berkas yang
  // dihapus tapi belum di-stage (mis. changeset yang baru dikonsumsi) masih
  // muncul di sini. Saring agar hanya berkas yang benar-benar ada di disk.
  return out
    .split("\n")
    .filter(Boolean)
    .filter((file) => existsSync(join(ROOT, file)));
}

/** @type {string[]} */
const problems = [];

/**
 * @param {string} file
 * @param {number} line
 * @param {string} msg
 */
function report(file, line, msg) {
  problems.push(`${file}:${line}: ${msg}`);
}

/**
 * @param {string} file
 * @param {string[]} lines
 */
function checkMermaid(file, lines) {
  let inBlock = false;
  let blockStart = 0;
  let sawType = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!inBlock && trimmed === "```mermaid") {
      inBlock = true;
      blockStart = i + 1;
      sawType = false;
      continue;
    }
    if (inBlock) {
      if (trimmed === "```") {
        if (!sawType) report(file, blockStart, "blok mermaid tanpa tipe diagram dikenal");
        inBlock = false;
        continue;
      }
      if (!sawType && trimmed.length > 0) {
        const first = (trimmed.split(/\s|\{/)[0] ?? "").trim();
        if (MERMAID_TYPES.includes(first)) sawType = true;
        else report(file, i + 1, `tipe diagram mermaid tak dikenal: "${first}"`);
        sawType = true; // hanya periksa baris konten pertama
      }
    }
  }
  if (inBlock) report(file, blockStart, "blok ```mermaid tidak ditutup");
}

/**
 * @param {string} file
 * @param {string} content
 */
function checkLinks(file, content) {
  const dir = dirname(join(ROOT, file));
  const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
  /** @type {RegExpExecArray | null} */
  let m;
  /** @type {number[]} */
  const lineOffsets = [];
  {
    let idx = 0;
    for (const ln of content.split("\n")) {
      lineOffsets.push(idx);
      idx += ln.length + 1;
    }
  }
  /** @param {number} pos */
  const lineOf = (pos) => {
    let lo = 0;
    let hi = lineOffsets.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const offset = lineOffsets[mid] ?? 0;
      if (offset <= pos) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans + 1;
  };
  while ((m = linkRe.exec(content))) {
    let target = (m[1] ?? "").trim();
    if (!target || target.startsWith("#")) continue;
    if (/^(https?:|mailto:|tel:|data:)/i.test(target)) continue;
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    const path = target.split("#")[0];
    if (!path) continue;
    const resolved = path.startsWith("/") ? join(ROOT, path) : resolve(dir, path);
    if (!existsSync(resolved)) {
      report(file, lineOf(m.index), `tautan rusak: ${target}`);
      continue;
    }
    // Jika ada anchor ke file .md, verifikasi heading tujuan.
    const hash = target.split("#")[1];
    if (hash && resolved.endsWith(".md") && statSync(resolved).isFile()) {
      const slugs = headingSlugs(readFileSync(resolved, "utf8"));
      if (!slugs.has(hash.toLowerCase())) {
        // toleran: hanya laporkan bila jelas tidak ada
        report(file, lineOf(m.index), `anchor tidak ditemukan: #${hash}`);
      }
    }
  }
}

/**
 * @param {string} md
 * @returns {Set<string>}
 */
function headingSlugs(md) {
  /** @type {Set<string>} */
  const set = new Set();
  for (const line of md.split("\n")) {
    const h = /^#{1,6}\s+(.*)$/.exec(line.trim());
    if (!h) continue;
    const slug = (h[1] ?? "")
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-");
    set.add(slug);
  }
  return set;
}

/**
 * @param {string} file
 * @param {string[]} lines
 */
function checkNaming(file, lines) {
  lines.forEach((line, i) => {
    if (/awcms-mini_[a-z]/.test(line) || /AWCMS-Mini_[A-Z]/.test(line)) {
      report(file, i + 1, "penamaan rusak (gunakan awcms_mini_ / AWCMS_MINI_)");
    }
  });
}

for (const file of listMarkdown()) {
  const content = readFileSync(join(ROOT, file), "utf8");
  const lines = content.split("\n");
  checkMermaid(file, lines);
  checkLinks(file, content);
  checkNaming(file, lines);
}

if (problems.length > 0) {
  console.error(`check:docs GAGAL — ${problems.length} temuan:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("check:docs OK — mermaid, tautan internal, dan penamaan valid.");
