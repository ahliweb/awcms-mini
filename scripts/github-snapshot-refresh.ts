/**
 * github-snapshot-refresh.ts — `bun run github:snapshot:refresh`.
 *
 * Issue #464. Regenerates the deterministic parts of the GitHub snapshot
 * docs at `docs/awcms-mini/github/` from live repository state, so a
 * maintainer doesn't have to hand-run and hand-count a dozen `gh` queries
 * before every release/audit (the exact manual process Issue #461's
 * refresh required — this exists so the next one is one command).
 *
 * Auth: shells out to `gh` for every API call. This script never reads,
 * holds, or logs a token itself — `gh auth login` (already required for
 * this whole repo's workflow, see AGENTS.md) manages credentials in its
 * own keychain/config. There is no `GITHUB_TOKEN` variable anywhere in
 * this file to accidentally print or write to a snapshot file.
 *
 * Scope — what this script safely regenerates vs. what stays hand-written:
 *  - Metadata tables (snapshot timestamp, issue/label/milestone counts,
 *    latest CodeQL run, security alert counts) are narrow, single-purpose
 *    tables with no prose mixed in — safe to fully compute and substitute
 *    row-by-row via `updateTableRow`. Rows with a hand-maintained
 *    parenthetical breakdown (e.g. "98 (25 doc 06 + 73 peninggalan)") only
 *    have their *leading number* replaced — the annotation is a one-time
 *    historical classification, not something re-derivable from a generic
 *    heuristic, so it's preserved via `updateLeadingNumber`.
 *  - The two *growing* issue-list tables (open issues; post-doc06 closed
 *    issues) are fully regenerated between explicit
 *    `<!-- github-snapshot:NAME:start/end -->` markers — safe because nothing
 *    else lives inside those markers.
 *  - Everything else (the original 38-issue doc06 table, every narrative
 *    "### ... completed" section, labels-milestones.md's detailed
 *    label/milestone tables) is intentionally NOT touched: it requires
 *    human judgment (why something closed, what shipped) that isn't
 *    reconstructable from the API alone. Re-running this script is safe
 *    to do repeatedly; it will never silently discard that prose.
 *
 * Usage:
 *   bun run github:snapshot:refresh [owner/repo]
 * (defaults to ahliweb/awcms-mini if omitted)
 *
 * Rate limits: each run makes ~10 `gh` calls (issue list x2, label list,
 * milestones, 3x alert types, 1x workflow run lookup) — nowhere near
 * GitHub's REST rate limit for an authenticated user. Run manually before
 * a release/audit, not on a CI schedule (this reaches out to the live
 * GitHub API, which doc 20's "Batasan" section keeps out of CI on purpose).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DOCS_DIR = path.resolve(
  import.meta.dirname,
  "..",
  "docs/awcms-mini/github"
);

type Issue = {
  number: number;
  title: string;
  milestone: { title: string } | null;
};

type Milestone = { number: number; title: string; state: string };

type CodeScanningAlert = {
  number: number;
  state: string;
  rule: { id: string };
  fixed_at: string | null;
};

type WorkflowRun = {
  conclusion: string | null;
  headSha: string;
  createdAt: string;
  status: string;
};

/** Runs `gh` and returns stdout. Never logs args that could contain a token — this script never passes one. */
function gh(args: string[]): string {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  });
}

function ghJson<T>(args: string[]): T {
  return JSON.parse(gh(args)) as T;
}

/** Best-effort variant for endpoints that may 403/404 depending on token scope (e.g. secret scanning). */
function ghJsonOrNull<T>(args: string[]): T | null {
  try {
    return ghJson<T>(args);
  } catch {
    return null;
  }
}

