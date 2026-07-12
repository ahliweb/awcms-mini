/**
 * changeset-policy-check.ts — `bun run changesets:policy:check`.
 *
 * Issue #692 (epic #679, platform-hardening) acceptance criterion: "Pull
 * requests verify required Changesets according to policy." Doc 09
 * §Versioning dengan Changesets already states the rule in prose ("Setiap
 * PR yang mengubah perilaku ... wajib menyertakan satu changeset ...
 * Perubahan docs-only/chore boleh tanpa changeset") — this script is the
 * first machine-enforced gate for that rule; before this issue nothing
 * checked it, and a behavior-changing PR could merge without a changeset.
 *
 * "Behavior-changing" here is decided empirically from this repo's own
 * merged-PR history (not guessed): PRs that touched ONLY `docs/**`,
 * `.claude/**` (agent/skill docs), or any `*.md` file merged WITHOUT a
 * changeset (e.g. PR #595, #585 — pure `docs/awcms-mini/github/**`
 * snapshot refreshes, one of which also touched a `.claude/skills/**`
 * file). Every PR that touched `.github/**` workflow files, `scripts/**`,
 * `src/**`, `sql/**`, `openapi/**`, `asyncapi/**`, `package.json`, or a
 * `Dockerfile*`/`docker-compose*.yml` alongside those DID carry a
 * changeset (e.g. PR #707, #701, #609). This gate mirrors that boundary:
 * EXEMPT_PATH_PATTERNS below is deliberately narrow (docs/agent-tooling
 * only) — everything else, including CI workflow and test-only changes,
 * requires a changeset. A false positive here costs one extra
 * `bun run changeset` invocation; a false negative silently reintroduces
 * the exact gap this issue closes, which is the worse failure mode.
 *
 * Escape hatch (mirrors `CONFIG_EXEMPTIONS`/`LOGGING_LINT_EXEMPTIONS`
 * elsewhere in this repo): `CHANGESET_POLICY_PATH_EXEMPTIONS` below, for a
 * genuine one-off exemption that doesn't fit the pattern list, with a
 * reason recorded at the call site.
 */

export type ChangesetPolicyResult = {
  requiresChangeset: boolean;
  changesetFilesAdded: string[];
  nonExemptFiles: string[];
  violation: string | null;
};

export type ChangesetFrontmatterResult = {
  ok: boolean;
  reason?: string;
};

/** Any path fully matching one of these is exempt from the changeset requirement. */
const EXEMPT_PATH_PATTERNS: RegExp[] = [
  /^docs\//,
  /^\.claude\//,
  /^\.changeset\//,
  /\.md$/
];

/**
 * One-off path exemptions (exact repo-relative path), each entry MUST be
 * accompanied by a comment recording why the pattern list above doesn't
 * already cover it. Empty as of this issue.
 */
export const CHANGESET_POLICY_PATH_EXEMPTIONS: string[] = [];

function isExempt(file: string): boolean {
  if (CHANGESET_POLICY_PATH_EXEMPTIONS.includes(file)) {
    return true;
  }
  return EXEMPT_PATH_PATTERNS.some((pattern) => pattern.test(file));
}

/**
 * Pure decision function — takes the PR's changed-file list (repo-relative
 * paths, as `git diff --name-only` reports them) and decides whether a new
 * changeset was required and, if so, whether one was actually added.
 */
export function evaluateChangesetPolicy(
  changedFiles: string[]
): ChangesetPolicyResult {
  const changesetFilesAdded = changedFiles.filter(
    (file) =>
      file.startsWith(".changeset/") &&
      file.endsWith(".md") &&
      file !== ".changeset/README.md"
  );

  const nonExemptFiles = changedFiles.filter((file) => !isExempt(file));
  const requiresChangeset = nonExemptFiles.length > 0;

  if (!requiresChangeset || changesetFilesAdded.length > 0) {
    return {
      requiresChangeset,
      changesetFilesAdded,
      nonExemptFiles,
      violation: null
    };
  }

  const sample = nonExemptFiles.slice(0, 5).join(", ");
  const more = nonExemptFiles.length > 5 ? ", ..." : "";

  return {
    requiresChangeset,
    changesetFilesAdded,
    nonExemptFiles,
    violation:
      `PR ini mengubah ${nonExemptFiles.length} file yang bukan docs/agent-tooling ` +
      `(mis. ${sample}${more}) tapi tidak menambah changeset baru. Tambahkan satu ` +
      `changeset (bun run changeset) yang menjelaskan tingkat bump SemVer + ringkasan ` +
      `perubahan — lihat docs/awcms-mini/09_roadmap_repository_commit.md §Versioning ` +
      "dengan Changesets, atau jika perubahan ini murni docs/chore, konfirmasi tidak " +
      "ada file lain yang keliru ikut ter-stage."
  };
}

