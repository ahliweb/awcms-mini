---
"awcms-mini": patch
---

Selaraskan kontrak OpenAPI PATCH `organization_structure` dan `reference-data`
value-sets dengan semantik partial-PATCH yang benar (Issue #837, epic #818).
Runtime sudah diperbaiki di PR #852 (absent = pertahankan, `null` = kosongkan),
tetapi skema OpenAPI masih "berbohong": PATCH legal-entities/locations memakai
ulang skema Create (`required: [name]`), PATCH unit-types/units/value-sets masih
`required: [name]` — semuanya melegitimasi reset yang justru dihapus di runtime.

Perubahan: PATCH kini memakai skema Update khusus yang all-optional
(`OrganizationStructureUpdateLegalEntityRequest`,
`OrganizationStructureUpdateUnitTypeRequest`,
`OrganizationStructureUpdateLocationRequest`), `OrganizationStructureUpdateUnitRequest`
dan `ReferenceDataUpdateValueSetRequest` tak lagi `required: [name]`. Skema Create
tetap menuntut `name` (memang wajib saat pembuatan). `name`/`effectiveFrom` tetap
non-nullable pada PATCH karena runtime menolak `null` (NOT NULL) dengan 400.
