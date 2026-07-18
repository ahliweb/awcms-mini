---
"awcms-mini": patch
---

fix(release): reconcile release pipeline to the tag/changelog format Changesets actually emits (#825)

The first real release attempt surfaced that the automated release path
had never worked end-to-end, for reasons the original #825/#854 diagnosis
got backwards:

- **Tag format.** `bun run changeset:tag` emits `vX.Y.Z` for this
  single-package repo (Changesets uses `v<version>` for a single root
  package, not `<name>@<version>`). The legacy `awcms-mini@0.0.x` tags were
  hand-made, not changeset output, and misled the audit. #854 had switched
  `release.yml`'s trigger to `awcms-mini@*` — which `changeset:tag` never
  produces here — so this reverts the trigger (and the cosign
  identity-regexp doc) back to `v*.*.*`, matching the generator.
- **Changelog header format.** `changeset:version` writes `## X.Y.Z`, but
  both `scripts/release-verify.ts` and `release.yml`'s RELEASE_NOTES `awk`
  only recognized the legacy `## [X.Y.Z]` bracket form — so `release:verify`
  failed and release notes came out empty for every changeset-generated
  release. Both now accept `## X.Y.Z` and the legacy `## [X.Y.Z]`.

No runtime/product behavior changes; release tooling + docs only. The
build/SBOM/cosign/attest/publish mechanics themselves were already proven
(rehearsal run 29640049800, SLSA provenance attestation verified).
