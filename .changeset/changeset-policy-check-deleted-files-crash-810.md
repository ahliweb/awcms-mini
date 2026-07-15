---
"awcms-mini": patch
---

Fix `scripts/changeset-policy-check.ts` crashing with `ENOENT` on any
release-consumption PR (Issue #810). `git diff --name-only` doesn't
distinguish added vs. deleted paths, so the changed-`.changeset/*.md`-file
detection included paths deleted by the PR (e.g. consumed changesets removed
by `bun run changeset:version`), then tried to read their content for
frontmatter validation and crashed. Now cross-references
`git diff --name-only --diff-filter=D` and skips frontmatter validation for
deleted paths instead of erroring.
