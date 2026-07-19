/**
 * Module <-> project-skill coverage gate (Issue #829, part of the #818
 * post-audit hardening epic).
 *
 * WHY THIS FILE EXISTS. Skill/doc drift is a *recurring* class of bug in
 * this repo — #829 is its SIXTH confirmed occurrence (see #805 and its
 * predecessors). The specific shape #829 found: five ACTIVE modules
 * (`data_exchange`, `organization_structure`, `reference_data`,
 * `reporting`, `domain_event_runtime`) had no project skill at all, while
 * eighteen others did. Four of those five turned up as the SOURCE of a
 * finding in the same audit (#820, #822, #826, and #786's port wiring) —
 * a coincidence that is not a coincidence: a module with no written
 * convention guidance is a module whose conventions drift.
 *
 * The root cause was never "someone forgot five times". It was that
 * NOTHING compared the module registry against the skills directory. A new
 * skill must be wired into the two discoverability catalogs by convention
 * (`AGENTS.md` + `.claude/skills/README.md`), but no gate enforced either
 * half. The registry knows there are 23 modules; nothing checked that
 * against `.claude/skills/`. Writing the five missing skills alone would
 * only have delayed occurrence number seven — so this gate, not those five
 * files, is what #829 is actually for.
 *
 * WHAT IT ENFORCES. Every module in the BASE registry (`listBaseModules()`,
 * `src/modules/index.ts`) must be accounted for EXPLICITLY, in exactly one
 * of two maps below:
 *
 *   1. `MODULE_SKILL_MAP` — the module has a dedicated skill. That skill's
 *      `SKILL.md` must exist, its frontmatter `name` must match its
 *      directory, and it must appear in BOTH catalogs. A skill file that
 *      exists on disk but that nothing points to is the exact defect a
 *      reviewer caught on PR #806 (4 new skills, 0 catalog entries) — "the
 *      file exists" is necessary, not sufficient.
 *   2. `MODULES_COVERED_BY_CROSS_CUTTING_SKILLS` — the module deliberately
 *      has no dedicated skill because cross-cutting technique skills
 *      already carry its guidance. This is the "explicit allow-list for
 *      what genuinely doesn't need one" #829 asks for. Each entry must
 *      name the skills that DO cover it, and those skills must themselves
 *      exist — so the rationale cannot quietly rot into a lie the way an
 *      unchecked prose claim would.
 *
 * A module in NEITHER map fails loudly, with the remediation spelled out
 * in the failure message. That is the drift-killing property: adding a
 * module to `src/modules/index.ts` without making a conscious, reviewed
 * decision about its guidance is no longer possible.
 *
 * DELIBERATELY NOT MECHANICAL. The map is hand-maintained rather than
 * derived by string transform (`foo_bar` -> `awcms-mini-foo-bar`) because
 * several real mappings are not mechanical: `tenant_domain` ->
 * `awcms-mini-tenant-domain-routing`, `logging` ->
 * `awcms-mini-observability`, `sync_storage` -> `awcms-mini-sync-hmac`. A
 * convention-only gate would have to special-case those anyway, and a
 * grep-the-skills-for-the-module-name heuristic is far too loose to gate
 * on (probed during this issue: `awcms-mini-module-management` mentions
 * all 23 keys, so every module would trivially "have a skill"). An
 * explicit map states the intent instead of inferring it.
 *
 * SCOPE. Base registry only. A derived application contributing its own
 * modules via `application-registry.ts` (Issue #740) is not required to
 * carry a skill in THIS repo's `.claude/skills/`, so `listBaseModules()`
 * is the correct ground truth here, not `listModules()`.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { listBaseModules } from "../../src/modules";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const SKILLS_DIR = path.join(REPO_ROOT, ".claude/skills");

/** The two discoverability catalogs a dedicated module skill must appear in. */
const CATALOG_FILES = [
  path.join(REPO_ROOT, "AGENTS.md"),
  path.join(SKILLS_DIR, "README.md")
];

/**
 * Module key -> the skill that is the PRIMARY written guidance for evolving
 * that module. Most follow the `awcms-mini-<key-with-dashes>` convention;
 * the three that don't are called out inline so the exception stays visible
 * rather than looking like a typo.
 */
