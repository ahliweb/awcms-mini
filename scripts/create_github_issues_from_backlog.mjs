import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repo = process.argv[2] || "ahliweb/awcms-mini";
const backlogPath = process.argv[3] || "awcms_mini_atomic_backlog.md";

const markdown = readFileSync(backlogPath, "utf8");

function runGh(args, options = {}) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed\n${result.stderr || result.stdout}`);
  }

  return result.stdout.trim();
}

function tryGh(args, options = {}) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  });

  return result;
}

function parseBacklog(md) {
  const lines = md.split(/\r?\n/);
  const issues = [];
  let currentEpic = null;
  let current = null;
  let currentField = null;

  const flush = () => {
    if (!current) return;
    issues.push(current);
    current = null;
    currentField = null;
  };

  for (const line of lines) {
    const epicMatch = line.match(/^##\s+(E\d+)\.\s+(.+)$/);
    if (epicMatch) {
      flush();
      currentEpic = { code: epicMatch[1], name: epicMatch[2] };
      continue;
    }

    const issueMatch = line.match(/^###\s+(AWM-\d+):\s+(.+)$/);
    if (issueMatch) {
      flush();
      current = {
        id: issueMatch[1],
        title: issueMatch[2],
        epic: currentEpic,
        goal: "",
        scope: "",
        deliverables: [],
        dependencies: [],
        acceptance: [],
        validation: [],
      };
      continue;
    }

    if (!current) continue;

    const goalMatch = line.match(/^- Goal:\s+(.+)$/);
    if (goalMatch) {
      current.goal = goalMatch[1];
      currentField = null;
      continue;
    }

    const scopeMatch = line.match(/^- Scope:\s+(.+)$/);
    if (scopeMatch) {
      current.scope = scopeMatch[1];
      currentField = null;
      continue;
    }

    const depsMatch = line.match(/^- Dependencies:\s+(.+)$/);
    if (depsMatch) {
      current.dependencies = depsMatch[1] === "none"
        ? []
        : depsMatch[1].split(",").map((part) => part.trim()).filter(Boolean);
      currentField = null;
      continue;
    }

    if (line === "- Deliverables:") {
      currentField = "deliverables";
      continue;
    }

    if (line === "- Acceptance Criteria:") {
      currentField = "acceptance";
      continue;
    }

    if (line === "- Suggested Validation:") {
      currentField = "validation";
      continue;
    }

    const listMatch = line.match(/^  - (.+)$/);
    if (listMatch && currentField) {
      current[currentField].push(listMatch[1]);
      continue;
    }
  }

  flush();
  return issues;
}

function renderBody(issue, numberById = new Map()) {
  const dependencyLines = issue.dependencies.length === 0
    ? ["- none"]
    : issue.dependencies.map((dep) => {
        const issueNumber = numberById.get(dep);
        return issueNumber ? `- ${dep} (#${issueNumber})` : `- ${dep}`;
      });

  return [
    `## Summary`,
    `${issue.goal}`,
    ``,
    `## Scope`,
    `${issue.scope}`,
    ``,
    `## Deliverables`,
    ...issue.deliverables.map((item) => `- ${item}`),
    ``,
    `## Dependencies`,
    ...dependencyLines,
    ``,
    `## Acceptance Criteria`,
    ...issue.acceptance.map((item) => `- [ ] ${item}`),
    ``,
    `## Validation`,
    ...issue.validation.map((item) => `- ${item}`),
    ``,
    `## Workflow`,
    `- Start implementation from this issue only after dependencies are complete.`,
    `- Keep the change atomic and aligned with \`awcms_mini_implementation_plan.md\`.`,
    `- Reference this issue in any pull request that implements the work.`,
    ``,
    `## Metadata`,
    `- Backlog ID: ${issue.id}`,
    `- Epic: ${issue.epic.code} - ${issue.epic.name}`,
    `- Source: \`awcms_mini_atomic_backlog.md\``,
  ].join("\n");
}

const labels = [
  ["type:task", "0e8a16", "Atomic implementation task"],
  ["workflow:issue-driven", "5319e7", "Work must be implemented through an issue-based flow"],
  ["source:backlog", "1d76db", "Created from the atomic backlog"],
  ["priority:high", "b60205", "High-priority planned work"],
  ["area:foundation", "c2e0c6", "Foundation and runtime work"],
  ["area:auth", "bfdadc", "Identity, auth, and sessions"],
  ["area:authorization", "f9d0c4", "RBAC and ABAC work"],
  ["area:governance", "d4c5f9", "Jobs and region governance work"],
  ["area:security", "fbca04", "Security and 2FA work"],
  ["area:audit", "7057ff", "Audit and observability work"],
  ["area:admin", "0e8a16", "Admin UI work"],
  ["area:plugins", "5319e7", "Plugin integration work"],
  ["area:docs", "006b75", "Documentation and workflow process work"],
];

