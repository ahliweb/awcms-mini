# Source record — `cahyadsn/wilayah`

Issue #656 (epic #654, master data wilayah administratif Indonesia). This
file records exactly what was imported, from where, and when, so the
files in this directory can be re-verified or re-fetched later.

See also `src/modules/idn-admin-regions/domain/source-provenance.ts` for
these same facts as trusted code constants, and
`data/idn-admin-regions/NOTICE.md` for the upstream attribution notice.

## Upstream repository

- **Repository**: <https://github.com/cahyadsn/wilayah>
- **Branch**: `master`
- **Imported commit SHA**: `cae306278e5be616c83ba2d8096b00767f45b5fe`
- **Upstream commit date**: 2026-07-10 20:37:13 +0700
- **Source path**: [`db/`](https://github.com/cahyadsn/wilayah/tree/cae306278e5be616c83ba2d8096b00767f45b5fe/db)
- **License**: MIT (see [`LICENSE`](./LICENSE) in this directory, copied
  verbatim from the upstream repository root)

## Import timestamp

- **Imported at (UTC)**: 2026-07-12T11:40:47Z

## Imported files

Only the four files listed in Issue #656's scope were imported — the
upstream `db/` folder also contains `wilayah_level_1_2.sql` (a larger,
enriched provinsi/kab-kota dataset with coordinates/elevation/timezone/
boundaries) and an `archive/` folder of superseded prior-year datasets;
neither is in scope for this issue and neither was imported.

| Upstream path             | Vendored path             | SHA-256                                                            | Size (bytes) |
| ------------------------- | ------------------------- | ------------------------------------------------------------------ | ------------ |
| `db/wilayah.sql`          | `db/wilayah.sql`          | `c4c3396d9380d4edee072af1d9dff83573b574d7cd00a6562cf82e200e954031` | 2,947,579    |
| `db/wilayah_pulau.sql`    | `db/wilayah_pulau.sql`    | `6bebd693d96f7b55cf887392921d8a663b8f74fd5450883d64003a2f04c0c6a2` | 1,251,530    |
| `db/wilayah_penduduk.sql` | `db/wilayah_penduduk.sql` | `b0b6b9dc70fa6a4fdb9e05bf00ec549ed8f6cf0bb82f6407281dfac674b10447` | 34,429       |
| `db/wilayah_luas.sql`     | `db/wilayah_luas.sql`     | `3ffd506eaabaa2bfa101fb24c5e40582cf9548be38adba53a561d0ed7478c043` | 26,322       |
| `LICENSE` (repo root)     | `LICENSE`                 | `bd2e18e40a01567ce518c9b866041ad212838dd51df3596e0b97425b52e3fdcb` | 1,071        |

All five checksums above are also recorded in machine-verifiable form in
[`checksums.sha256`](./checksums.sha256) in this directory (run
`sha256sum -c checksums.sha256` from here to re-verify), and again in
`data/idn-admin-regions/manifest.json` at the dataset level.

## How these files were obtained

A shallow (`--depth 1`) `git clone` of
`https://github.com/cahyadsn/wilayah.git` was performed against the
`master` branch, resolving to the commit SHA above. The five files listed
were copied byte-for-byte (no manual edits, no line-ending conversion —
see the `data/idn-admin-regions/upstream/** binary` rule in the repo's
`.gitattributes`, added by this same issue, which stops Git's normal
LF-normalization from silently mutating these vendored bytes on commit).
`db/wilayah.sql` ships with upstream CRLF line endings; that is preserved
verbatim here rather than converted to this repo's usual LF convention,
precisely so the checksums above stay a true integrity proof against the
original upstream file rather than against a locally-modified copy.

## Rules honored (per Issue #656)

- Raw files in `db/` are **never** hand-edited. If a normalized/derived
  form is needed by a later issue (Issue #658's parser/normalizer), it is
  stored separately under `data/idn-admin-regions/normalized/` (not yet
  created as of this issue), never by modifying these files in place.
- The upstream MIT License is preserved verbatim (`LICENSE` in this
  directory) and the upstream repository URL is preserved above and in
  `data/idn-admin-regions/manifest.json`.
- This import does not claim to be an official Kementerian Dalam Negeri
  (Kemendagri) publication — see the official-reference caveat in
  `data/idn-admin-regions/NOTICE.md` and
  `../../../../src/modules/idn-admin-regions/README.md`.
