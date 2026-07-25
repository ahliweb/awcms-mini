import { describe, expect, test } from "bun:test";

import {
  EXCLUDE,
  dropExcludedIndexLines
} from "../../scripts/sync-agent-memory";

/**
 * `docs/awcms-mini/agent-memory.md` terbit ke repo PUBLIK. `EXCLUDE` menahan isi
 * memory yang sensitif, tapi `MEMORY.md` juga memuat hook satu baris per memory
 * yang MERANGKUM isinya — menerbitkan hook itu membocorkan hal yang sama yang
 * membuat memory-nya dikecualikan (mis. username admin sebuah server produksi).
 * Test ini mengunci pembuangan baris indeks tersebut.
 */
describe("dropExcludedIndexLines", () => {
  const excludedName = [...EXCLUDE.keys()][0]!;

  test("membuang baris indeks yang menunjuk memory ter-EXCLUDE", () => {
    const index = [
      "# Memory index",
      "",
      "## Kelompok",
      "",
      `- [Rahasia](${excludedName}) — ringkasan yang membocorkan isinya`,
      "- [Aman](aman.md) — hook tak sensitif",
      ""
    ].join("\n");

    const out = dropExcludedIndexLines(index);

    expect(out).not.toContain(excludedName);
    expect(out).toContain("aman.md");
    expect(out).toContain("## Kelompok");
  });

  test("membuang heading yang seluruh entrinya terbuang", () => {
    const index = [
      "# Memory index",
      "",
      "## Server produksi",
      "",
      `- [Rahasia](${excludedName}) — IP, akun admin, topologi`,
      "",
      "## Kelompok lain",
      "",
      "- [Aman](aman.md) — hook tak sensitif",
      ""
    ].join("\n");

    const out = dropExcludedIndexLines(index);

    expect(out).not.toContain("## Server produksi");
    expect(out).toContain("## Kelompok lain");
    expect(out).toContain("aman.md");
  });

  test("mempertahankan heading yang masih punya entri tersisa", () => {
    const index = [
      "## Campuran",
      "",
      `- [Rahasia](${excludedName}) — dibuang`,
      "- [Aman](aman.md) — dipertahankan",
      ""
    ].join("\n");

    const out = dropExcludedIndexLines(index);

    expect(out).toContain("## Campuran");
    expect(out).toContain("aman.md");
    expect(out).not.toContain(excludedName);
  });

  test("tidak menyentuh prosa yang menyebut nama file di tengah kalimat", () => {
    // Hanya BARIS INDEKS (list item bertaut) yang dibuang. `[[wikilink]]` dan
    // penyebutan dalam prosa sengaja dibiarkan menggantung — didokumentasikan
    // di bagian "Konsekuensi yang disengaja" dokumen hasil.
    const prose = `Lihat catatan di \`${excludedName}\` untuk detailnya.`;

    expect(dropExcludedIndexLines(prose)).toBe(prose);
  });

  test("indeks tanpa memory ter-EXCLUDE dibiarkan apa adanya", () => {
    const index = ["## Kelompok", "", "- [Aman](aman.md) — hook", ""].join(
      "\n"
    );

    expect(dropExcludedIndexLines(index)).toBe(index);
  });
});