const epicMilestones = [
  ["E0 Foundation Decisions", "Freeze architecture and repository conventions"],
  ["E1 Runtime and Database Bootstrap", "Stand up EmDash host integration with PostgreSQL and Kysely"],
  ["E2 Identity and Session Core", "Implement users, profiles, sessions, and auth event tracking"],
  ["E3 RBAC Core", "Implement roles, permissions, assignments, and matrix support"],
  ["E4 ABAC Core", "Add service-layer contextual authorization"],
  ["E5 Jobs Hierarchy", "Add organizational structure and reporting lines"],
  ["E6 Logical Regions", "Add 10-level operational region hierarchy"],
  ["E7 Administrative Regions", "Add Indonesian legal region hierarchy"],
  ["E8 Security Hardening", "Add TOTP, recovery, step-up, lockouts, and rate limits"],
  ["E9 Audit and Observability", "Add append-only audit and security event visibility"],
  ["E10 Admin Surfaces", "Deliver governance admin screens on EmDash admin"],
  ["E11 Plugin Governance Contract", "Extend governance into EmDash-compatible plugins"],
  ["E12 Rollout Safety and Docs", "Add flags, rollout controls, and operator docs"],
];

function areaLabelForEpic(code) {
  if (code === "E0" || code === "E1") return "area:foundation";
  if (code === "E2") return "area:auth";
  if (code === "E3" || code === "E4") return "area:authorization";
  if (code === "E5" || code === "E6" || code === "E7") return "area:governance";
  if (code === "E8") return "area:security";
  if (code === "E9") return "area:audit";
  if (code === "E10") return "area:admin";
  if (code === "E11") return "area:plugins";
  return "area:docs";
}

const issues = parseBacklog(markdown);

for (const [name, color, description] of labels) {
  runGh(["label", "create", name, "--repo", repo, "--color", color, "--description", description, "--force"]);
}

const existingMilestones = JSON.parse(runGh(["api", `repos/${repo}/milestones`, "--paginate"]));
const milestoneTitles = new Set(existingMilestones.map((item) => item.title));

for (const [title, description] of epicMilestones) {
  if (!milestoneTitles.has(title)) {
    runGh(["api", `repos/${repo}/milestones`, "-f", `title=${title}`, "-f", `description=${description}`]);
  }
}

const existingIssues = JSON.parse(runGh([
  "issue",
  "list",
  "--repo",
  repo,
  "--state",
  "all",
  "--limit",
  "200",
  "--json",
  "number,title,body",
]));

const existingByBacklogId = new Map();
for (const issue of existingIssues) {
  const match = issue.body?.match(/- Backlog ID: (AWM-\d+)/);
  if (match) existingByBacklogId.set(match[1], issue.number);
}

const tempDir = mkdtempSync(join(tmpdir(), "awcms-mini-issues-"));
const numberById = new Map(existingByBacklogId);

try {
  for (const issue of issues) {
    if (numberById.has(issue.id)) continue;

    const bodyPath = join(tempDir, `${issue.id}.md`);
    writeFileSync(bodyPath, renderBody(issue));

    const output = runGh([
      "issue",
      "create",
      "--repo",
      repo,
      "--title",
      `[${issue.id}] ${issue.title}`,
      "--body-file",
      bodyPath,
      "--label",
      "type:task",
      "--label",
      "workflow:issue-driven",
      "--label",
      "source:backlog",
      "--label",
      "priority:high",
      "--label",
      areaLabelForEpic(issue.epic.code),
      "--milestone",
      `${issue.epic.code} ${issue.epic.name}`,
    ]);

    const numberMatch = output.match(/\/issues\/(\d+)$/);
    if (!numberMatch) {
      throw new Error(`Unable to parse issue number from output: ${output}`);
    }

    numberById.set(issue.id, Number(numberMatch[1]));
  }

  for (const issue of issues) {
    const number = numberById.get(issue.id);
    if (!number) continue;
    const bodyPath = join(tempDir, `${issue.id}-final.md`);
    writeFileSync(bodyPath, renderBody(issue, numberById));
    runGh(["issue", "edit", String(number), "--repo", repo, "--body-file", bodyPath]);
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log(JSON.stringify(Object.fromEntries(numberById), null, 2));
