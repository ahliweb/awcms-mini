---
"awcms-mini": patch
---

Tambahkan gate validasi response-vs-schema OpenAPI (Issue #844, epic #818).

Sebelumnya tidak ada apa pun di repo yang membandingkan body response nyata
(atau data pembentuk response) terhadap kontrak OpenAPI yang dipublikasikan —
`api:spec:check`/`api:docs:check` hanya menjaga konsistensi antar artefak
(bundle segar relatif sumber), bukan kesetiaan kontrak terhadap kode. Akibatnya
endpoint yang body-nya diturunkan dari struktur TypeScript hand-maintained bisa
melanggar kontraknya sendiri secara senyap — persis yang terjadi pada
`sensitiveFields.naturalKeyField` (Issue #820, tertangkap manual di review PR
\#839).

**Mekanisme.** `scripts/lib/openapi-response-validator.ts`: validator subset
JSON-Schema tanpa dependency baru (Bun-only, AGENTS.md rule 14; `ajv` ditolak
karena memaksa permukaan Node dan membaca `allOf`+`additionalProperties: false`
secara ketat per-branch, padahal envelope `ApiSuccess` di kontrak ini memakai
pembacaan MERGE). Mendukung `$ref`, `allOf` (merge), `oneOf`/`anyOf`, `type`,
`enum`, `const`, `required`, `additionalProperties: false`, `properties`,
`items`, `nullable`. Memvalidasi objek nyata terhadap schema ter-parse — bukan
grep teks sumber.

**Gate.** `tests/unit/response-contract-validation.test.ts` memvalidasi response
nyata `GET /api/v1/data-exchange/descriptors` (envelope + descriptor registry
verbatim) terhadap bundle terpublikasi `awcms-mini-public-api.openapi.yaml`.
Harness data-driven — menambah endpoint = satu entri. Melebur test parity sempit
`data-exchange-descriptor-contract-parity.test.ts` (assertion naturalKeyField &
load-bearing dipertahankan).

Drift `data_exchange` yang jadi bukti issue **sudah** diperbaiki PR #839; gate
ini membuktikannya tetap benar dan menutup kelas cacat "gate hijau di atas
drift response nyata" secara umum untuk endpoint registry/descriptor.