async function fetchLiveState(repo: string) {
  const openIssues = ghJson<Issue[]>([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--limit",
    "500",
    "--json",
    "number,title,milestone"
  ]);
  const closedIssues = ghJson<Issue[]>([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "closed",
    "--limit",
    "500",
    "--json",
    "number,title,milestone"
  ]);
  const labelCount = ghJson<{ name: string }[]>([
    "label",
    "list",
    "--repo",
    repo,
    "--limit",
    "500",
    "--json",
    "name"
  ]).length;
  const milestones = ghJson<Milestone[]>([
    "api",
    `repos/${repo}/milestones?state=all&per_page=100`
  ]);
  const openAlerts =
    ghJsonOrNull<CodeScanningAlert[]>([
      "api",
      `repos/${repo}/code-scanning/alerts?state=open`
    ]) ?? [];
  const fixedAlerts =
    ghJsonOrNull<CodeScanningAlert[]>([
      "api",
      `repos/${repo}/code-scanning/alerts?state=fixed`
    ]) ?? [];
  const dependabotOpen =
    ghJsonOrNull<unknown[]>([
      "api",
      `repos/${repo}/dependabot/alerts?state=open`,
      "--paginate"
    ])?.length ?? null;
  const dependabotAll =
    ghJsonOrNull<unknown[]>([
      "api",
      `repos/${repo}/dependabot/alerts`,
      "--paginate"
    ])?.length ?? null;
  const secretScanningAll =
    ghJsonOrNull<unknown[]>([
      "api",
      `repos/${repo}/secret-scanning/alerts`,
      "--paginate"
    ])?.length ?? null;
  const latestCodeQlRun = ghJsonOrNull<WorkflowRun[]>([
    "run",
    "list",
    "--repo",
    repo,
    "--branch",
    "main",
    "--workflow",
    "codeql.yml",
    "--limit",
    "1",
    "--json",
    "conclusion,headSha,createdAt,status"
  ])?.[0];

  return {
    openIssues,
    closedIssues,
    labelCount,
    milestones,
    openAlerts,
    fixedAlerts,
    dependabotOpen,
    dependabotAll,
    secretScanningAll,
    latestCodeQlRun
  };
}

/** Replaces the value cell of a `| Label | value |` markdown table row. Throws if the row isn't found — a missing row means the file's shape changed and this script needs a human to look, not a silent no-op. */
function updateTableRow(
  content: string,
  rowLabel: string,
  newValue: string
): string {
  const escaped = rowLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(\\|\\s*${escaped}\\s*\\|)([^|\\n]*)(\\|)`, "u");
  if (!pattern.test(content)) {
    throw new Error(`Baris tabel "${rowLabel}" tidak ditemukan.`);
  }
  return content.replace(pattern, (_m, left, _old, right) => {
    return `${left} ${newValue} ${right}`;
  });
}

/** Replaces only the leading integer of a cell, preserving any trailing "(...)" annotation — e.g. "98 (25 doc 06 + 73 peninggalan)" keeps its parenthetical when the leading count changes. */
function updateLeadingNumber(
  content: string,
  rowLabel: string,
  newNumber: number
): string {
  const escaped = rowLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(\\|\\s*${escaped}\\s*\\|\\s*)\\d+`, "u");
  if (!pattern.test(content)) {
    throw new Error(
      `Baris tabel "${rowLabel}" (leading number) tidak ditemukan.`
    );
  }
  return content.replace(pattern, (_m, left) => `${left}${newNumber}`);
}

/** Replaces the last cell of a row identified by its first cell (e.g. "| OPEN | ... | 5 |" -> replace "5"). For simple tables where each row's first column is a unique key but the label isn't a clean single-column match like `updateTableRow` expects. */
function updateLastCellByFirstCell(
  content: string,
  firstCellValue: string,
  newLastCellValue: string
): string {
  const escaped = firstCellValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(\\|\\s*${escaped}\\s*\\|[^\\n]*\\|)([^|\\n]*)(\\|)`,
    "u"
  );
  if (!pattern.test(content)) {
    throw new Error(
      `Baris tabel dengan kolom pertama "${firstCellValue}" tidak ditemukan.`
    );
  }
  return content.replace(
    pattern,
    (_m, left, _old, right) => `${left} ${newLastCellValue} ${right}`
  );
}

/** Replaces everything between a named marker pair. Throws if markers are missing/malformed — this script never silently regenerates a whole file. */
function replaceBetweenMarkers(
  content: string,
  markerName: string,
  replacement: string
): string {
  const start = `<!-- github-snapshot:${markerName}:start -->`;
  const end = `<!-- github-snapshot:${markerName}:end -->`;
  const startIdx = content.indexOf(start);
  const endIdx = content.indexOf(end);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`Marker "${markerName}" tidak ditemukan atau rusak.`);
  }
  const before = content.slice(0, startIdx + start.length);
  const after = content.slice(endIdx);
  return `${before}\n\n${replacement}\n\n${after}`;
}

// `repo` comes from the same `owner/repo` argument fetchLiveState() was
// called with — keeps generated issue links pointing at the repo actually
// being processed instead of hardcoding this repo, so this script stays a
// valid pattern to copy into a derived repo (e.g. AWPOS) unchanged.
function issueTableRow(
  issue: Issue,
  repo: string,
  milestoneFallback = "-"
): string {
  const url = `https://github.com/${repo}/issues/${issue.number}`;
  const milestone = issue.milestone?.title ?? milestoneFallback;
  return `| [#${issue.number}](${url}) | ${issue.title} | ${milestone} |`;
}

