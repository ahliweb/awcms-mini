---
"awcms-mini": patch
---

fix(release): align `release.yml` trigger with the tag Changesets actually emits (`awcms-mini@*`)

The automated release path was structurally dead: `.changeset/config.json`'s
`privatePackages: { version: true, tag: true }` makes `bun run changeset:tag`
create `awcms-mini@X.Y.Z`, but `.github/workflows/release.yml` triggered on
`push: tags: v*.*.*` — a pattern that tag can never match. Per the owner's
Option 1 decision (follow Changesets), the trigger is now `awcms-mini@*` and
`privatePackages.tag: true` is retained; the manual `vX.Y.Z` tag is no longer
a supported entry point.

Consistency changes so the whole chain uses the same tag shape:

- `scripts/release-verify.ts` `normalizeTagVersion` now strips the
  `awcms-mini@` prefix (in addition to `refs/tags/` and a legacy `v`), so
  the `release:verify` gate correctly compares `awcms-mini@X.Y.Z` against
  `package.json`.
- The `gh release create` title uses the bare version instead of
  `github.ref_name`, so it reads "awcms-mini X.Y.Z" rather than
  "awcms-mini awcms-mini@X.Y.Z". The GitHub Release git tag is unchanged
  (`awcms-mini@X.Y.Z`).
- `docs/awcms-mini/release-process.md` now distinguishes the git tag
  (`awcms-mini@X.Y.Z`) from the container image tag (bare `X.Y.Z`), and the
  cosign verification example keys on `refs/tags/awcms-mini@.*`.

Owner-only follow-ups remain open on Issue #825 (NOT done here): review
`required_reviewers` on the `release` GitHub Environment (the rehearsal run
hung >26h waiting on it), and approve a rehearsal end-to-end through
sign + attest + publish. No release tag was pushed by this change.
