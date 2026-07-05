/**
 * Unit test untuk logika murni pemeriksa dokumentasi
 * (`scripts/lib/docs-checks.mjs`). Dijalankan dengan `bun test`.
 */
import { describe, expect, test } from "bun:test";
import {
  MERMAID_TYPES,
  checkMermaid,
  slugify,
  headingSlugs,
  checkNaming,
  extractLinks,
  classifyLink,
  splitTarget
} from "../scripts/lib/docs-checks.mjs";

/** @param {string} s */
const lines = (s) => s.split("\n");

describe("checkMermaid", () => {
  test("blok valid (flowchart) tidak menghasilkan temuan", () => {
    const md = "```mermaid\nflowchart LR\n  A --> B\n```";
    expect(checkMermaid("f.md", lines(md))).toEqual([]);
  });

  test("menerima semua tipe diagram yang dikenal", () => {
    for (const type of MERMAID_TYPES) {
      const md = "```mermaid\n" + type + "\n```";
      expect(checkMermaid("f.md", lines(md))).toEqual([]);
    }
  });

  test("tipe diagram tak dikenal dilaporkan dengan nomor baris", () => {
    const md = "intro\n```mermaid\nbogus X\n```";
    const problems = checkMermaid("f.md", lines(md));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("bogus");
    expect(problems[0]?.line).toBe(3);
  });

  test("blok mermaid kosong dilaporkan", () => {
    const md = "```mermaid\n```";
    const problems = checkMermaid("f.md", lines(md));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("tanpa tipe diagram");
  });

  test("blok tidak ditutup dilaporkan", () => {
    const md = "```mermaid\nflowchart LR\n  A --> B";
    const problems = checkMermaid("f.md", lines(md));
    expect(problems.some((p) => p.message.includes("tidak ditutup"))).toBe(
      true
    );
  });

  test("hanya baris konten pertama yang divalidasi (isi diagram bebas)", () => {
    const md =
      "```mermaid\nflowchart LR\n  pos --> checkout\n  tax --> vat\n```";
    expect(checkMermaid("f.md", lines(md))).toEqual([]);
  });

  test("dua blok, satu rusak satu valid", () => {
    const md = [
      "```mermaid",
      "flowchart LR",
      "A-->B",
      "```",
      "",
      "```mermaid",
      "nope",
      "```"
    ].join("\n");
    const problems = checkMermaid("f.md", lines(md));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("nope");
  });

  test("tipe dengan atribut { } tetap dikenali", () => {
    const md = "```mermaid\nflowchart TB\n```";
    expect(checkMermaid("f.md", lines(md))).toEqual([]);
  });

  test("dokumen tanpa mermaid tidak menghasilkan temuan", () => {
    expect(checkMermaid("f.md", lines("# Judul\n\nteks biasa"))).toEqual([]);
  });
});

describe("slugify / headingSlugs", () => {
  test("slugify gaya GitHub", () => {
    expect(slugify("Arsitektur Tingkat Tinggi")).toBe(
      "arsitektur-tingkat-tinggi"
    );
    expect(slugify("Tata kelola & komunitas")).toBe("tata-kelola--komunitas");
    expect(slugify("RLS (ADR-0003)")).toBe("rls-adr-0003");
  });

  test("headingSlugs mengumpulkan semua level heading", () => {
    const md = "# Satu\n\n## Dua Tiga\n\n### Empat\n\nbukan heading";
    const slugs = headingSlugs(md);
    expect(slugs.has("satu")).toBe(true);
    expect(slugs.has("dua-tiga")).toBe(true);
    expect(slugs.has("empat")).toBe(true);
    expect(slugs.has("bukan-heading")).toBe(false);
  });

  test("heading dengan tanda baca ter-slug benar", () => {
    expect(headingSlugs("## Keamanan").has("keamanan")).toBe(true);
  });
});

describe("checkNaming", () => {
  test("mendeteksi pola rusak lowercase dan uppercase", () => {
    const md = "tabel `awcms-mini_tenants` dan env `AWCMS-Mini_NODE_ID`";
    const problems = checkNaming("f.md", lines(md));
    expect(problems).toHaveLength(1); // satu baris, satu temuan
    expect(problems[0]?.line).toBe(1);
  });

  test("tidak menandai penamaan benar", () => {
    const md =
      "`awcms_mini_tenants`, `AWCMS_MINI_NODE_ID`, skill `awcms-mini-release`";
    expect(checkNaming("f.md", lines(md))).toEqual([]);
  });

  test("nama skill/paket kebab-case (awcms-mini-...) tidak salah tangkap", () => {
    const md =
      "lihat `awcms-mini-new-migration` dan `docs/awcms-mini/README.md`";
    expect(checkNaming("f.md", lines(md))).toEqual([]);
  });

  test("melaporkan nomor baris yang tepat", () => {
    const md = "baris1\nbaris2 `awcms-mini_offices`\nbaris3";
    const problems = checkNaming("f.md", lines(md));
    expect(problems[0]?.line).toBe(2);
  });
});

describe("extractLinks", () => {
  test("mengekstrak target dan nomor baris", () => {
    const md = "teks [a](./x.md) lalu\n[b](../y.md#sec)";
    const links = extractLinks(md);
    expect(links.map((l) => l.target)).toEqual(["./x.md", "../y.md#sec"]);
    expect(links[0]?.line).toBe(1);
    expect(links[1]?.line).toBe(2);
  });

  test("membersihkan pembungkus sudut <...>", () => {
    const links = extractLinks("[x](<https://a.b/c d>)");
    expect(links[0]?.target).toBe("https://a.b/c d");
  });

  test("dokumen tanpa tautan menghasilkan array kosong", () => {
    expect(extractLinks("tanpa tautan sama sekali")).toEqual([]);
  });
});

describe("classifyLink", () => {
  test("klasifikasi tipe tautan", () => {
    expect(classifyLink("https://example.com")).toBe("external");
    expect(classifyLink("mailto:a@b.c")).toBe("external");
    expect(classifyLink("#bagian")).toBe("anchor");
    expect(classifyLink("./doc.md")).toBe("relative");
    expect(classifyLink("../adr/README.md#x")).toBe("relative");
    expect(classifyLink("")).toBe("empty");
  });
});

describe("splitTarget", () => {
  test("memisahkan path dan anchor", () => {
    expect(splitTarget("./a/b.md#bagian")).toEqual({
      path: "./a/b.md",
      hash: "bagian"
    });
    expect(splitTarget("./a/b.md")).toEqual({
      path: "./a/b.md",
      hash: undefined
    });
  });
});