const MODULE_SKILL_MAP: Readonly<Record<string, string>> = {
  blog_content: "awcms-mini-blog-content",
  data_exchange: "awcms-mini-data-exchange",
  data_lifecycle: "awcms-mini-data-lifecycle",
  document_infrastructure: "awcms-mini-document-infrastructure",
  domain_event_runtime: "awcms-mini-domain-event-runtime",
  email: "awcms-mini-email",
  form_drafts: "awcms-mini-form-drafts",
  idn_admin_regions: "awcms-mini-idn-admin-regions",
  integration_hub: "awcms-mini-integration-hub",
  // Non-mechanical: the logging module's own "how the log/audit/metrics
  // system itself is managed" skill is named for the concern, not the
  // module (`awcms-mini-audit-log` is the separate "what must be audited"
  // technique skill, which is NOT this module's guidance).
  logging: "awcms-mini-observability",
  module_management: "awcms-mini-module-management",
  news_portal: "awcms-mini-news-portal",
  organization_structure: "awcms-mini-organization-structure",
  profile_identity: "awcms-mini-profile-identity",
  reference_data: "awcms-mini-reference-data",
  reporting: "awcms-mini-reporting",
  // Issue #870 (epic #868 SaaS control plane) — the first control-plane module.
  service_catalog: "awcms-mini-service-catalog",
  social_publishing: "awcms-mini-social-publishing",
  // Non-mechanical: the sync_storage module's guidance is the HMAC/
  // anti-replay sync skill (doc 08), which covers its push/pull and object
  // queue surface.
  sync_storage: "awcms-mini-sync-hmac",
  // Non-mechanical: the epic skill covers the module end-to-end.
  tenant_domain: "awcms-mini-tenant-domain-routing",
  // Issue #871 (epic #868 SaaS control plane) — the second control-plane module.
  tenant_entitlement: "awcms-mini-tenant-entitlement",
  visitor_analytics: "awcms-mini-visitor-analytics",
  // Non-mechanical, and NOT a typo: the registered key really is `workflow`,
  // even though the directory is `src/modules/workflow-approval` and every
  // doc/skill/README calls the module `workflow_approval`. Caught by this
  // gate on its very first run. Left as-is here (renaming the key would move
  // its whole `workflow.*` permission namespace — out of #829's scope); the
  // divergence is recorded here so the next reader doesn't "fix" this line.
  workflow: "awcms-mini-workflow-approval"
};

/**
 * The EXPLICIT allow-list: modules that deliberately have no dedicated
 * skill. `coveredBy` names the cross-cutting skills that carry their
 * guidance instead; those must exist, so this rationale stays verifiable.
 *
 * Keep this list SMALL and argued. "No dedicated skill" is a real
 * decision with a cost — four of the five modules #829 found missing were
 * also the audit's own finding sources. If a module here ever grows its
 * own non-obvious invariants, the right move is to promote it into
 * `MODULE_SKILL_MAP`, not to widen this rationale.
 */
const MODULES_COVERED_BY_CROSS_CUTTING_SKILLS: Readonly<
  Record<string, { coveredBy: readonly string[]; rationale: string }>
> = {
  tenant_admin: {
    coveredBy: [
      "awcms-mini-abac-guard",
      "awcms-mini-new-migration",
      "awcms-mini-module-management"
    ],
    rationale:
      "Core tenant/office registry. Its conventions ARE the repo-wide tenant-context + RLS + default-deny rules those three skills already encode in full; a dedicated skill would restate them and become a fourth stale copy of the same facts (the '3+ independent stale copies of one shared fact' sub-pattern from the 4th drift round)."
  },
  identity_access: {
    coveredBy: [
      "awcms-mini-abac-guard",
      "awcms-mini-audit-log",
      "awcms-mini-auth-online-hardening"
    ],
    rationale:
      "Core RBAC/ABAC/session module. `awcms-mini-abac-guard` (access-control mechanics + AccessAction/HIGH_RISK_ACTIONS), `awcms-mini-audit-log` (what it must record), and `awcms-mini-auth-online-hardening` (its own hardening epic, #587-#593) together cover it; the module has no separate domain vocabulary beyond those."
  }
};

function skillDir(skillName: string): string {
  return path.join(SKILLS_DIR, skillName);
}

function skillFile(skillName: string): string {
  return path.join(skillDir(skillName), "SKILL.md");
}

function skillExists(skillName: string): boolean {
  return existsSync(skillFile(skillName));
}

/**
 * Read a SKILL.md's frontmatter `name`. Intentionally a narrow line scan of
 * the leading `---` block rather than a YAML dependency: the only field
 * this gate cares about is `name`, and every SKILL.md in this repo declares
 * it as a plain single-line scalar.
 */
function readSkillFrontmatterName(skillName: string): string | null {
  const raw = readFileSync(skillFile(skillName), "utf8");
  if (!raw.startsWith("---\n")) {
    return null;
  }
  const end = raw.indexOf("\n---", 4);
  if (end === -1) {
    return null;
  }
  const frontmatter = raw.slice(4, end);
  for (const line of frontmatter.split("\n")) {
    const match = /^name:\s*(\S+)\s*$/.exec(line);
    if (match) {
      return match[1] ?? null;
    }
  }
  return null;
}

const catalogText = new Map<string, string>(
  CATALOG_FILES.map((file) => [file, readFileSync(file, "utf8")])
);

const baseModuleKeys = listBaseModules().map((module) => module.key);

