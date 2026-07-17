---
name: awcms-mini-organization-structure
description: Kerjakan bagian mana pun dari modul organization_structure AWCMS-Mini (Issue #749, epic platform-evolution #738 Wave 2, ADR-0016; wiring #786, refactor #802). Gunakan saat menambah/mengubah endpoint di src/modules/organization-structure, saat menyentuh hierarki unit effective-dated/reparent, saat mengonsumsi BusinessScopeHierarchyPort, atau saat menambah legal entity/lokasi/assignment. Merangkum invariant SCD Type 2, guard konkurensi reparent, dan batas tenant-vs-legal-entity yang tidak boleh dikaburkan.
---

# AWCMS-Mini — Organization Structure Module

`organization_structure` (`src/modules/organization-structure`, Issue #749, epic
`platform-evolution` #738 Wave 2, admission decision
`docs/adr/0016-organization-structure-module-admission.md`) adalah **Official
Optional Business Foundation** (ADR-0013 §2/§4) — fondasi struktur organisasi
tenant-scoped, opt-in per tenant, generik untuk setiap aplikasi turunan, **tidak
pernah** implementasi ERP.

Baca `src/modules/organization-structure/README.md` untuk peta tabel/endpoint.
Skill ini merangkum yang **tidak jelas dari membaca satu file**: kosakata
tenant/legal entity/organization unit (sering disalahpahami), invariant
effective-dating, dan guard konkurensi reparent.

## Kapan pakai skill ini vs skill generik

Melengkapi (bukan menggantikan) `awcms-mini-new-endpoint`,
`awcms-mini-new-migration`, `awcms-mini-abac-guard`, `awcms-mini-idempotency`.
Pakai skill ini untuk konteks domainnya: apa yang boleh/tidak boleh dimodelkan
di sini, dan bagaimana hierarki di-resolve.

## CRITICAL — batas kosakata (ADR-0013 §2/§4)

Ini bagian yang paling sering salah dipahami, dan salahnya mahal:

- **Legal entity / organization unit BUKAN tenant.** Keduanya adalah
  pengelompokan bisnis/akuntansi **DI DALAM SATU tenant**, dan **tidak pernah**
  jadi batas RLS. Predikat RLS setiap tabel di modul ini selalu dan hanya
  `tenant_id`. Jangan pernah tergoda memakai `legal_entity_id`/
  `organization_unit_id` sebagai predikat isolasi — itu mengubah model keamanan
  repo ini.
- **Bukan ERP** — tidak ada chart of accounts, valuasi stok inventory/warehouse,
  HR, payroll, pajak, atau aturan organisasi spesifik-pemerintah.
- **Bukan registry orang/party kedua** (ADR-0013 §4) — assignment
  mereferensikan `awcms_mini_tenant_users` lewat FK biasa; identitas orang tetap
  milik `identity_access`/`profile_identity`.
- **Bukan tenant provisioning/subscription management** — itu wilayah SaaS
  Control Plane (ADR-0013 §1/§3), di luar scope base sepenuhnya.

Identifier registrasi legal entity **generik dan opaque**:
`registration_identifier` + `registration_identifier_label` — **tidak pernah**
kolom spesifik-pemerintah seperti NPWP/SIUP. Aplikasi turunan yang butuh NPWP
memberi label-nya sendiri, base tidak tahu.

## Tabel

- `awcms_mini_legal_entities` — entitas legal/bisnis tenant-scoped (mis. satu
  PT/CV), status, effective date, hanya soft-delete/deactivate.
- `awcms_mini_organization_unit_types` — kosakata typed yang bisa dikonfigurasi
  tenant. Seed contoh (`domain/organization-unit-type.ts`'s
  `DEFAULT_UNIT_TYPE_SEEDS`, **tidak pernah di-insert otomatis**):
  `department`, `branch`, `cost_center`, `warehouse`, `program_unit`.
- `awcms_mini_organization_units` — effective-dated, **opsional** terkait legal
  entity (tidak pernah wajib — unit langsung di bawah tenant eksplisit
  diizinkan) dan opsional typed.
- `awcms_mini_organization_unit_hierarchies` — edge parent-child versioned/
  effective-dated (gaya SCD Type 2). Lihat §Reparent.
- `awcms_mini_operational_locations` — field alamat opsional, lat/lng opsional
  yang divalidasi ke `[-90,90]`/`[-180,180]`.
- `awcms_mini_location_unit_relationships` — join many-to-many eksplisit, sendiri
  effective-dated.
- `awcms_mini_organization_unit_assignments` — assignment effective-dated user
  tenant `identity_access` ke sebuah unit, dengan `position_label` string biasa
  yang opsional (eksplisit BUKAN hierarki HR/payroll).

## CRITICAL — reparent tidak pernah mutasi kolom parent in-place

Reparent **tidak pernah** memutasi kolom `parent_organization_unit_id`. Ia
menutup edge terbuka saat ini (`effective_to = now()`) dan membuka edge baru.
Riwayat hierarki adalah data, bukan efek samping — jangan "sederhanakan" jadi
kolom parent tunggal.

`application/organization-unit-hierarchy-service.ts`'s `reparentUnit` adalah
**SATU-SATUNYA jalur tulis** terhadap tabel hierarki. Validasi no-cycle/
self-parent berjalan transaksional di dalamnya, dijaga:

1. `pg_advisory_xact_lock` **tenant-wide** — menutup race concurrent-reparent
   lintas-baris (dua reparent berbeda yang masing-masing valid sendiri bisa
   membentuk cycle bersama; lock per-baris saja tidak cukup untuk itu), dan
2. `SELECT ... FOR UPDATE` pada baris edge terbuka milik unit itu sendiri.

**Jangan** ganti advisory lock dengan optimistic locking "demi performa" —
serialisasi pesimistik di sini disengaja; kehilangan satu update di sini berarti
cycle hierarki, bukan sekadar stale read.

Endpoint reparent wajib `Idempotency-Key` dan diaudit `critical`.

## Capability port: `BusinessScopeHierarchyPort`

Modul ini menyediakan adapter NYATA
(`application/organization-structure-hierarchy-port-adapter.ts`,
`organizationStructureHierarchyPortAdapter`) yang mengimplementasikan
`_shared/ports/business-scope-hierarchy-port.ts` untuk `scopeType`
`"legal_entity"` dan `"organization_unit"` — read-only, tenant-scoped,
menghormati RLS, menelusuri hierarki effective-dated nyata "as of now".

Ia **tidak menggantikan** adapter flat default milik `identity-access`
(`defaultBusinessScopeHierarchyPortAdapter`, yang hanya menangani `"office"`) —
keduanya hidup berdampingan. `identity_access` **tidak punya** dependency
lifecycle maupun capability ke `organization_structure` di arah mana pun (Core
tidak pernah bergantung pada Optional, ADR-0013 §1).

**Tersambung end-to-end sejak Issue #786** — modul ini mengapalkan adapter di
#749 tapi punya NOL pemanggil produksi sampai follow-up itu. Composition root
nyatanya adalah `buildBusinessScopeHierarchyPort`
(`src/pages/api/v1/identity/business-scope/hierarchy-port-composition.ts` —
difaktorkan keluar dari `assignments/index.ts` oleh Issue #802/PR #804 supaya
`assignments/[id]/revoke.ts` bisa memakai komposisi yang sama persis alih-alih
menduplikasinya). Ia mengecek apakah `organization_structure` enabled untuk
tenant si caller (`resolveModuleEnabled`) dan, bila ya, mencoba adapter nyata
modul ini LEBIH DULU untuk setiap scope, jatuh ke adapter flat `"office"` milik
identity-access bila yang ini tidak me-resolve scope-nya (scope type yang bukan
miliknya, atau SEMUA scope type saat tenant men-disable modul ini).

**Tidak ada file di dalam pohon `application`/`domain` milik `identity_access`
yang mengimpor apa pun dari `organization_structure`** — wiring-nya hidup
sepenuhnya di file composition-root bersama itu, di luar pohon
`application`/`domain` setiap modul. Inilah yang menjaga
`tests/unit/module-boundary-cycles.test.ts` (guard cycle Core/Optional) tetap
lolos. Kalau menambah pemanggil baru, letakkan wiring-nya di composition root
yang sama — jangan impor adapter dari dalam modul lain.

`capabilities: { provides: ["organization_hierarchy_resolution"] }` di
`module.ts` dipasangkan dengan entri `capabilities.consumes` (`optional: true`)
di `identity_access/module.ts` untuk validator komposisi modul (Issue #740) —
itu deklarasi dokumentasi/validasi build-time, **bukan** wiring runtime-nya.

`"location"` (lookup lokasi fisik) **sengaja tidak** diekspos lewat port ini —
port ini soal resolusi hierarki/otorisasi business-scope, bukan lookup lokasi
fisik (ADR-0016 §10).

## Events

Producer NYATA `domain_event_runtime` (pola sama `workflow_approval`, #747) —
setiap write di `application/*.ts` memanggil `appendDomainEvent` **di transaksi
yang sama** dengan perubahan state:

- `awcms-mini.organization-structure.legal-entity.{created,updated,deactivated}`
- `awcms-mini.organization-structure.unit.{created,updated,deactivated}`
- `awcms-mini.organization-structure.hierarchy.changed`
- `awcms-mini.organization-structure.assignment.{created,ended}`

## Metrics

`bun run organization-structure:metrics-snapshot` (read-only, aman di setiap
profil deployment) menyampel per tenant aktif:

- `organization_structure_active_units_total` (gauge)
- `organization_structure_hierarchy_max_depth` (gauge)
- `organization_structure_assignments_expiring_total` (gauge — window
  expiring-soon, default 30 hari, `DEFAULT_EXPIRING_SOON_WINDOW_DAYS`; **metrik
  saja, tidak ada aksi auto-expiry**)

`organization_structure_hierarchy_invalid_attempts_total` (counter, by `reason`:
`self_parent`/`cycle`/`invalid_period`/`max_depth_exceeded`) dinaikkan inline
oleh `organization-unit-hierarchy-service.ts` pada SETIAP penolakan validator,
bukan disampel job snapshot.

## API

`basePath: /api/v1/organization-structure` — CRUD/list/search tenant-safe untuk
legal entity, unit type, unit, lokasi, relasi lokasi-unit, assignment; plus
endpoint tree dan query param as-of untuk hierarki.

## Seed/import

Hook import seed dirancang lewat kontrak `data_exchange` (#750/#752) —
**sengaja bukan** hard runtime dependency modul ini (syarat eksplisit #749).
Tidak ada endpoint import di modul ini; endpoint CRUD-nya sendiri cukup untuk
seeding manual/scripted. Kalau menyambungkannya kelak, lakukan lewat
`ExchangeDescriptor` + adapter (lihat `awcms-mini-data-exchange`), bukan dengan
menambahkan `data_exchange` ke `dependencies`.

## Pitfall umum

1. Jangan pakai legal entity/organization unit sebagai batas RLS.
2. Jangan mutasi kolom parent in-place — selalu tutup edge lama, buka edge baru.
3. Jangan tulis tabel hierarki di luar `reparentUnit`.
4. Jangan ganti advisory lock dengan optimistic locking.
5. Jangan impor adapter modul ini dari pohon `application`/`domain` modul lain —
   wiring hanya di composition root.
6. Jangan tambahkan field spesifik-pemerintah (NPWP/SIUP) ke legal entity.
7. Jangan ekspos `"location"` lewat `BusinessScopeHierarchyPort`.

## Verifikasi

`tests/unit/organization-structure-{domain,hierarchy}.test.ts`,
`tests/integration/organization-structure.integration.test.ts`, dan
`tests/integration/business-scope-organization-structure-wiring.integration.test.ts`
(wiring #786). Jalankan `bun test` dengan `DATABASE_URL` — tanpa itu seluruh
test integration dilewati diam-diam.
