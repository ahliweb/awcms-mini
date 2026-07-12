# `data/idn-admin-regions/` — vendored Indonesia administrative region data

Issue #656 (epic #654, module `idn_admin_regions` —
`src/modules/idn-admin-regions/`). This directory holds third-party data
files vendored from [`cahyadsn/wilayah`](https://github.com/cahyadsn/wilayah)
(MIT License) plus the provenance/license/checksum metadata required to
track them, and (in later issues of the same epic) their normalized
derivatives.

**Read [`NOTICE.md`](./NOTICE.md) before using any file in this directory** —
it carries the required upstream attribution and the official-reference
caveat (this is a third-party community dataset, not an official
Kementerian Dalam Negeri/Kemendagri export).

## Layout

```text
data/idn-admin-regions/
├── README.md              # this file
├── NOTICE.md               # upstream attribution + official-reference caveat
├── manifest.schema.json    # JSON Schema for manifest.json
├── manifest.json           # dataset code, upstream repo/commit/license, file list + checksums
├── checksums.sha256        # sha256sum-compatible checksums for every vendored file below
└── upstream/
    └── cahyadsn-wilayah/    # raw upstream files, byte-for-byte, never hand-edited
        ├── LICENSE          # upstream MIT License, verbatim
        ├── SOURCE.md        # repo URL, branch, commit SHA, import timestamp, imported files
        ├── checksums.sha256 # sha256sum-compatible checksums, scoped to this subdirectory
        └── db/
            ├── wilayah.sql          # provinsi/kab-kota/kec/desa-kelurahan codes+names
            ├── wilayah_pulau.sql    # island (pulau) codes+names
            ├── wilayah_penduduk.sql # population per province/regency-city
            └── wilayah_luas.sql     # area (luas) per province/regency-city
```

A `normalized/` directory (for PostgreSQL-ready normalized derivatives of
the raw files above) is **not yet created** — Issue #658 (SQL parser and
normalizer) introduces it. Per this issue's own rule: raw upstream files
in `upstream/` are never hand-edited, and any generated/normalized output
is kept in a clearly separate directory rather than mixed in with the
raw upstream copies.

## Verifying integrity

Every vendored file's SHA-256 is recorded twice: in
[`manifest.json`](./manifest.json)'s `files` array (machine-readable,
with byte sizes and a `role`), and in plain `sha256sum`-compatible form
in [`checksums.sha256`](./checksums.sha256) (top level, paths relative to
this directory) and
[`upstream/cahyadsn-wilayah/checksums.sha256`](./upstream/cahyadsn-wilayah/checksums.sha256)
(scoped to just that subdirectory). To re-verify from a checkout of this
repository:

```bash
cd data/idn-admin-regions
sha256sum -c checksums.sha256
```

Both should print `OK` for every listed file. A mismatch means the
committed file no longer matches what was imported from upstream — see
`upstream/cahyadsn-wilayah/SOURCE.md` for how to re-fetch and re-verify
against the recorded commit SHA.

## Why line endings matter here

`db/wilayah.sql` ships from upstream with CRLF line endings (the other
three `.sql` files and `LICENSE` use LF). This repository's own
convention normalizes everything to LF (`.gitattributes`,
`* text=auto eol=lf`) — but doing that to a vendored third-party file
would silently change its bytes, which would both violate "do not edit
raw upstream files" and invalidate every checksum above the moment the
file is committed. This issue adds a scoped override,
`data/idn-admin-regions/upstream/** binary`, in the repo's root
`.gitattributes`, so Git preserves these files' exact original bytes
(including `db/wilayah.sql`'s CRLF) rather than normalizing them.

## Source and license

- **Repository**: <https://github.com/cahyadsn/wilayah>
- **Source folder**: <https://github.com/cahyadsn/wilayah/tree/master/db>
- **License**: MIT (`upstream/cahyadsn-wilayah/LICENSE`, verbatim)
- **Imported commit**: `cae306278e5be616c83ba2d8096b00767f45b5fe` (branch
  `master`) — see `manifest.json` / `upstream/cahyadsn-wilayah/SOURCE.md`
  for the full record.

These same facts are also recorded as trusted code constants in
`src/modules/idn-admin-regions/domain/source-provenance.ts` — see that
file and the module's own `src/modules/idn-admin-regions/README.md` for
the complete source/license/caveat narrative shared across this whole
epic, and `.claude/skills/awcms-mini-idn-admin-regions/SKILL.md` for the
full cross-issue plan (#655-#664).

## What this issue does NOT do

Per Issue #656's own scope, and to avoid duplicating later issues in
this epic:

- No PostgreSQL schema (Issue #657).
- No parser/normalizer, no `normalized/` output (Issue #658).
- No repository validation gate/script that automatically checks these
  files against `manifest.json` (Issue #659) — for now, integrity is
  verified manually via `sha256sum -c` as documented above.
- No import into a running database, no activation/rollback (Issue #660,
  #661).
- No lookup API or admin UI (Issue #662, #663).
