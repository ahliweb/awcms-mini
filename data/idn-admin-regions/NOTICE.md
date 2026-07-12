# NOTICE

This directory vendors selected third-party data files used by the
`idn_admin_regions` module (epic #654, Issue #656). This NOTICE records
the required upstream attribution.

## Third-party content: `cahyadsn/wilayah`

This product includes data from **`cahyadsn/wilayah`**
(<https://github.com/cahyadsn/wilayah>), copyright (c) 2017-2025 Cahya
DSN, licensed under the **MIT License**.

The full, unmodified license text is included verbatim at
[`upstream/cahyadsn-wilayah/LICENSE`](./upstream/cahyadsn-wilayah/LICENSE).

Upstream's own statement of what this dataset represents (quoted
verbatim, not paraphrased):

> Kode dan Data Wilayah Administrasi Pemerintahan dan Kode Pulau
> Indonesia sesuai Kepmendagri No. 300.2.2-2430 Tahun 2025.

See [`upstream/cahyadsn-wilayah/SOURCE.md`](./upstream/cahyadsn-wilayah/SOURCE.md)
for the exact imported commit SHA, import timestamp, and the list of
imported files with their SHA-256 checksums.

## Official-reference caveat

**This is a third-party, community-packaged dataset, not an official
Kementerian Dalam Negeri (Kemendagri) API or export.** `cahyadsn/wilayah`
is an independent, MIT-licensed GitHub repository that packages
administrative region data following the Kepmendagri decree quoted
above. AWCMS-Mini vendors selected files from it as a convenience for
derived applications that need Indonesia region lookups — AWCMS-Mini
never claims to be an official Kemendagri publisher, feed, or export of
this data, and this dataset does not replace an operator's own legal or
compliance reference to the actual government decree where that matters
(e.g. legal filings, tax jurisdiction determinations).

This caveat, the license, and the source repository URL are also
recorded as trusted code constants in
`src/modules/idn-admin-regions/domain/source-provenance.ts` — every
document or UI surface in this epic that displays this dataset must
carry this same caveat (see the epic skill,
`.claude/skills/awcms-mini-idn-admin-regions/SKILL.md`, §Sumber dan
lisensi).

## No personal data

This dataset contains only administrative region codes, names, and
aggregate area/population figures per region — it contains no
individual-level personal data.