describe("module <-> project-skill coverage (Issue #829)", () => {
  test("every base module is explicitly accounted for in exactly one map", () => {
    const unaccounted: string[] = [];
    const doubleCounted: string[] = [];

    for (const key of baseModuleKeys) {
      const hasDedicated = key in MODULE_SKILL_MAP;
      const isAllowListed = key in MODULES_COVERED_BY_CROSS_CUTTING_SKILLS;

      if (hasDedicated && isAllowListed) {
        doubleCounted.push(key);
      } else if (!hasDedicated && !isAllowListed) {
        unaccounted.push(key);
      }
    }

    expect(
      doubleCounted,
      `Module(s) listed in BOTH MODULE_SKILL_MAP and MODULES_COVERED_BY_CROSS_CUTTING_SKILLS: ${doubleCounted.join(", ")}. A module either has a dedicated skill or is allow-listed — never both.`
    ).toEqual([]);

    expect(
      unaccounted,
      [
        `Module(s) registered in src/modules/index.ts with no project skill and no allow-list entry: ${unaccounted.join(", ")}.`,
        "",
        "This is the drift Issue #829 exists to stop (its 6th recurrence). Pick one:",
        "  (a) Write .claude/skills/awcms-mini-<module>/SKILL.md, wire it into BOTH",
        "      AGENTS.md and .claude/skills/README.md, then add it to MODULE_SKILL_MAP.",
        "  (b) If the module genuinely needs no dedicated skill, add it to",
        "      MODULES_COVERED_BY_CROSS_CUTTING_SKILLS with the skills that DO cover it",
        "      and a rationale — a reviewed decision, not an omission.",
        "",
        "Do not delete this test to make it pass."
      ].join("\n")
    ).toEqual([]);
  });

  test("neither map names a module that left the registry", () => {
    const registered = new Set(baseModuleKeys);
    const stale = [
      ...Object.keys(MODULE_SKILL_MAP),
      ...Object.keys(MODULES_COVERED_BY_CROSS_CUTTING_SKILLS)
    ].filter((key) => !registered.has(key));

    expect(
      stale,
      `Map entr(ies) for module key(s) not in listBaseModules(): ${stale.join(", ")}. A renamed/removed module leaves its mapping behind — drift in the other direction.`
    ).toEqual([]);
  });

  test("every mapped dedicated skill file exists", () => {
    const missing = Object.entries(MODULE_SKILL_MAP)
      .filter(([, skill]) => !skillExists(skill))
      .map(([key, skill]) => `${key} -> .claude/skills/${skill}/SKILL.md`);

    expect(
      missing,
      `Mapped skill file(s) missing: ${missing.join(", ")}.`
    ).toEqual([]);
  });

  test("every mapped skill's frontmatter name matches its directory", () => {
    const mismatched: string[] = [];

    for (const skill of new Set(Object.values(MODULE_SKILL_MAP))) {
      if (!skillExists(skill)) {
        continue; // reported by the existence test above
      }
      const declared = readSkillFrontmatterName(skill);
      if (declared !== skill) {
        mismatched.push(
          `.claude/skills/${skill}/SKILL.md declares name: ${declared ?? "(none)"}`
        );
      }
    }

    expect(
      mismatched,
      `Skill frontmatter name must equal its directory name (that name is how the skill is invoked): ${mismatched.join("; ")}.`
    ).toEqual([]);
  });

  test("every mapped dedicated skill is wired into BOTH discoverability catalogs", () => {
    const unlisted: string[] = [];

    for (const skill of new Set(Object.values(MODULE_SKILL_MAP))) {
      for (const [file, text] of catalogText) {
        if (!text.includes(skill)) {
          unlisted.push(
            `${skill} not listed in ${path.relative(REPO_ROOT, file)}`
          );
        }
      }
    }

    expect(
      unlisted,
      [
        `Skill(s) not discoverable from a catalog: ${unlisted.join("; ")}.`,
        "",
        "A SKILL.md on disk that nothing points to is not done — this exact gap",
        "(4 new skills, 0 catalog entries) was caught by a reviewer on PR #806.",
        "Add a row to AGENTS.md's skill table AND .claude/skills/README.md's Katalog."
      ].join("\n")
    ).toEqual([]);
  });

  test("every allow-listed module names cross-cutting skills that actually exist", () => {
    const broken: string[] = [];

    for (const [key, entry] of Object.entries(
      MODULES_COVERED_BY_CROSS_CUTTING_SKILLS
    )) {
      expect(
        entry.coveredBy.length,
        `Allow-list entry for "${key}" must name at least one covering skill.`
      ).toBeGreaterThan(0);
      expect(
        entry.rationale.trim().length,
        `Allow-list entry for "${key}" must carry a rationale.`
      ).toBeGreaterThan(0);

      for (const skill of entry.coveredBy) {
        if (!skillExists(skill)) {
          broken.push(`${key} -> ${skill} (missing)`);
        }
      }
    }

    expect(
      broken,
      `Allow-list rationale names skill(s) that do not exist: ${broken.join(", ")}. The justification for having no dedicated skill must stay true.`
    ).toEqual([]);
  });

  test("the registry has not silently grown past the reviewed module set", () => {
    // A count assertion is redundant with the per-module checks above, but it
    // makes the "N modules" number that keeps propagating into docs (the
    // '14 modules'/'16 modules' sub-pattern, now seen twice) fail HERE first,
    // next to the registry, instead of being discovered by a later audit.
    expect(baseModuleKeys.length).toBe(
      Object.keys(MODULE_SKILL_MAP).length +
        Object.keys(MODULES_COVERED_BY_CROSS_CUTTING_SKILLS).length
    );
  });
});
