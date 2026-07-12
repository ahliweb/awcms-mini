import { describe, expect, test } from "bun:test";

import {
  checkChangelogHasVersionSection,
  checkNoPendingChangesets,
  checkVersionMatchesTag,
  normalizeTagVersion,
  runReleaseVerify
} from "../../scripts/release-verify";

describe("normalizeTagVersion", () => {
  test("strips refs/tags/ prefix and leading v", () => {
    expect(normalizeTagVersion("refs/tags/v1.2.3")).toBe("1.2.3");
    expect(normalizeTagVersion("v1.2.3")).toBe("1.2.3");
    expect(normalizeTagVersion("1.2.3")).toBe("1.2.3");
  });
});

describe("checkVersionMatchesTag", () => {
  test("passes when package.json version matches the tag", () => {
    expect(checkVersionMatchesTag("0.24.0", "v0.24.0")).toBeNull();
  });

  test("fails when versions differ", () => {
    const problem = checkVersionMatchesTag("0.23.5", "v0.24.0");

    expect(problem).not.toBeNull();
    expect(problem?.check).toBe("version-matches-tag");
  });
});

describe("checkChangelogHasVersionSection", () => {
  test("passes when the exact version heading exists", () => {
    const changelog = "# Changelog\n\n## [0.24.0] - 2026-07-12\n\n### Added\n";

    expect(checkChangelogHasVersionSection(changelog, "0.24.0")).toBeNull();
  });

  test("fails when the heading is missing", () => {
    const changelog = "# Changelog\n\n## [0.23.5] - 2026-07-06\n";

    const problem = checkChangelogHasVersionSection(changelog, "0.24.0");

    expect(problem).not.toBeNull();
    expect(problem?.check).toBe("changelog-has-version-section");
  });

  test("does not false-match a version that is a substring of another", () => {
    const changelog = "## [0.24.0] - 2026-07-12\n";

    // "0.24" alone must not match against the "0.24.0" heading.
    const problem = checkChangelogHasVersionSection(changelog, "0.24");

    expect(problem).not.toBeNull();
  });
});

describe("checkNoPendingChangesets", () => {
  test("passes when only config.json/README.md remain", () => {
    expect(checkNoPendingChangesets(["config.json", "README.md"])).toBeNull();
  });

  test("fails when a real changeset file remains unconsumed", () => {
    const problem = checkNoPendingChangesets([
      "config.json",
      "README.md",
      "some-feature.md"
    ]);

    expect(problem).not.toBeNull();
    expect(problem?.check).toBe("no-pending-changesets");
    expect(problem?.message).toContain("some-feature.md");
  });
});

describe("runReleaseVerify", () => {
  test("returns no problems for a fully consistent release", () => {
    const problems = runReleaseVerify({
      packageVersion: "0.24.0",
      tagRef: "v0.24.0",
      changelogContent: "## [0.24.0] - 2026-07-12\n",
      changesetFileNames: ["config.json", "README.md"]
    });

    expect(problems).toEqual([]);
  });

  test("collects every failing check, not just the first", () => {
    const problems = runReleaseVerify({
      packageVersion: "0.23.5",
      tagRef: "v0.24.0",
      changelogContent: "## [0.23.5] - 2026-07-06\n",
      changesetFileNames: ["config.json", "README.md", "pending.md"]
    });

    expect(problems).toHaveLength(3);
    expect(problems.map((p) => p.check)).toEqual([
      "version-matches-tag",
      "changelog-has-version-section",
      "no-pending-changesets"
    ]);
  });
});
