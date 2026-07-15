---
"awcms-mini": patch
---

Fix `scripts/changeset-policy-check.ts` crashing with `ENOENT` on any
release-consumption PR (Issue #810). `git diff --name-only` doesn't
distinguish added vs. deleted paths, so the changed-`.changeset/*.md`-file
detection included paths deleted by the PR (e.g. consumed changesets removed
by `bun run changeset:version`), then tried to read their content for
frontmatter validation and crashed.

The first fix attempt (skip frontmatter validation for deleted paths) had a
security side effect a review pass caught before merge: it made the
pre-existing "any touched `.changeset/*.md` path counts as satisfied" logic
silently PASS a PR that *deletes* an existing pending changeset instead of
adding a new one, converting an accidental crash (fail-closed) into a
silent bypass (fail-open) of the "changeset required" gate. Replaced with a
narrow, content-verified release-consumption carve-out: the requirement is
waived only when a `.changeset/*.md` file was genuinely deleted, the ONLY
non-exempt file touched is `package.json`, and that file's diff changes
nothing but its `version` field (verified via `git show` on both sides,
failing closed on any ambiguity). Added a CLI-level regression suite that
spawns the real script against disposable git repos to exercise this
wiring directly, including a reproduction of the exploit confirmed blocked.
