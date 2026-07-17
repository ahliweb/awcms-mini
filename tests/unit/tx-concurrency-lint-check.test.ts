/**
 * Gate: tidak ada `Promise.all` di atas transaction handle — Issue #842 (epic #818).
 *
 * Satu koneksi Postgres melayani SATU query pada satu waktu, jadi
 * `Promise.all([q1(tx), q2(tx)])` bukan sekadar kehilangan paralelisme — ia
 * MENGHANG sungguhan, dan koneksi yang tersangkut lalu merusak
 * `resetDatabase()` setiap test sesudahnya (gejala muncul jauh dari
 * penyebabnya). Tulisan kanoniknya:
 * `src/modules/reporting/application/projection-reconciliation.ts:89-94`.
 *
 * Kelas ini sudah kambuh EMPAT kali dan **test suite lolos setiap kali** —
 * sifatnya load-dependent, jadi test fungsional bukan gate untuk kelas ini.
 * Itulah alasan gate statis ini ada.
 *
 * Test ini menguji DUA hal, dan sengaja mengassert KEDUA sisi tiap properti:
 *   1. Scanner-nya benar-benar bisa MERAH (fixture adversarial), dan hijau
 *      pada bentuk yang memang aman (pool `sql`, map murni).
 *   2. Pohon `src/`+`scripts/` yang sebenarnya bersih.
 */
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  blankCommentsAndStrings,
  discoverHandleNames,
  findPromiseAllSpans,
  runTxConcurrencyLintCheck,
  scanSourceForTxConcurrency
} from "../../scripts/tx-concurrency-lint-check";

const ROOT = resolve(import.meta.dir, "../..");

const scan = (source: string) =>
  scanSourceForTxConcurrency("fixture.ts", source);

describe("scanner menandai pola berbahaya (sisi MERAH)", () => {
  test("dua query di atas satu `tx` — bentuk persis Issue #842", () => {
    const problems = scan(`
      export async function load(tx: Bun.SQL, tenantId: string) {
        const [a, b] = await Promise.all([
          fetchOne(tx, tenantId),
          fetchTwo(tx, tenantId)
        ]);
        return { a, b };
      }
    `);

    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain("transaction handle");
    expect(problems[0]!.line).toBe(3);
  });

  test("tagged template `tx`...`` langsung di dalam Promise.all", () => {
    // Isi template DI-BLANK oleh tokenizer; yang terdeteksi adalah identifier
    // `tx` sebelum backtick — jadi bentuk ini tidak boleh lolos.
    const problems = scan(
      "const [r] = await Promise.all([tx`SELECT 1`, tx`SELECT 2`]);"
    );
    expect(problems).toHaveLength(1);
  });

  test("fan-out `Promise.all(items.map(async …))` di atas `tx`", () => {
    const problems = scan(`
      const withItems = await Promise.all(
        menus.map(async (menu) => ({
          ...menu,
          items: await fetchMenuItems(tx, tenantId, menu.id)
        }))
      );
    `);
    expect(problems).toHaveLength(1);
  });

  test("`Promise.allSettled` juga dijaga, bukan hanya `Promise.all`", () => {
    expect(scan("await Promise.allSettled([q1(tx), q2(tx)]);")).toHaveLength(1);
  });

  test("handle yang dinamai selain `tx` tetap tertangkap bila di-bind callback", () => {
    const problems = scan(`
      await withTenant(sql, tenantId, async (trx) => {
        return Promise.all([fetchOne(trx), fetchTwo(trx)]);
      });
    `);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain("trx");
  });
});

describe("scanner TIDAK menandai bentuk yang aman (sisi HIJAU)", () => {
  test("konkurensi di atas POOL (`sql`) legal — koneksi terpisah per query", () => {
    expect(
      scan(`
        const [rows, locks] = await Promise.all([
          sql\`SELECT 1\`,
          sql\`SELECT 2\`
        ]);
      `)
    ).toEqual([]);
  });

  test("`Promise.all` di atas map murni tanpa query", () => {
    expect(
      scan(
        "const rows = await Promise.all(items.map(async (i) => transform(i)));"
      )
    ).toEqual([]);
  });

  test("await berurutan di atas `tx` — bentuk yang BENAR", () => {
    expect(
      scan(`
        const a = await fetchOne(tx, tenantId);
        const b = await fetchTwo(tx, tenantId);
      `)
    ).toEqual([]);
  });
});

/**
 * Properti yang membuat gate ini nyata, bukan hiasan.
 *
 * Gate berbasis substring bisa dipuaskan PROSA — dan itu bukan hipotesis di
 * repo ini: `tests/unit/ci-check-parity.test.ts` shipped dengan cacat persis
 * ini dan harus diperbaiki di PR #839. Bahaya khususnya di sini: setiap
 * perbaikan Issue #842 menaruh komentar berbunyi "Sequential, NOT `Promise.all`
 * … over the same `tx`" TEPAT di atas kode yang diperbaiki. Scanner naif akan
 * melihat `Promise.all` + `tx` di komentar itu dan menandai kode yang justru
 * sudah benar (false positive), sementara sebaliknya sebuah string yang memuat
 * pola berbahaya akan ditandai padahal ia cuma data.
 */
