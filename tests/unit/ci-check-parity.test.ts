/**
 * Gate paritas `bun run check` ⊆ `.github/workflows/ci.yml` — Issue #823 (epic #818).
 *
 * `ci.yml` mencerminkan langkah-langkah `check` **secara manual**. Cermin itu sudah
 * melenceng **empat kali** (#685, #740, #745/#746, #750, lalu #823 menemukan lima
 * langkah lagi yang tak pernah dipasang: `api:docs:check`, `repo:inventory:check`,
 * `i18n:pot:check`, `config:docs:check`, `logging:lint:check`). Tiap kali polanya
 * sama: langkah baru ditambahkan ke `check`, lolos lokal, dan CI diam-diam
 * menjalankan subset — regresi bisa merge hijau.
 *
 * Komentar peringatan di `ci.yml` tidak menghentikannya empat kali. Test inilah
 * gate-nya: menambah langkah ke `check` tanpa memasangnya di `ci.yml` = merah.
 *
 * Arah pemeriksaan sengaja satu arah (`check` ⊆ `ci.yml`): `ci.yml` boleh
 * menjalankan lebih banyak (mis. `db:migrate`, performance suite, DR drill) —
 * yang dilarang adalah `check` punya langkah yang CI lewatkan.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

const ROOT = resolve(import.meta.dir, "../..");

/**
 * Langkah `check` yang sengaja TIDAK dicari sebagai `bun run <x>` literal di
 * ci.yml karena CI menjalankannya lewat bentuk lain — bukan pengecualian dari
 * cakupan, hanya dari pencocokan string.
 */
const RUN_DIFFERENTLY = new Map<string, string>([
  // ci.yml memanggil `bun test` langsung (setelah `db:migrate`), bukan `bun run test`.
  ["test", "bun test"],
  // ci.yml build lewat job/langkah terpisah dengan env berbeda.
  ["build", "bun run build"]
]);

function packageScripts(): Record<string, string> {
  const pkg = JSON.parse(
    readFileSync(resolve(ROOT, "package.json"), "utf8")
  ) as {
    scripts: Record<string, string>;
  };
  return pkg.scripts;
}

/** Ekstrak nama script dari komposit `check` (`bun run a && bun run b && ...`). */
function checkSteps(): string[] {
  const composite = packageScripts().check;
  if (!composite) {
    throw new Error(
      "package.json tidak punya script `check` — gate paritas ini tidak bermakna tanpanya."
    );
  }
  return [...composite.matchAll(/bun run ([a-z0-9:_-]+)/g)].map((m) => m[1]!);
}

type WorkflowStep = { run?: unknown };
type WorkflowJob = { steps?: WorkflowStep[] };
type Workflow = { jobs?: Record<string, WorkflowJob> };

/**
 * ONLY the `run:` command bodies, never the raw file text.
 *
 * The first version of this gate scanned the whole file, so a mere mention of
 * `bun test` — in a comment, a step `name:`, or this file's own warning prose —
 * satisfied the check even with the real `run:` step deleted. The gate would
 * have stayed green in exactly the drift scenario it exists to catch, which is
 * the same "gate is green over a real defect" failure the gate was written to
 * end. Parsing the YAML and looking only at executable commands is the whole
 * point. (Review finding, PR #839.)
 */
function ciRunCommands(): string {
  const workflow = parse(
    readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8")
  ) as Workflow;

  const jobs = Object.values(workflow.jobs ?? {});
  if (jobs.length === 0) {
    throw new Error(
      ".github/workflows/ci.yml tidak punya job apa pun setelah diurai — gate paritas ini tidak bermakna tanpanya."
    );
  }

  const commands = jobs
    .flatMap((job) => job.steps ?? [])
    .map((step) => step.run)
    .filter((run): run is string => typeof run === "string");

  if (commands.length === 0) {
    throw new Error(
      ".github/workflows/ci.yml tidak punya satu pun langkah `run:` setelah diurai — parser di test ini kemungkinan sudah tidak cocok dengan bentuk workflow-nya."
    );
  }

  return commands.join("\n");
}

