/**
 * docs-checks.mjs — logika murni pemeriksa dokumentasi (tanpa I/O).
 *
 * Fungsi di sini bebas dari filesystem/git agar mudah di-unit-test.
 * Orkestrasi + I/O (git ls-files, baca berkas, resolve tautan, exit code)
 * berada di `scripts/check-docs.mjs`.
 */

/** Tipe diagram Mermaid yang dikenal. */
export const MERMAID_TYPES = [
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

/**
 * Satu temuan pemeriksaan.
 * @typedef {{ file: string, line: number, message: string }} Problem
 */

/**
 * Validasi blok ```mermaid: setiap blok tertutup dan diawali tipe diagram dikenal.
 * @param {string} file
 * @param {string[]} lines
 * @returns {Problem[]}
 */
export function checkMermaid(file, lines) {
  /** @type {Problem[]} */
  const problems = [];
  let inBlock = false;
  let blockStart = 0;
  let sawType = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? "").trim();
    if (!inBlock && trimmed === "```mermaid") {
      inBlock = true;
      blockStart = i + 1;
      sawType = false;
      continue;
    }
    if (inBlock) {
      if (trimmed === "```") {
        if (!sawType) {
          problems.push({
            file,
            line: blockStart,
            message: "blok mermaid tanpa tipe diagram dikenal"
          });
        }
        inBlock = false;
        continue;
      }
      if (!sawType && trimmed.length > 0) {
        const first = (trimmed.split(/\s|\{/)[0] ?? "").trim();
        if (!MERMAID_TYPES.includes(first)) {
          problems.push({
            file,
            line: i + 1,
            message: `tipe diagram mermaid tak dikenal: "${first}"`
          });
        }
        sawType = true; // hanya periksa baris konten pertama
      }
    }
  }
  if (inBlock) {
    problems.push({
      file,
      line: blockStart,
      message: "blok ```mermaid tidak ditutup"
    });
  }
  return problems;
}

/**
 * Slug heading gaya GitHub: lowercase, buang tanda baca (pertahankan word,
 * spasi, hyphen), lalu tiap whitespace → satu hyphen. GitHub **tidak**
 * menggabungkan spasi/hyphen beruntun, jadi `"a & b"` → `"a--b"`.
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s/g, "-");
}

/**
 * Kumpulan slug heading dari sebuah dokumen Markdown.
 * @param {string} md
 * @returns {Set<string>}
 */
export function headingSlugs(md) {
  /** @type {Set<string>} */
  const set = new Set();
  for (const line of md.split("\n")) {
    const h = /^#{1,6}\s+(.*)$/.exec(line.trim());
    if (h) set.add(slugify(h[1] ?? ""));
  }
  return set;
}

/**
 * Deteksi regresi penamaan identifier: `awcms-mini_x` / `AWCMS-Mini_X`
 * (yang benar `awcms_mini_x` / `AWCMS_MINI_X`).
 * @param {string} file
 * @param {string[]} lines
 * @returns {Problem[]}
 */
export function checkNaming(file, lines) {
  /** @type {Problem[]} */
  const problems = [];
  lines.forEach((line, i) => {
    if (/awcms-mini_[a-z]/.test(line) || /AWCMS-Mini_[A-Z]/.test(line)) {
      problems.push({
        file,
        line: i + 1,
        message: "penamaan rusak (gunakan awcms_mini_ / AWCMS_MINI_)"
      });
    }
  });
  return problems;
}

/**
 * Tautan Markdown yang diekstrak.
 * @typedef {{ target: string, index: number, line: number }} ExtractedLink
 */

/**
 * Ekstrak seluruh tautan `[teks](target)` beserta nomor barisnya.
 * @param {string} content
 * @returns {ExtractedLink[]}
 */
export function extractLinks(content) {
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
      if ((lineOffsets[mid] ?? 0) <= pos) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans + 1;
  };
  /** @type {ExtractedLink[]} */
  const links = [];
  const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
  /** @type {RegExpExecArray | null} */
  let m;
  while ((m = linkRe.exec(content))) {
    let target = (m[1] ?? "").trim();
    if (target.startsWith("<") && target.endsWith(">"))
      target = target.slice(1, -1);
    links.push({ target, index: m.index, line: lineOf(m.index) });
  }
  return links;
}

/**
 * Klasifikasi tautan untuk menentukan apakah perlu diverifikasi ke disk.
 * @param {string} target
 * @returns {"empty" | "anchor" | "external" | "relative"}
 */
export function classifyLink(target) {
  if (!target || target.startsWith("#"))
    return target.startsWith("#") ? "anchor" : "empty";
  if (/^(https?:|mailto:|tel:|data:)/i.test(target)) return "external";
  return "relative";
}

/**
 * Pisahkan target relatif menjadi path + anchor.
 * @param {string} target
 * @returns {{ path: string, hash: string | undefined }}
 */
export function splitTarget(target) {
  const [path, hash] = target.split("#");
  return { path: path ?? "", hash };
}