describe("gate tidak bisa dibohongi/dipicu oleh prosa (bukan substring)", () => {
  test("komentar perbaikan Issue #842 yang menyebut Promise.all + tx TIDAK memicu temuan", () => {
    const problems = scan(`
      // Sequential, NOT \`Promise.all\` — both calls issue queries on the SAME
      // transaction/connection (\`tx\`), and one Postgres connection serves one
      // query at a time; running them concurrently produced a real hang.
      const catalog = await fetchModuleCatalog(tx);
      const entries = await fetchTenantModuleEntries(tx, tenantId);
    `);
    expect(problems).toEqual([]);
  });

  test("blok komentar /** */ yang menyebut pola juga tidak memicu", () => {
    expect(
      scan(`
        /**
         * Jangan pernah \`Promise.all([q(tx), q2(tx)])\` di sini.
         */
        const a = await q(tx);
      `)
    ).toEqual([]);
  });

  test("pola berbahaya di dalam STRING adalah data, bukan kode", () => {
    expect(
      scan('const doc = "await Promise.all([fetchOne(tx), fetchTwo(tx)])";')
    ).toEqual([]);
  });

  test("tokenizer membutakan komentar/string TAPI tetap melihat kode nyata di file yang sama", () => {
    // Kedua sisi dalam satu fixture: prosa diabaikan, kode di bawahnya ditandai.
    const problems = scan(`
      // Promise.all([a(tx), b(tx)]) — contoh yang dilarang, ini cuma komentar.
      const note = "Promise.all([a(tx), b(tx)])";
      const [x, y] = await Promise.all([realOne(tx), realTwo(tx)]);
    `);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.line).toBe(4);
  });
});

describe("tokenizer `blankCommentsAndStrings`", () => {
  test("mempertahankan panjang & nomor baris persis", () => {
    const source = 'const a = 1; // komentar\nconst b = "teks";\n';
    const blanked = blankCommentsAndStrings(source);
    expect(blanked.length).toBe(source.length);
    expect(blanked.split("\n").length).toBe(source.split("\n").length);
  });

  /**
   * Versi pertama test ini menaruh regex-nya di BARIS TERPISAH dari
   * `Promise.all`-nya — dan lolos bahkan ketika penanganan regex literal
   * dimatikan total (dibuktikan lewat mutation test). Sebabnya: pemindai
   * string berhenti di newline, jadi kutip yatim di dalam regex hanya
   * "menelan" sisa barisnya sendiri dan tak pernah menyentuh baris
   * berikutnya. Test itu vakum. Keduanya di bawah kini menaruh kode nyata
   * di baris/jangkauan yang BENAR-BENAR ditelan bila penanganan regex hilang.
   */
  test("kutip yatim di regex tidak menelan kode setelahnya pada baris yang sama", () => {
    const problems = scan(
      "if (/[\"']/.test(s)) { await Promise.all([one(tx), two(tx)]); }"
    );
    expect(problems).toHaveLength(1);
  });

  test("backtick di dalam regex tidak membuka template literal palsu", () => {
    // Ini kasus paling tajam: pemindai template TIDAK berhenti di newline,
    // jadi backtick yatim akan membutakan scanner sampai akhir file.
    const problems = scan(`
      const tick = /\`/;
      const [a, b] = await Promise.all([one(tx), two(tx)]);
    `);
    expect(problems).toHaveLength(1);
  });

  test("interpolasi \${} bersarang kembali ke mode kode", () => {
    const blanked = blankCommentsAndStrings("const q = `a${ b(`c${d}e`) }f`;");
    // Identifier di dalam interpolasi adalah kode nyata dan harus bertahan;
    // teks template biasa (a/c/e/f) harus terhapus.
    expect(blanked).toContain("b(");
    expect(blanked).toContain("d");
    expect(blanked).not.toContain("f`;");
  });

  test("string berisi tanda kutip ter-escape tidak memutus state lebih awal", () => {
    expect(scan('const s = "he said \\"Promise.all(tx)\\" once";')).toEqual([]);
  });
});

describe("helper", () => {
  test("discoverHandleNames selalu memuat konvensi `tx` dan menambah binding nyata", () => {
    expect([...discoverHandleNames("")]).toEqual(["tx"]);
    const names = discoverHandleNames(
      "await sql.begin(async (conn) => { return 1; });"
    );
    expect(names.has("tx")).toBe(true);
    expect(names.has("conn")).toBe(true);
  });

  test("findPromiseAllSpans menyeimbangkan kurung bersarang, bukan berhenti di `)` pertama", () => {
    const spans = findPromiseAllSpans(
      "await Promise.all([f(g(h(1))), i(2)]); after();"
    );
    expect(spans).toHaveLength(1);
    expect(spans[0]!.text).toContain("i(2)");
    expect(spans[0]!.text).not.toContain("after");
  });
});

describe("pohon nyata", () => {
  test("src/ dan scripts/ bersih dari Promise.all di atas transaction handle", async () => {
    const problems = await runTxConcurrencyLintCheck(ROOT);
    const rendered = problems.map((p) => `  ${p.file}:${p.line}`).join("\n");

    expect(
      problems,
      `Promise.all di atas transaction handle terdeteksi:\n${rendered}\n\n` +
        "Satu koneksi Postgres melayani satu query pada satu waktu — query konkuren di atas " +
        "SATU `tx` MENGHANG (lihat reporting/application/projection-reconciliation.ts:89-94). " +
        "Ubah jadi await berurutan; bila butuh konkurensi, pakai POOL (`sql`), bukan `tx`."
    ).toEqual([]);
  });
});