describe("paritas `bun run check` vs .github/workflows/ci.yml (Issue #823)", () => {
  test("`check` komposit dapat diurai dan tidak kosong", () => {
    const steps = checkSteps();
    expect(steps.length).toBeGreaterThan(10);
    expect(steps).toContain("lint");
    expect(steps).toContain("typecheck");
  });

  test("setiap langkah `check` benar-benar ada sebagai script di package.json", () => {
    const scripts = packageScripts();
    const missing = checkSteps().filter((step) => !(step in scripts));
    expect(
      missing,
      `Langkah \`check\` menunjuk script yang tidak ada: ${missing.join(", ")}`
    ).toEqual([]);
  });

  test("setiap langkah `check` dijalankan juga oleh ci.yml", () => {
    const ci = ciRunCommands();
    const missing = checkSteps().filter((step) => {
      const alternate = RUN_DIFFERENTLY.get(step);
      if (alternate) return !ci.includes(alternate);
      return !new RegExp(
        `bun run ${step.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9:_-])`
      ).test(ci);
    });

    expect(
      missing,
      `ci.yml tidak menjalankan langkah \`check\` berikut: ${missing.join(", ")}.\n` +
        `Ini kelas bug yang sudah berulang 4x (#685/#740/#745/#746/#750/#823): sebuah langkah ` +
        `ditambahkan ke \`check\`, lolos lokal, lalu CI diam-diam menjalankan subset.\n` +
        `Tambahkan langkah itu ke .github/workflows/ci.yml — atau, bila CI memang ` +
        `menjalankannya dengan bentuk perintah lain, daftarkan di RUN_DIFFERENTLY pada test ini.`
    ).toEqual([]);
  });

  /**
   * Meta-test: memaku properti yang membuat gate ini nyata, bukan hiasan.
   * Versi pertamanya memindai seluruh teks file, jadi komentar yang menyebut
   * `bun test` sudah memuaskannya walau step `run:` aslinya dihapus — gate
   * hijau persis di skenario yang jadi alasan ia ada. Tanpa test ini, regresi
   * itu bisa kembali tanpa suara. (Temuan review, PR #839.)
   */
  test("sumber pemeriksaan HANYA `run:`, bukan komentar/nama langkah — gate ini tidak boleh bisa dibohongi prosa", () => {
    const raw = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");
    const runOnly = ciRunCommands();

    // ci.yml memang memuat komentar; kalau tidak, test ini tak membuktikan apa pun.
    expect(raw).toMatch(/^\s*#/m);
    expect(runOnly.length).toBeLessThan(raw.length);
    expect(runOnly).not.toMatch(/^\s*#/m);

    // Bukti langsung: sebuah token yang HANYA muncul di komentar tidak boleh
    // terbaca oleh sumber pemeriksaan.
    const commentOnlyToken = "bun run this-step-exists-only-in-a-comment";
    const spoofed = raw.replace(/^(#.*)$/m, `$1\n# ${commentOnlyToken}`);
    expect(spoofed).toContain(commentOnlyToken);

    const spoofedRunOnly = (() => {
      const workflow = parse(spoofed) as Workflow;
      return Object.values(workflow.jobs ?? {})
        .flatMap((job) => job.steps ?? [])
        .map((step) => step.run)
        .filter((run): run is string => typeof run === "string")
        .join("\n");
    })();

    expect(spoofedRunOnly).not.toContain(commentOnlyToken);
  });

  test("RUN_DIFFERENTLY tidak menyimpan entri usang", () => {
    const steps = new Set(checkSteps());
    const stale = [...RUN_DIFFERENTLY.keys()].filter(
      (step) => !steps.has(step)
    );
    expect(
      stale,
      `RUN_DIFFERENTLY memuat langkah yang bukan lagi bagian \`check\`: ${stale.join(", ")}. ` +
        `Entri usang membuat pengecualian bertahan diam-diam setelah alasannya hilang.`
    ).toEqual([]);
  });
});