async function main() {
  const repo = process.argv[2] ?? "ahliweb/awcms-mini";
  const snapshotAt = new Date().toISOString();

  console.log(`Mengambil state live dari ${repo}...`);
  const state = await fetchLiveState(repo);

  const totalIssues = state.openIssues.length + state.closedIssues.length;
  const milestoneCount = state.milestones.length;

  console.log(
    `Issue: ${totalIssues} total (${state.openIssues.length} open, ${state.closedIssues.length} closed)`
  );
  console.log(`Label: ${state.labelCount}`);
  console.log(`Milestone: ${milestoneCount}`);

  // README.md — metadata table + file-index table only.
  {
    const file = path.join(DOCS_DIR, "README.md");
    let content = readFileSync(file, "utf8");
    content = updateTableRow(content, "Snapshot", snapshotAt);
    content = updateTableRow(content, "Total issue", String(totalIssues));
    content = updateTableRow(
      content,
      "Open issue",
      String(state.openIssues.length)
    );
    content = updateTableRow(
      content,
      "Closed issue",
      String(state.closedIssues.length)
    );
    content = updateLeadingNumber(content, "Labels", state.labelCount);
    content = updateLeadingNumber(content, "Milestones", milestoneCount);
    content = updateLastCellByFirstCell(
      content,
      "OPEN",
      String(state.openIssues.length)
    );
    content = updateLastCellByFirstCell(
      content,
      "CLOSED",
      String(state.closedIssues.length)
    );
    content = updateLastCellByFirstCell(
      content,
      "LABEL/MILESTONE",
      `${state.labelCount} labels, ${milestoneCount} milestones`
    );
    writeFileSync(file, content);
    console.log(
      `Diperbarui: ${path.relative(process.cwd(), file)} (metadata + tabel file-index saja)`
    );
  }

  // issues-open-001.md — metadata + full issue-list marker block.
  {
    const file = path.join(DOCS_DIR, "issues-open-001.md");
    let content = readFileSync(file, "utf8");
    content = updateTableRow(content, "Snapshot", snapshotAt);
    content = updateTableRow(
      content,
      "Issue dalam file",
      String(state.openIssues.length)
    );
    const sorted = [...state.openIssues].sort((a, b) => a.number - b.number);
    const range =
      sorted.length > 0
        ? `#${sorted[0]!.number}-#${sorted.at(-1)!.number}`
        : "-";
    content = updateTableRow(content, "Range", range);
    const table =
      sorted.length > 0
        ? [
            "|                                                        # | Judul | Milestone (saat dibuat) |",
            "| -------------------------------------------------------: | ----- | ----------------------- |",
            ...sorted.map((issue) => issueTableRow(issue, repo))
          ].join("\n")
        : "**Tidak ada issue open.**";
    content = replaceBetweenMarkers(content, "open-issues", table);
    writeFileSync(file, content);
    console.log(`Diperbarui: ${path.relative(process.cwd(), file)}`);
  }

  // issues-closed-001.md — metadata + post-doc06 marker block (>= #433, i.e.
  // everything after the original 38-issue doc06 backlog closed on 2026-07-05).
  {
    const file = path.join(DOCS_DIR, "issues-closed-001.md");
    let content = readFileSync(file, "utf8");
    content = updateTableRow(content, "Snapshot", snapshotAt);
    content = updateTableRow(
      content,
      "Issue dalam file",
      String(state.closedIssues.length)
    );
    const postDoc06 = state.closedIssues
      .filter((issue) => issue.number >= 433)
      .sort((a, b) => a.number - b.number);
    const table = [
      "|                                                        # | Judul | Milestone (saat dibuat) |",
      "| -------------------------------------------------------: | ----- | ----------------------- |",
      ...postDoc06.map((issue) => issueTableRow(issue, repo))
    ].join("\n");
    content = replaceBetweenMarkers(content, "closed-issues-post-doc06", table);
    writeFileSync(file, content);
    console.log(`Diperbarui: ${path.relative(process.cwd(), file)}`);
  }

  // labels-milestones.md — metadata counts only; the detailed doc06-vs-
  // peninggalan tables stay hand-maintained (see module doc comment).
  {
    const file = path.join(DOCS_DIR, "labels-milestones.md");
    let content = readFileSync(file, "utf8");
    content = updateTableRow(content, "Snapshot", snapshotAt);
    content = updateLeadingNumber(content, "Total labels", state.labelCount);
    content = updateLeadingNumber(content, "Total milestones", milestoneCount);
    writeFileSync(file, content);
    console.log(
      `Diperbarui: ${path.relative(process.cwd(), file)} (metadata saja — tabel label/milestone detail tetap manual)`
    );
  }

  // security.md — live-state row + alert-count table.
  {
    const file = path.join(DOCS_DIR, "security.md");
    let content = readFileSync(file, "utf8");
    content = content.replace(/^Snapshot: .*$/m, `Snapshot: ${snapshotAt}`);
    if (state.latestCodeQlRun?.status === "completed") {
      const shortSha = state.latestCodeQlRun.headSha.slice(0, 7);
      const status =
        state.latestCodeQlRun.conclusion === "success" ? "Success" : "Failure";
      content = updateTableRow(
        content,
        "Latest CodeQL run",
        `${status} pada \`main\` commit \`${shortSha}\` (${state.latestCodeQlRun.createdAt})`
      );
    } else if (state.latestCodeQlRun) {
      // Run hasn't finished yet (queued/in_progress) — `conclusion` would be
      // null/empty here, which would otherwise be misread as "Failure". Leave
      // the row as whatever it currently says rather than guess.
      console.log(
        "Latest CodeQL run belum selesai (status bukan 'completed') — baris 'Latest CodeQL run' TIDAK diperbarui, tinjau ulang nanti."
      );
    }
    if (state.dependabotOpen !== null && state.dependabotAll !== null) {
      content = content.replace(
        /(\|\s*Dependabot\s*\|)\s*\d+\s*(\|)\s*\d+\s*(\|)/u,
        `$1 ${state.dependabotOpen} $2 ${state.dependabotAll} $3`
      );
    }
    if (state.secretScanningAll !== null) {
      content = content.replace(
        /(\|\s*Secret scanning\s*\|)\s*\d+\s*(\|)\s*\d+\s*(\|)/u,
        `$1 0 $2 ${state.secretScanningAll} $3`
      );
    }
    const fixedNote =
      state.fixedAlerts.length > 0
        ? `Semua alert yang terambil dari API berstatus \`fixed\` (${[
            ...state.fixedAlerts
          ]
            .sort((a, b) => a.number - b.number)
            .map(
              (a) =>
                `#${a.number} \`${a.rule.id}\`${
                  a.fixed_at ? ` fixed ${a.fixed_at}` : ""
                }`
            )
            .join("; ")}).`
        : "Tidak ada alert saat setup.";
    content = content.replace(
      /(\|\s*Code scanning\s*\|)\s*\d+\s*(\|)\s*\d+\s*(\|)[^|\n]*(\|)/u,
      `$1 ${state.openAlerts.length} $2 ${state.fixedAlerts.length} $3 ${fixedNote} $4`
    );
    writeFileSync(file, content);
    console.log(`Diperbarui: ${path.relative(process.cwd(), file)}`);
  }

  console.log(
    "\nSelesai. Jalankan `bun run format` lalu `bun run check:docs` untuk memformat ulang tabel dan memvalidasi tautan."
  );
  console.log(
    "Narasi hand-written (README.md bagian ### ..., labels-milestones.md tabel detail) TIDAK disentuh — tinjau manual bila ada issue/label/milestone baru yang butuh konteks."
  );
}

await main();
