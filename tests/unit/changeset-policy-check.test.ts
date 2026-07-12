import { describe, expect, test } from "bun:test";

import {
  evaluateChangesetPolicy,
  validateChangesetFrontmatter
} from "../../scripts/changeset-policy-check";

describe("evaluateChangesetPolicy", () => {
  test("docs-only PR does not require a changeset (matches PR #595 precedent)", () => {
    const result = evaluateChangesetPolicy([
      "docs/awcms-mini/github/issues-open-001.md",
      "docs/awcms-mini/github/README.md"
    ]);

    expect(result.requiresChangeset).toBe(false);
    expect(result.violation).toBeNull();
  });

  test("docs + .claude skill-only PR does not require a changeset (matches PR #585 precedent)", () => {
    const result = evaluateChangesetPolicy([
      ".claude/skills/awcms-mini-github-snapshot/SKILL.md",
      "docs/awcms-mini/github/security.md"
    ]);

    expect(result.requiresChangeset).toBe(false);
    expect(result.violation).toBeNull();
  });

  test("root markdown file (AGENTS.md) alone is exempt", () => {
    const result = evaluateChangesetPolicy(["AGENTS.md", "CHANGELOG.md"]);

    expect(result.requiresChangeset).toBe(false);
  });

  test("workflow-only change requires a changeset when none is added", () => {
    const result = evaluateChangesetPolicy([".github/workflows/ci.yml"]);

    expect(result.requiresChangeset).toBe(true);
    expect(result.changesetFilesAdded).toEqual([]);
    expect(result.violation).not.toBeNull();
    expect(result.violation).toContain(".github/workflows/ci.yml");
  });

  test("source change with a new changeset file passes", () => {
    const result = evaluateChangesetPolicy([
      "src/modules/blog-content/module.ts",
      ".changeset/some-feature.md"
    ]);

    expect(result.requiresChangeset).toBe(true);
    expect(result.changesetFilesAdded).toEqual([".changeset/some-feature.md"]);
    expect(result.violation).toBeNull();
  });

  test("adding only .changeset/README.md does not count as a real changeset", () => {
    const result = evaluateChangesetPolicy([
      "scripts/db-migrate.ts",
      ".changeset/README.md"
    ]);

    expect(result.requiresChangeset).toBe(true);
    expect(result.changesetFilesAdded).toEqual([]);
    expect(result.violation).not.toBeNull();
  });

  test("test-only changes are not exempt (deliberately strict default)", () => {
    const result = evaluateChangesetPolicy(["tests/unit/some-new.test.ts"]);

    expect(result.requiresChangeset).toBe(true);
    expect(result.violation).not.toBeNull();
  });

  test("mixed docs + source change requires a changeset covering the whole PR", () => {
    const result = evaluateChangesetPolicy([
      "docs/awcms-mini/09_roadmap_repository_commit.md",
      "src/lib/config/registry.ts"
    ]);

    expect(result.requiresChangeset).toBe(true);
    expect(result.nonExemptFiles).toEqual(["src/lib/config/registry.ts"]);
  });
});

describe("validateChangesetFrontmatter", () => {
  test("accepts a well-formed changeset", () => {
    const content = [
      "---",
      '"awcms-mini": minor',
      "---",
      "",
      "Add a feature."
    ].join("\n");

    expect(validateChangesetFrontmatter(content)).toEqual({ ok: true });
  });

  test("accepts unquoted package name and patch bump", () => {
    const content = ["---", "awcms-mini: patch", "---", "", "Fix a bug."].join(
      "\n"
    );

    expect(validateChangesetFrontmatter(content).ok).toBe(true);
  });

  test("rejects missing frontmatter", () => {
    const result = validateChangesetFrontmatter(
      "Just a description, no frontmatter."
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("frontmatter");
  });

  test("rejects wrong package name", () => {
    const content = ["---", '"some-other-package": minor', "---", ""].join(
      "\n"
    );

    const result = validateChangesetFrontmatter(content);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("awcms-mini");
  });

  test("rejects invalid bump level", () => {
    const content = ["---", '"awcms-mini": banana', "---", ""].join("\n");

    const result = validateChangesetFrontmatter(content);

    expect(result.ok).toBe(false);
  });
});
