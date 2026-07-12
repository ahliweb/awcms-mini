/**
 * release-verify.ts — `bun run release:verify`.
 *
 * Issue #692 (epic #679, platform-hardening) acceptance criterion:
 * "Tagged release maps to source commit, version, checksums, SBOM, and
 * image digest." Before any of that (build/SBOM/sign/publish), this
 * script is the read-only gate `.github/workflows/release.yml` runs first
 * — the tag-triggered equivalent of `scripts/changeset-policy-check.ts`'s
 * PR-time gate. It never mutates anything (no `bun run changeset:version`,
 * no git operations) — it only confirms that whoever DID run
 * `bun run changeset:version` + tagged the result did so consistently:
 *
 *   1. The pushed tag (`vX.Y.Z`) matches `package.json`'s `version` field
 *      exactly — catches "tagged the wrong commit" / "forgot to bump"
 *      mistakes at the door, before any image is built off the mismatch.
 *   2. `CHANGELOG.md` has a `## [X.Y.Z]` section for that version — the
 *      release notes source (doc 09 §Versioning: "CHANGELOG.md mengikuti
 *      format Keep a Changelog; entri versi digenerate dari changeset").
 *   3. No pending changesets remain in `.changeset/` (besides its own
 *      `config.json`/`README.md`) — a leftover `.changeset/*.md` file at
 *      tag time means `changeset:version` was never run for it, so this
 *      release's CHANGELOG/version is incomplete relative to `main`.
 *
 * Mirrors the pure-function-plus-thin-CLI shape used throughout this repo
 * (`production-preflight.ts`'s `authorizeApply`, `changeset-policy-check.ts`'s
 * `evaluateChangesetPolicy`) so each check is independently unit-testable
 * without a real git checkout or filesystem.
 */

export type ReleaseVerifyProblem = {
  check: string;
  message: string;
};

/** Accepts "v1.2.3", "refs/tags/v1.2.3", or a bare "1.2.3". */
export function normalizeTagVersion(tagRef: string): string {
  const withoutRefsPrefix = tagRef.replace(/^refs\/tags\//, "");
  return withoutRefsPrefix.replace(/^v/, "");
}

export function checkVersionMatchesTag(
  packageVersion: string,
  tagRef: string
): ReleaseVerifyProblem | null {
  const tagVersion = normalizeTagVersion(tagRef);

  if (packageVersion !== tagVersion) {
    return {
      check: "version-matches-tag",
      message:
        `Tag "${tagRef}" (versi "${tagVersion}") tidak cocok dengan package.json ` +
        `"version": "${packageVersion}". Tag rilis harus persis menunjuk commit hasil ` +
        "bun run changeset:version untuk versi tersebut."
    };
  }

  return null;
}

export function checkChangelogHasVersionSection(
  changelogContent: string,
  version: string
): ReleaseVerifyProblem | null {
  // Plain per-line string comparison instead of building a RegExp from
  // `version` (CodeQL high-severity findings on PR #715, both now moot):
  // `version` traces back to a git tag name / CLI arg, and the previous
  // `.replace(/\./g, "\\.")` only escaped literal dots — every other regex
  // metacharacter (`(`, `[`, `*`, `+`, `|`, `^`, `$`, `\`) survived
  // unescaped (regex injection), and the escaping itself was unsound for
  // input containing a literal backslash (incomplete string escaping).
  const expectedHeading = `## [${version}]`;
  const hasSection = changelogContent
    .split("\n")
    .some(
      (line) =>
        line === expectedHeading || line.startsWith(`${expectedHeading} `)
    );

  if (!hasSection) {
    return {
      check: "changelog-has-version-section",
      message:
        `CHANGELOG.md tidak memiliki seksi "## [${version}]". Jalankan bun run ` +
        "changeset:version sebelum membuat tag rilis, lalu commit hasilnya."
    };
  }

  return null;
}

/**
 * `changesetFileNames` = basenames present under `.changeset/` (e.g. from
 * `readdir`), excluding nothing — the two permanent non-changeset files
 * (`config.json`, `README.md`) are filtered out here, not by the caller.
 */
export function checkNoPendingChangesets(
  changesetFileNames: string[]
): ReleaseVerifyProblem | null {
  const pending = changesetFileNames.filter(
    (name) => name.endsWith(".md") && name !== "README.md"
  );

  if (pending.length > 0) {
    return {
      check: "no-pending-changesets",
      message:
        `${pending.length} changeset belum dikonsumsi tersisa di .changeset/ ` +
        `(${pending.join(", ")}). Jalankan bun run changeset:version sebelum tagging ` +
        "rilis — tag ini tidak merepresentasikan seluruh perubahan yang sudah di-changeset."
    };
  }

  return null;
}

export function runReleaseVerify(input: {
  packageVersion: string;
  tagRef: string;
  changelogContent: string;
  changesetFileNames: string[];
}): ReleaseVerifyProblem[] {
  const version = normalizeTagVersion(input.tagRef);

  return [
    checkVersionMatchesTag(input.packageVersion, input.tagRef),
    checkChangelogHasVersionSection(input.changelogContent, version),
    checkNoPendingChangesets(input.changesetFileNames)
  ].filter((problem): problem is ReleaseVerifyProblem => problem !== null);
}

if (import.meta.main) {
  const tagRef = process.env.RELEASE_TAG_REF ?? process.argv[2];

  if (!tagRef) {
    console.error(
      "release:verify GAGAL — perlu tag rilis: set RELEASE_TAG_REF atau berikan sebagai argumen (mis. v0.24.0)."
    );
    process.exitCode = 1;
  } else {
    const [packageJsonText, changelogContent] = await Promise.all([
      Bun.file("package.json").text(),
      Bun.file("CHANGELOG.md").text()
    ]);
    const packageVersion = JSON.parse(packageJsonText).version as string;

    const fs = await import("node:fs/promises");
    const changesetFileNames = await fs.readdir(".changeset");

    const problems = runReleaseVerify({
      packageVersion,
      tagRef,
      changelogContent,
      changesetFileNames
    });

    if (problems.length > 0) {
      console.error(
        `release:verify GAGAL — ${problems.length} masalah ditemukan:`
      );
      for (const problem of problems) {
        console.error(`  [${problem.check}] ${problem.message}`);
      }
      process.exitCode = 1;
    } else {
      console.log(
        `release:verify OK — tag "${tagRef}" konsisten dengan package.json, CHANGELOG.md, dan tidak ada changeset tersisa.`
      );
    }
  }
}
