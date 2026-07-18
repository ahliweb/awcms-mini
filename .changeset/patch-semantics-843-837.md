---
"awcms-mini": patch
---

Perbaiki semantik PATCH reference-data & organization-structure (Issue #843 &
#837, epic #818).

**#843** — Keputusan no-op `PATCH {}` untuk reference code (global & tenant)
kini hidup DI DALAM `updateReferenceCode`/`updateTenantReferenceCode`, bukan di
short-circuit call site. Helper menerima patch mentah (`ReferenceCodePatchInput`)
lalu memutuskan refusal (`managed_by_descriptor` / deprecated), no-op, dan merge
di satu tempat — sehingga jawaban endpoint tak lagi bergantung pada berapa field
yang kebetulan dikirim. Menambah test paritas untuk sumbu `managed_by_descriptor`
yang sebelumnya nol coverage.

**#837** — PATCH parsial pada `organization-structure` (units, legal-entities,
locations, unit-types) dan `reference-data/value-sets/{key}` tidak lagi mereset
field yang dihilangkan. Semantik benar: **absent = pertahankan**, **`null` =
kosongkan** field nullable, `null` pada field `NOT NULL` (name/effectiveFrom) =
400. Sebelumnya PATCH satu field diam-diam memotong riwayat effective-dating
(`effectiveFrom` → now, `effectiveTo` → null) dan menghapus name/description.
Menambah helper parse/merge reusable di `_shared/partial-patch.ts` plus test
partial-PATCH (sebelumnya nol coverage untuk PATCH organization-structure).