const CHANGESET_PACKAGE_NAME = "awcms-mini";
const VALID_BUMPS = new Set(["major", "minor", "patch"]);

/**
 * Validates a single new changeset file's frontmatter — this is a
 * single-package repo (`.changeset/config.json` has empty `fixed`/`linked`),
 * so every changeset must bump exactly this one package by a valid SemVer
 * level. Deliberately does not re-implement full changeset frontmatter
 * parsing (that's `@changesets/cli`'s job at `changeset:version` time) —
 * this is a narrow "did the author fill this in correctly" sanity check.
 */
export function validateChangesetFrontmatter(
  content: string
): ChangesetFrontmatterResult {
  const match = content.match(/^---\n([\s\S]*?)\n---/);

  if (!match) {
    return {
      ok: false,
      reason:
        "Changeset tidak memiliki frontmatter YAML (--- ... ---) yang valid."
    };
  }

  const frontmatter = match[1]!;
  const lineMatch = frontmatter.match(
    /^["']?([\w.-]+)["']?\s*:\s*(major|minor|patch)\s*$/m
  );

  if (!lineMatch) {
    return {
      ok: false,
      reason: `Frontmatter changeset harus memuat baris "${CHANGESET_PACKAGE_NAME}": <major|minor|patch>.`
    };
  }

  const [, packageName, bump] = lineMatch;

  if (packageName !== CHANGESET_PACKAGE_NAME) {
    return {
      ok: false,
      reason: `Nama package di changeset ("${packageName}") harus "${CHANGESET_PACKAGE_NAME}" (repo single-package).`
    };
  }

  if (!VALID_BUMPS.has(bump!)) {
    return {
      ok: false,
      reason: `Tingkat bump "${bump}" tidak valid — harus salah satu dari: major, minor, patch.`
    };
  }

  return { ok: true };
}

async function getChangedFiles(baseRef: string): Promise<string[]> {
  const proc = Bun.spawn(["git", "diff", "--name-only", `${baseRef}...HEAD`], {
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `git diff --name-only ${baseRef}...HEAD gagal (exit ${exitCode}): ${stderr.trim()}`
    );
  }

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

if (import.meta.main) {
  const baseRef = process.env.CHANGESET_POLICY_BASE_REF ?? "origin/main";

  const changedFiles = await getChangedFiles(baseRef);
  const result = evaluateChangesetPolicy(changedFiles);

  const frontmatterProblems: string[] = [];
  for (const file of result.changesetFilesAdded) {
    const content = await Bun.file(file).text();
    const check = validateChangesetFrontmatter(content);
    if (!check.ok) {
      frontmatterProblems.push(`${file}: ${check.reason}`);
    }
  }

  if (result.violation) {
    console.error(result.violation);
  }

  if (frontmatterProblems.length > 0) {
    console.error(
      "\nchangesets:policy:check GAGAL — frontmatter changeset baru tidak valid:"
    );
    for (const problem of frontmatterProblems) {
      console.error(`  - ${problem}`);
    }
  }

  if (result.violation || frontmatterProblems.length > 0) {
    process.exitCode = 1;
  } else if (result.requiresChangeset) {
    console.log(
      `changesets:policy:check OK — ${result.changesetFilesAdded.length} changeset baru valid untuk ${result.nonExemptFiles.length} file non-docs/chore yang berubah.`
    );
  } else {
    console.log(
      "changesets:policy:check OK — PR ini hanya mengubah docs/agent-tooling, changeset tidak wajib."
    );
  }
}
