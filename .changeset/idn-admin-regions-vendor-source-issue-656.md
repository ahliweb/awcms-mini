---
"awcms-mini": patch
---

Vendor the upstream `cahyadsn/wilayah` (MIT License) source dataset and
provenance metadata under `data/idn-admin-regions/` (Issue #656, epic
#654 — master data wilayah administratif Indonesia, following #655's
module scaffold). Adds `README.md`, `NOTICE.md` (upstream attribution +
official-reference caveat), `manifest.schema.json`, `manifest.json`
(dataset code, upstream repo/commit SHA/license, file list with SHA-256
checksums), a top-level `checksums.sha256`, and
`upstream/cahyadsn-wilayah/` (verbatim upstream `LICENSE`, `SOURCE.md`
recording the imported commit SHA/timestamp/file list, a scoped
`checksums.sha256`, and the four raw `db/*.sql` files named in the issue
— `wilayah.sql`, `wilayah_pulau.sql`, `wilayah_penduduk.sql`,
`wilayah_luas.sql`).

No code, schema, or endpoint changes — pure third-party data vendoring.
Adds a `.gitattributes` rule (`data/idn-admin-regions/upstream/**
binary`) so Git never normalizes these vendored files' line endings
(upstream `wilayah.sql` ships CRLF), which would otherwise silently
mutate the committed bytes and invalidate the recorded checksums.
