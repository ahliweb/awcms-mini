# Bagian 21 — Module Admission, Lifecycle, dan Registry Governance

> **Status:** Accepted (kebijakan mengikat, lihat `docs/adr/0012-module-admission-and-trusted-registry-boundary.md`).
> **Terkait:** Issue #696 (epic #679 platform-hardening), Issue #510 (epic Module Management), ADR-0001, ADR-0002, ADR-0008, ADR-0011.
> **Lihat juga:** `docs/adr/0013-extension-layers-and-boundary-model.md` (Issue #739, epic #738 `platform-evolution`) — memperluas lima kategori admission dokumen ini dengan kosakata **lapisan ekstensi** lintas-repo (Core/System Foundation/Official Optional Business Foundation/SaaS Control Plane/ERP Extension/Derived Application), batas tenant vs legal entity vs organization unit, data-ownership matrix, dan kriteria evidence-based ekstraksi layanan. ADR-0013 **tidak mengubah** lima kategori admission atau pohon keputusan §3 di dokumen ini — murni lapisan tambahan di atasnya untuk pertanyaan "repo mana + boundary data apa" ketika banyak repo turunan independen terlibat.
>
> `docs/adr/0014-deterministic-build-time-module-composition.md` (Issue #740) — mekanisme KONKRET yang ADR-0013 §5 sengaja belum desain: bagaimana repo turunan mendaftarkan modul aplikasinya sendiri (`src/modules/application-registry.ts`) lalu digabung dengan registry base ini (`composeModuleRegistry()`) TANPA pernah mengedit `src/modules/index.ts`. ADR-0014 juga tidak mengubah lima kategori admission atau §7 di bawah — ia menegakkan ulang §7 (registry statis, tanpa runtime loading) di level mekanisme baru, bukan melonggarkannya.

## 1. Konteks dan tujuan

Repo ini awalnya dideskripsikan sebagai base generik dengan sedikit modul
domain. Registry sekarang berisi **23 modul terdaftar** (`src/modules/
index.ts`), termasuk tiga modul domain nyata (`blog_content`, `news_portal`,
`social_publishing`) yang didaftarkan langsung di base (pengecualian yang
sudah didokumentasikan di `AGENTS.md` §Peta modul), modul `idn_admin_regions`
yang sudah terdaftar sebagai scaffold eksperimental (`status: "experimental"`,
belum ada schema/API/UI — lihat §8), serta rencana modul Hermes-agent di masa
depan yang belum dimulai. Sebelum modul produk baru masuk ke base, admission
dan ownership rules harus eksplisit — itulah tujuan dokumen ini.

Dokumen ini mendefinisikan:

1. Lima kategori modul dan pohon keputusan admission.
2. Kriteria admission, status lifecycle, aturan dependency, security review,
   ownership, dan kebijakan deprecation/removal per kategori.
3. Ekspektasi kompatibilitas offline/LAN vs full-online-only.
4. Kebijakan trusted static registry dan larangan eksplisit terhadap
   runtime code upload/install/marketplace.
5. Proposal template ringan + architecture decision checklist
   (`docs/awcms-mini/templates/`).
6. Pemetaan 23 modul saat ini ke kategori + remediasi yang terdeteksi.

**Yang TIDAK berubah oleh dokumen ini** (guardrail keras epic #679, tidak
dilonggarkan): registry tetap **statis, tepercaya, hanya lewat kode yang
di-review lewat PR normal** — lihat §7. Tidak ada infrastruktur marketplace
atau runtime install baru yang dibangun oleh dokumen ini.

## 2. Lima kategori modul

| Kategori                         | Definisi                                                                                                                                                                                                                                                                                                                                         | Siapa yang memelihara                                    | Bisa dinonaktifkan per tenant?                                                                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Core**                         | Fondasi wajib: tanpanya platform tidak bisa boot/berfungsi untuk deployment mana pun. Selalu aktif di semua profil deployment.                                                                                                                                                                                                                   | Maintainer base (`@ahliweb`, lihat `.github/CODEOWNERS`) | Tidak — tidak pernah `disabled` secara global; per-tenant enable/disable (`awcms_mini_tenant_modules`) tidak berlaku bermakna karena modul lain bergantung padanya secara transitif.                                             |
| **System**                       | Kapabilitas platform lintas-modul (observability, sync/offline infra, email generik, reporting generik, workflow generik, routing tenant publik, telemetry, module management itu sendiri). Bersifat infrastruktur/reusable, bukan fitur produk end-user yang berdiri sendiri. Bisa off secara default (feature flag) tanpa menghentikan Core.   | Maintainer base                                          | Sebagian besar ya, lewat `*_ENABLED` env flag (default off, ADR-0006) — bukan status modul, karena modul-modul ini sendiri harus tetap terdaftar (statusnya `active`) supaya `bun run db:migrate`/registry sync tetap konsisten. |
| **Official Optional Module**     | Fitur produk yang dipelihara resmi oleh tim base, opt-in per tenant, bernilai bisnis langsung (bukan sekadar infrastruktur). Contoh saat ini: `blog_content`, `news_portal`.                                                                                                                                                                     | Maintainer base                                          | Ya — `awcms_mini_tenant_modules` per tenant.                                                                                                                                                                                     |
| **Derived Application (domain)** | Modul domain spesifik aplikasi turunan (POS, gudang, pajak, CRM, dll.) — **tidak pernah** hidup di repo base ini. Hidup di repo/branch aplikasi turunan (mis. AWPOS) di atas base ini.                                                                                                                                                           | Tim aplikasi turunan masing-masing                       | N/A — di luar registry base sepenuhnya.                                                                                                                                                                                          |
| **External Integration**         | Adapter provider eksternal (Mailketing, Cloudflare R2, Cloudflare DNS, Google/generic OIDC, dsb.) — **bukan** modul top-level terpisah hari ini, melainkan sub-komponen di dalam modul System/Official Optional yang memilikinya (`email` → Mailketing, `sync_storage` → R2, `tenant_domain` → Cloudflare DNS, `identity_access` → Google/OIDC). | Modul pemilik kapabilitas                                | Ya — selalu opt-in via `*_ENABLED`, default off.                                                                                                                                                                                 |

Field `ModuleType` (`src/modules/_shared/module-contract.ts`) sudah punya
lima nilai — `"base" | "system" | "domain" | "integration" | "derived"` —
yang dipetakan ke kategori di atas sebagai berikut: `base`→Core,
`system`→System, `domain`→Official Optional Module, `integration`→External
Integration (jika suatu hari perlu jadi modul top-level tersendiri, bukan
sub-komponen), `derived`→Derived Application (nilai ini tidak pernah dipakai
oleh modul di repo base ini — hanya relevan bila suatu hari repo aplikasi
turunan mem-vendor tipe yang sama). Lihat §8 untuk gap saat ini antara nilai
`type` yang benar-benar di-set di kode vs kategori final dokumen ini.

## 3. Pohon keputusan admission

Gunakan pohon ini untuk memutuskan **di repo mana** dan **kategori apa**
sebuah kemampuan baru harus masuk, sebelum menulis kode apa pun.

```mermaid
flowchart TD
  Q0[Kemampuan baru diusulkan] --> Q5{Apakah proposal ini melibatkan\nruntime code upload/install/\nmarketplace/eval dari input\ntenant atau pihak ketiga?}
  Q5 -- Ya --> Reject[DITOLAK secara eksplisit.\nLihat §7 — tidak ada pengecualian\ntanpa ADR baru yang mensupersede\nADR-0001/ADR-0002]
  Q5 -- Tidak --> Q1{Apakah platform base\ntidak bisa boot/berfungsi\nuntuk deployment mana pun\ntanpanya?}
  Q1 -- Ya --> Core[Kategori: Core\nButuh ADR + 2 maintainer approval]
  Q1 -- Tidak --> Q2{Apakah ini kapabilitas\ninfrastruktur/reusable lintas-modul\n(bukan fitur produk berdiri sendiri)?}
  Q2 -- Ya --> Sys[Kategori: System\nOff-by-default via *_ENABLED bila\nmelibatkan provider eksternal]
  Q2 -- Tidak --> Q3{Apakah ini fitur produk\nyang generik untuk SEMUA\naplikasi turunan\n(bukan spesifik satu domain bisnis)?}
  Q3 -- Tidak --> Derived[BUKAN untuk repo base ini.\nBuat di repo aplikasi turunan.\nLihat derived-application-guide.md]
  Q3 -- Ya --> Q4{Apakah ini adapter untuk\nsatu provider eksternal spesifik\n(bukan modul mandiri)?}
  Q4 -- Ya --> Ext[Kategori: External Integration\nHidup DI DALAM modul pemilik\nkapabilitas — lihat §6]
  Q4 -- Tidak --> Q6{Sudah lolos proposal template\n+ ADR checklist (§9),\ndisetujui maintainer?}
  Q6 -- Belum --> Propose[Isi docs/awcms-mini/templates/\nmodule-proposal-template.md,\nbuka issue, tunggu keputusan]
  Q6 -- Ya --> Opt[Kategori: Official Optional Module\nScaffold via skill awcms-mini-new-module]
```

`Q5` sengaja ditempatkan **sebelum** `Q1` (bukan hanya di satu cabang) —
setiap kategori (Core/System/Derived/External Integration/Official
Optional Module) melewati gate ini terlebih dahulu, tanpa jalur pintas
mana pun. Ini konsisten dengan klaim §7 poin 5 bahwa proposal semacam
ini "ditolak di tahap pohon keputusan §3 (node Q5), tanpa pengecualian"
— sebelumnya node `Q5` hanya berada di satu cabang (jalur Official
Optional Module), sehingga kandidat yang lolos lewat `Q4 -- Ya`
(External Integration) tidak pernah benar-benar melewatinya. Diperbaiki
sebagai temuan Medium dari review PR #714.

Ringkasan tekstual (bila mermaid tidak dirender):

1. **Melibatkan runtime code upload/install/marketplace/eval dari input
   tenant/pihak ketiga apa pun?** → **Ditolak eksplisit**, tanpa
   pengecualian (§7) — gate ini berlaku untuk SEMUA kategori di bawah,
   bukan hanya Official Optional Module.
2. **Wajib untuk boot di semua profil deployment?** → **Core**.
3. **Bukan Core, tapi infrastruktur reusable lintas-modul (bukan fitur
   produk berdiri sendiri)?** → **System**.
4. **Bukan infrastruktur, tapi juga bukan fitur generik untuk semua
   aplikasi turunan (spesifik satu domain bisnis: POS, gudang, pajak,
   CRM, dst.)?** → **bukan untuk repo ini**, arahkan ke aplikasi turunan.
5. **Fitur generik untuk semua aplikasi turunan** (bukan spesifik satu
   domain), tapi hanya berupa adapter satu provider eksternal? →
   **External Integration** di dalam modul pemilik kapabilitas.
6. Sisanya (fitur produk generik, opt-in, bukan infrastruktur murni) →
   **Official Optional Module**, lewat proposal template + ADR checklist
   (§9) sebelum scaffold.

## 4. Kriteria admission per kategori

### 4.1 Core

- Harus punya ADR yang menjelaskan mengapa platform tidak bisa berfungsi
  tanpanya (analog ADR-0001 s.d. ADR-0004).
- Disetujui minimal dua maintainer bila tersedia (GOVERNANCE.md §Perubahan
  standar).
- Tidak boleh punya dependency ke modul System/Official Optional
  Module/External Integration manapun (arah dependency selalu dari
  System/Optional → Core, tidak pernah sebaliknya) — dijaga otomatis oleh
  `validateModuleDependencyGraph` (`src/modules/module-management/domain/
module-dependency-graph.ts`, Issue #680/#681).
- Tidak boleh memanggil provider eksternal apa pun secara langsung di jalur
  kritikal (harus tetap berfungsi 100% offline/LAN).

### 4.2 System

- Boleh punya dependency ke Core, tidak boleh ke Official Optional Module
  atau modul System lain yang menciptakan cycle (dicek otomatis oleh
  validator dependency graph yang sama).
- Bila membungkus provider eksternal (email, sync/R2, DNS): wajib
  off-by-default (`*_ENABLED=false`), wajib lolos checklist §6.
- Wajib punya `jobs`/`health` descriptor bila mengoperasikan proses
  terjadwal (pola `ModuleJobDescriptor`/`ModuleHealthContract` yang sudah
  ada).

### 4.3 Official Optional Module

- Harus generik untuk **semua** aplikasi turunan potensial, bukan spesifik
  satu domain bisnis (lihat pohon keputusan §3, node Q3). Blog dan news
  portal lolos kriteria ini karena konten editorial adalah kebutuhan lintas
  domain (retail, layanan publik, media internal, dst.), bukan spesifik
  satu vertikal.
- Wajib bisa dinonaktifkan per tenant tanpa merusak Core/System manapun
  (`awcms_mini_tenant_modules`, dicek oleh `hasDependencyCycle` +
  lifecycle validator yang sama).
- Wajib melalui proposal template + ADR checklist (§9) sebelum scaffold
  kode dimulai.
- Wajib mendeklarasikan `type: "domain"` di `module.ts`-nya sendiri.

### 4.4 Derived Application (domain)

- **Tidak pernah** diajukan sebagai PR ke repo base ini. Lihat
  `derived-application-guide.md` dan `derived-app-pilot-plan.md`.
- Bila sebuah modul domain turunan terbukti benar-benar generik lintas
  banyak aplikasi turunan sehingga layak naik jadi Official Optional
  Module base, itu **keputusan maintainer eksplisit** lewat proses §9 —
  tidak otomatis, tidak dilakukan oleh tim aplikasi turunan sendiri.

### 4.5 External Integration

- Selalu hidup di dalam modul System/Official Optional Module pemilik
  kapabilitas — tidak pernah jadi entri top-level baru di
  `src/modules/index.ts` kecuali sebuah proposal eksplisit mengubah ini
  (butuh ADR baru).
- Wajib lolos checklist §6 secara penuh sebelum merge.

## 5. Dependency rules — required vs optional

Ada **dua graf independen** yang sudah ada di kode, dokumen ini hanya
menamai kapan masing-masing "required" vs "optional" secara eksplisit
(tidak menambah mekanisme baru):

1. **Lifecycle dependency** (`ModuleDescriptor.dependencies: string[]`,
   `domain/tenant-module-lifecycle.ts`) — urutan enable/disable per tenant.
   Sebuah entri di sini **selalu diperlakukan sebagai required**: modul
   pemilik tidak boleh diaktifkan sebelum semua dependency-nya aktif, dan
   tidak boleh dinonaktifkan selama ada modul lain yang masih bergantung
   padanya. Tidak ada konsep "optional lifecycle dependency" — bila sebuah
   hubungan boleh hilang tanpa merusak fungsi, itu bukan lifecycle
   dependency, itu capability dependency (poin 2).
2. **Capability dependency** (`ModuleDescriptor.capabilities.consumes`,
   ADR-0011, Issue #681) — hubungan level-source lewat port/adapter,
   terpisah dari urutan enable/disable. Setiap entri wajib menyatakan
   `optional: true` atau tidak:
   - **Required capability** (`optional` tidak diset/`false`): fitur
     pemanggil tidak bermakna sama sekali tanpa kapabilitas ini — jarang
     dipakai hari ini karena kebanyakan hubungan lintas-modul di base ini
     didesain untuk degradasi anggun.
   - **Optional capability** (`optional: true`): fitur pemanggil
     terdegradasi dengan aman (didokumentasikan per call site) ketika
     kapabilitas "tidak berlaku" untuk tenant/request tertentu — contoh
     nyata: `blog_content` ↔ `news_portal` (Issue #632/#681), keduanya
     sengaja TIDAK saling mendaftar sebagai lifecycle `dependencies` justru
     karena hubungannya optional secara produk.

**Aturan admission**: modul baru kategori System/Official Optional Module
yang mengonsumsi kapabilitas modul lain WAJIB mengklasifikasikan setiap
`consumes` entry sebagai required/optional secara eksplisit di
`module.ts`-nya, dan mendokumentasikan di README modul apa yang terjadi
saat kapabilitas itu tidak tersedia (tenant belum enable modul penyedia,
atau provider eksternal off).

## 6. Kompatibilitas offline/LAN vs full-online-only

AWCMS-Mini defaultnya **offline-first/LAN-first** (ADR-0006) — perilaku
full-online-provider harus selalu **explicit opt-in**, tidak pernah
default. Ini sudah ditegakkan secara mekanis oleh `src/lib/config/
registry.ts`'s field `profiles` (Issue #689): setiap variabel konfigurasi
menyatakan profil deployment mana yang relevan.

| Kelas kompatibilitas                                                         | Definisi                                                                                                                                              | Enforcement mekanis yang sudah ada                                                                                                                                                         | Contoh                                                                                                                                                                         |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **offline-lan-safe** (wajib untuk Core, direkomendasikan untuk System)       | Modul/fitur berfungsi penuh dengan semua provider eksternal off, tanpa koneksi internet.                                                              | `profiles: ALL_PROFILES` di `CONFIG_REGISTRY`; default value setiap `*_ENABLED` flag adalah `false`/off.                                                                                   | `tenant_admin`, `identity_access`, `profile_identity`, `logging`, `sync_storage` (mode lokal), `form_drafts`, `workflow`, `blog_content` (varian `/blog/{tenantCode}` legacy). |
| **full-online-only** (hanya boleh untuk System/External Integration, opt-in) | Fitur hanya bermakna saat `staging`/`production` dengan konektivitas internet — TIDAK BOLEH memblokir/mendegradasi deployment offline-lan ketika off. | `profiles: ONLINE_PROFILES` di `CONFIG_REGISTRY`; validator config (`checkXxxConfig` di `scripts/validate-env.ts`) menolak boot bila flag `*_ENABLED=true` tapi kredensial terkait kosong. | Google/SSO login, Turnstile, Cloudflare DNS adapter, R2 news media (`news_portal`'s `full_online_r2` preset), geolocation enrichment (`visitor_analytics`).                    |

**Kriteria admission wajib**: proposal modul baru harus menyatakan kelas
kompatibilitas di atas untuk setiap kapabilitas yang diusulkan, dan bila
`full-online-only`, harus membuktikan (di proposal atau PR) bahwa profil
`offline-lan` tetap 100% fungsional dengan flag tersebut `false` (test
regresi, bukan klaim naratif).

## 7. Trusted static registry policy — larangan eksplisit

Ini adalah **guardrail keras yang tidak dilonggarkan** oleh dokumen ini
(sudah ditetapkan sejak ADR-0001/ADR-0002, dipertegas di sini secara
eksplisit sesuai permintaan Issue #696):

1. `src/modules/index.ts` adalah **satu-satunya** registry modul. Setiap
   entrinya adalah kode TypeScript yang di-compile ke binary monolith yang
   sama, direview lewat proses PR normal (CODEOWNERS, CI, `bun run check`),
   dan di-deploy sebagai satu artefak — **tidak pernah** dimuat secara
   dinamis dari file/URL/paket yang disuplai tenant saat runtime.
2. `awcms_mini_tenant_modules` (DB, Issue #512/#515) **hanya** menyimpan
   status enable/disable boolean untuk modul yang KODENYA SUDAH ADA di
   binary yang sedang berjalan. Mengaktifkan sebuah baris tidak pernah
   mengambil/mengeksekusi kode baru — hanya mengubah cabang runtime yang
   sudah dikompilasi.
3. **Dilarang eksplisit, tanpa pengecualian** di base ini: marketplace
   modul, upload plugin/tema/skrip dari tenant, dynamic `import()` dari
   path/URL yang berasal dari input tenant/user, `eval`/`new Function()`
   yang mengeksekusi teks dari luar kode yang di-commit, atau mekanisme
   apa pun yang memungkinkan kode pihak ketiga tereksekusi di proses
   aplikasi tanpa melalui review PR + CI penuh.
4. Satu-satunya jalan sebuah kemampuan baru masuk adalah proses admission
   di dokumen ini (§3-§4) yang berujung pada PR normal ke repo ini (untuk
   Core/System/Official Optional Module) atau ke repo aplikasi turunan
   (untuk Derived Application) — tidak pernah lewat jalur runtime.
5. Bila suatu hari ada kebutuhan bisnis nyata yang tampak membutuhkan
   pelonggaran ini (mis. "tenant ingin upload skrip kustom sendiri"),
   proposal itu **wajib** melalui ADR baru yang secara eksplisit
   mensupersede ADR-0001 (modular monolith) dan/atau ADR-0002 (Bun-only
   runtime tanpa sandbox eksekusi kode asing) — bar yang sangat tinggi,
   dan sampai ADR itu ada serta di-Accept oleh maintainer, proposal
   semacam ini **ditolak di tahap pohon keputusan §3** (node Q5), tanpa
   pengecualian implementasi apa pun.

## 8. Peta 25 modul saat ini → kategori

Sumber kebenaran: `src/modules/index.ts` (25 entri) dan setiap `module.ts`-
nya. Kolom **Owner** mengikuti `.github/CODEOWNERS` (satu maintainer,
`@ahliweb`, untuk seluruh repo hari ini) karena field opsional
`ModuleDescriptor.maintainers` belum diisi di modul manapun — lihat
remediasi R3 di bawah.

| Modul (`key`)             | Kategori (dokumen ini)   | `type` di kode saat ini | `isCore` di kode | Status lifecycle | Owner    |
| ------------------------- | ------------------------ | ----------------------- | ---------------- | ---------------- | -------- |
| `tenant_admin`            | Core                     | _(tidak diset)_         | _(tidak diset)_  | `active`         | @ahliweb |
| `identity_access`         | Core                     | _(tidak diset)_         | _(tidak diset)_  | `active`         | @ahliweb |
| `profile_identity`        | Core                     | _(tidak diset)_         | _(tidak diset)_  | `active`         | @ahliweb |
| `module_management`       | System                   | `system`                | `true`           | `active`         | @ahliweb |
| `logging`                 | System                   | _(tidak diset)_         | _(tidak diset)_  | `active`         | @ahliweb |
| `sync_storage`            | System                   | _(tidak diset)_         | _(tidak diset)_  | `active`         | @ahliweb |
| `email`                   | System                   | _(tidak diset)_         | _(tidak diset)_  | `active`         | @ahliweb |
| `form_drafts`             | System                   | _(tidak diset)_         | _(tidak diset)_  | `active`         | @ahliweb |
| `tenant_domain`           | System                   | `system`                | _(tidak diset)_  | `active`         | @ahliweb |
| `visitor_analytics`       | System                   | `system`                | _(tidak diset)_  | `active`         | @ahliweb |
| `reporting`               | System                   | _(tidak diset)_         | _(tidak diset)_  | `active`         | @ahliweb |
| `workflow`                | System                   | _(tidak diset)_         | _(tidak diset)_  | `active`         | @ahliweb |
| `data_lifecycle`          | System                   | `system`                | _(tidak diset)_  | `active`         | @ahliweb |
| `domain_event_runtime`    | System                   | `system`                | _(tidak diset)_  | `active`         | @ahliweb |
| `blog_content`            | Official Optional Module | `domain`                | _(tidak diset)_  | `active`         | @ahliweb |
| `news_portal`             | Official Optional Module | `domain`                | _(tidak diset)_  | `active`         | @ahliweb |
| `social_publishing`       | Official Optional Module | `domain`                | _(tidak diset)_  | `active`         | @ahliweb |
| `organization_structure`  | Official Optional Module | `domain`                | _(tidak diset)_  | `active`         | @ahliweb |
| `reference_data`          | Official Optional Module | `domain`                | _(tidak diset)_  | `active`         | @ahliweb |
| `service_catalog`         | Official Optional Module | `domain`                | _(tidak diset)_  | `active`         | @ahliweb |
| `tenant_entitlement`      | Official Optional Module | `domain`                | _(tidak diset)_  | `active`         | @ahliweb |
| `document_infrastructure` | Official Optional Module | `domain`                | _(tidak diset)_  | `active`         | @ahliweb |
| `data_exchange`           | Official Optional Module | `domain`                | _(tidak diset)_  | `active`         | @ahliweb |
| `integration_hub`         | System                   | `system`                | _(tidak diset)_  | `active`         | @ahliweb |
| `idn_admin_regions`       | System                   | `base`                  | _(tidak diset)_  | `experimental`   | @ahliweb |

Total: 3 Core + 13 System + 7 Official Optional Module = **23 dari 23 modul
terdaftar** diklasifikasikan di tabel ini, cocok dengan `src/modules/
index.ts` (`data_lifecycle`/`domain_event_runtime`, Issue #745/#742 epic
#738 Wave 1, ditambahkan ke tabel ini sebagai bagian PR Issue #750 — baris
yang sebelumnya hilang dari tabel karena kedua issue itu mengandalkan
pre-klasifikasi ADR-0013 tanpa menulis ADR/update doc 21 §8 terpisah,
lihat ADR-0013 §1 catatan penutup). `idn_admin_regions` (Issue #655, epic
#654) adalah baris terakhir yang menyusul — tabel ini sebelumnya berjudul
"Peta 23 modul" tapi hanya memuat 22 baris, dan mengakui sendiri
ketimpangan itu tanpa menutupnya; ditambahkan oleh Issue #828 dan kini
dijaga tidak berulang oleh `tests/unit/module-doc-reconciliation.test.ts`.
Kategorinya **System** (bukan Official Optional Module) mengikuti alasan
yang sudah tertulis di `module.ts`-nya sendiri: `type: "base"` karena ia
master data reference yang bisa dipakai setiap aplikasi turunan — "closer
in spirit to how `logging`/`reporting` are shared platform building
blocks" — bukan fitur bisnis tenant-facing seperti `blog_content`.
Statusnya masih `experimental` (satu-satunya modul non-`active` di
registry): scaffold + schema (`sql/054`) sudah ada, tapi lookup API (#662)
dan admin UI (#663) belum, dan epic #654 sedang **ditahan**.
`organization_structure` (Issue #749, epic #738
`platform-evolution` Wave 2) ditambahkan lewat admission decision
`docs/adr/0016-organization-structure-module-admission.md` — legal
entity, unit organisasi tipe-tenant-configurable, hierarki
efektif-tanggal, lokasi operasional, dan assignment pihak/unit; tenant
dan legal entity/organization unit tetap konsep berbeda (ADR-0013 §2),
RLS predicate tabelnya selalu dan hanya `tenant_id`. `document_infrastructure`
(Issue #751, epic #738 `platform-evolution` Wave 3) ditambahkan lewat
admission decision `docs/adr/0017-document-infrastructure-module-admission.md`
— registry dokumen generik, versi immutable, klasifikasi/confidentiality,
evidence, generic resource relations (capability port, bukan FK/table
write lintas modul), dan numbering sequence concurrency-safe (reservation/
commit/cancel, atomik lewat `SELECT ... FOR UPDATE`, tidak pernah reuse
nomor).
RLS predicate tabelnya selalu dan hanya `tenant_id`. `data_exchange`
(Issue #752, epic #738 `platform-evolution` Wave 3) ditambahkan lewat
admission decision `docs/adr/0018-data-exchange-module-admission.md` —
mesin generik staged import/export CSV/JSON (staging, validasi, preview/
diff, commit asinkron idempoten, export manifest/checksum, rekonsiliasi)
dikonsumsi modul pemilik lewat capability port (`DataExchangeAdapterPort`)
dan deskriptor statis (`ModuleDescriptor.dataExchange`); modul ini tidak
pernah menulis langsung ke tabel modul lain. `integration_hub` (Issue #754,
epic #738 `platform-evolution` Wave 3) ditambahkan lewat admission decision
`docs/adr/0019-integration-hub-module-admission.md` — signed inbound
webhook, normalisasi event lewat `domain_event_runtime`, langganan event
outbound, replay protection, dan kesehatan adapter; hub ini hanya memiliki
status pengiriman envelope (ADR-0013 §6), tidak pernah data bisnis final,
dan tidak pernah memanggil API provider bisnis spesifik secara langsung
(mekanisme generik saja — provider-specific adapter tetap dimiliki modul
bisnis pemiliknya). `reference_data` (Issue #750, epic #738
`platform-evolution` Wave 3) ditambahkan lewat admission decision
`docs/adr/0021-reference-data-module-admission.md` —
value set/code efektif-tanggal, terlokalisasi, dengan provenance,
deprecation/supersession, precedence baseline-global vs tenant-override,
import tervalidasi, dan module-contributed catalogs; baseline global
(value set/code/translation/import batch) sengaja TIDAK RLS (reviewed
RLS-exempt, sama seperti `awcms_mini_permissions`/`awcms_mini_modules`/
`awcms_mini_idn_admin_regions` — lihat §Peta 23 modul di atas dan
ADR-0021 §8), sedangkan tabel tenant-override RLS predicate-nya selalu
dan hanya `tenant_id`. `idn_admin_regions` tetap modul-owned dan tidak
direklasifikasi/digabung oleh admission ini (ADR-0021 §4). Tidak ada
modul kategori Derived Application atau External Integration top-level
di registry ini hari ini (sesuai definisi §2 — integration hidup sebagai
sub-komponen, lihat kolom "provider eksternal" di bawah).

**Satu modul terdaftar, `idn_admin_regions`, sengaja tidak dimasukkan ke tabel di
atas.** Descriptor-nya (`src/modules/idn-admin-regions/module.ts`) men-set
`type: "base"`, yang secara literal memetakan ke Core per §2 — tapi
komentarnya sendiri menyebutnya "reusable reference/master data
infrastructure every derived application can depend on", jauh lebih dekat
secara konsep ke kandidat primitif masa depan **`reference_data`**
(Official Optional Business Foundation) daripada ke definisi Core §4.1
("platform tidak bisa boot/berfungsi tanpanya" — jelas tidak berlaku untuk
modul yang masih `status: "experimental"` tanpa schema/API/UI apa pun).
Mengikuti preseden `docs/adr/0013-extension-layers-and-boundary-model.md`
§1: dokumen ini juga **tidak** memutuskan kategori final `idn_admin_regions`
di sini — itu reklasifikasi yang butuh admission decision tersendiri (§9)
— hanya mencatat tumpang tindih konseptual ini secara eksplisit.

**Tujuh modul SaaS Control Plane sudah diadmisi (ADR-0022) tapi belum ada di
tabel di atas.** `service_catalog`, `tenant_entitlement`,
`tenant_provisioning`, `tenant_lifecycle`, `usage_metering`,
`subscription_billing`, dan `payment_gateway` diadmisi sebagai **Official
Optional Business Foundation _in-repo, default-disabled_** lewat admission
decision `docs/adr/0022-saas-control-plane-admission-boundary-and-lifecycle-contracts.md`
(Issue #869, epic #868) — meng-amend klasifikasi placement ADR-0013 §1 yang
sebelumnya menempatkan SaaS Control Plane "di luar repo base". Ketujuhnya
**sengaja belum dimasukkan** ke tabel "Peta 23 modul" di atas karena sumber
kebenaran tabel ini adalah `src/modules/index.ts`, dan `module.ts` masing-
masing baru ditambahkan di Wave-1/2/3 epic #868 (#870–#877) — bukan di
Issue #869 yang docs-only. Setiap modul tetap wajib melalui migration/RLS/
audit/idempotency/skill-coverage sendiri saat kodenya benar-benar mendarat,
dan tabel §8 ini di-update menjadi "Peta 30 modul" pada saat itu. Batas
keras yang mengikat mereka (control-plane ≠ tenant-plane, platform role
bukan BYPASSRLS, secret di luar DB, billing ≠ general ledger, default-
disabled, LAN/offline tetap jalan) ada di ADR-0022 §1–§12.

**Provider eksternal yang dibungkus tiap modul System/Optional** (kategori
External Integration menurut §2, bukan entri registry terpisah):

| Modul pemilik     | Provider eksternal (adapter)                               | Off-by-default?                                                               |
| ----------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `email`           | Mailketing                                                 | Ya (`EMAIL_ENABLED=false`)                                                    |
| `sync_storage`    | Cloudflare R2 (object sync queue)                          | Ya (`R2_ENABLED=false`)                                                       |
| `tenant_domain`   | Cloudflare DNS                                             | Ya (`TENANT_DOMAIN_DNS_PROVIDER=manual` default)                              |
| `news_portal`     | Cloudflare R2 (media, bucket terpisah dari sync)           | Ya (`NEWS_MEDIA_R2_ENABLED=false`)                                            |
| `identity_access` | Google OIDC, generic tenant OIDC SSO, Cloudflare Turnstile | Ya (`AUTH_GOOGLE_LOGIN_ENABLED`/`AUTH_SSO_ENABLED`/`TURNSTILE_ENABLED=false`) |

### Remediasi yang terdeteksi (bukan blocker rilis dokumen ini — tercatat sebagai follow-up)

1. **R1 — `type` tidak konsisten diisi.** Hanya 14 dari 23 modul
   (`module_management`, `tenant_domain`, `visitor_analytics`,
   `data_lifecycle`, `domain_event_runtime`, `integration_hub` = `system`;
   `blog_content`, `news_portal`, `social_publishing`, `data_exchange`,
   `document_infrastructure`, `organization_structure`, `reference_data` =
   `domain`; `idn_admin_regions` = `base`) men-set field `type` di
   `module.ts`. 9
   modul lain (`tenant_admin`, `identity_access`, `profile_identity`,
   `logging`, `sync_storage`, `email`, `form_drafts`, `reporting`,
   `workflow`) meninggalkannya `undefined`, walau kategori efektifnya
   sudah jelas dari deskripsi + posisi dependency graph.
   **Rekomendasi**: issue follow-up terpisah untuk mengisi `type` di
   sembilan modul ini agar cocok dengan tabel §8 (`base`/`"core"` untuk
   tiga modul Core — catatan: `ModuleType` union saat ini tidak punya nilai
   literal `"core"`, hanya `"base"`; follow-up itu juga perlu memutuskan
   apakah `"base"` sudah cukup merepresentasikan kategori Core dokumen ini
   atau union perlu ditambah nilai `"core"` eksplisit — perubahan tipe,
   bukan sekadar isi field, sehingga sengaja tidak dilakukan dalam PR
   docs-only ini).
2. **R2 — `isCore` hanya diset di satu modul.** `module_management` adalah
   satu-satunya descriptor dengan `isCore: true` eksplisit, meski menurut
   kategori dokumen ini, `module_management` sebenarnya **System** (bukan
   Core) — ia esensial untuk _module lifecycle tracking_, tapi
   `tenant_admin`/`identity_access`/`profile_identity` (kategori Core
   dokumen ini: platform tidak bisa boot tanpanya) TIDAK men-set `isCore`
   sama sekali. Ini adalah gap semantik nyata antara arti `isCore` di kode
   historis (Issue #511, "esensial untuk sistem module management itu
   sendiri") vs kategori "Core" dokumen ini (foundational untuk seluruh
   platform). **Rekomendasi**: follow-up issue untuk salah satu dari (a)
   menambahkan `isCore: true` ke tiga modul Core juga, atau (b) mendokumen-
   tasikan eksplisit di komentar tipe `ModuleDescriptor.isCore` bahwa
   field ini historically berarti "module management essential", bukan
   sinonim kategori Core dokumen ini — tidak diputuskan di PR ini karena
   mengubah semantik field butuh diskusi maintainer, bukan keputusan
   sepihak dokumen governance.
3. **R3 — `maintainers` tidak pernah diisi.** Field opsional
   `ModuleDescriptor.maintainers?: string[]` ada di kontrak sejak awal
   tapi 0 dari 23 modul mengisinya — ownership hari ini murni berasal dari
   `.github/CODEOWNERS` (satu maintainer untuk seluruh repo). Tidak masalah
   selama tim tetap satu maintainer, tapi tabel §8 akan butuh diperbarui
   dari `maintainers` per modul, bukan CODEOWNERS repo-wide, begitu tim
   bertambah. **Rekomendasi**: follow-up issue mengisi `maintainers` per
   modul saat struktur tim berubah — tidak mendesak hari ini.
4. **R4 — `AGENTS.md` §Peta modul stale (RESOLVED).** Versi sebelumnya dari
   catatan ini melaporkan bahwa `AGENTS.md` §Peta modul memakai nama folder
   fiktif (`localization-ui`, `management-reporting`, `database-
connectivity`, `production-security-readiness`, dst.) yang tidak cocok
   dengan folder/`key` nyata di `src/modules/`. `AGENTS.md` §Peta modul saat
   ini sudah memakai nama modul nyata dan mendaftar seluruh 23 modul
   (base generik + pengecualian domain/system) — gap ini sudah tertutup,
   dicatat di sini hanya sebagai riwayat. **Tabel §8 dokumen ini tetap
   sumber kebenaran terkini** untuk kategori admission; jika keduanya
   berbeda di masa depan, `AGENTS.md` §Peta modul yang perlu disinkronkan
   ulang.

## 9. Proposal template ringan + architecture decision checklist

Lihat:

- `docs/awcms-mini/templates/module-proposal-template.md` — diisi di body
  issue GitHub sebelum modul System/Official Optional Module baru
  di-scaffold (lightweight, bukan RFC panjang).
- `docs/awcms-mini/templates/module-admission-decision-checklist.md` —
  checklist yang dipakai reviewer PR (manusia atau
  `awcms-mini-pr-review`) untuk memverifikasi sebuah proposal/PR modul baru
  benar-benar lolos §3-§7 sebelum merge, plus pertanyaan review
  external-provider/data-governance (superset dari §6 doc ini, format
  checklist siap-pakai).

Kedua file itu **tidak menggantikan** ADR (`docs/adr/0000-template.md`) —
proposal modul baru kategori Core atau perubahan struktural (mis. modul
System baru yang memperkenalkan provider eksternal baru) tetap butuh ADR
terpisah bila keputusannya mengikat lintas dokumen (GOVERNANCE.md §Perubahan
standar). Proposal template adalah **triase awal** sebelum menulis ADR
penuh.

**Kontrak murni (tanpa modul baru) tetap butuh ADR, bukan proposal
template.** Bukan setiap keputusan arsitektural mengikat berupa modul
baru — Issue #755 (`docs/adr/0020-erp-extension-readiness-contracts.md`,
epic #738 Wave 4) mendefinisikan sebelas keluarga kontrak kesiapan
ekstensi ERP (tipe TypeScript `_shared/*`, satu capability port baru)
TANPA mendaftarkan modul baru apa pun di `src/modules/index.ts` — proposal
template §9 di atas tidak berlaku (tidak ada modul untuk dinilai lewat
pohon keputusan §3), tapi keputusan arah kepemilikan/dependensinya
(base mendefinisikan kontrak, ekstensi ERP mengimplementasikan, Core/
System tidak pernah bergantung pada implementasi ERP) tetap mengikat
lintas dokumen sehingga tetap ditulis sebagai ADR penuh, bukan
didokumentasikan hanya di README modul (karena memang tidak ada modul).
Pola ini berlaku untuk kontrak/kebijakan LAIN yang murni struktural di
masa depan juga (bukan preseden khusus ERP).

## 10. Referensi

- `docs/adr/0013-extension-layers-and-boundary-model.md` — lapisan ekstensi
  lintas-repo (SaaS Control Plane, ERP Extension, Derived Application),
  batas tenant/legal entity/organization unit, data-ownership matrix, dan
  kriteria evidence-based ekstraksi layanan — Issue #739, epic #738.
- `docs/adr/0014-deterministic-build-time-module-composition.md` —
  mekanisme build-time module assembly (`src/modules/application-
registry.ts`, `composeModuleRegistry()`), taksonomi kegagalan komposisi,
  dan konvensi namespace migration — Issue #740, epic #738.
- `docs/adr/0001-modular-monolith-architecture.md`,
  `docs/adr/0002-bun-only-runtime.md` — batas arsitektural yang membuat §7
  mengikat.
- `docs/adr/0006-offline-first-sync-outbox.md` — pola provider eksternal
  di luar transaksi DB, dasar checklist §6.
- `docs/adr/0008-independent-contract-and-module-versioning.md` — versi
  independen kontrak/modul, relevan untuk deprecation (§4.4/§8 R1-R3
  follow-up).
- `docs/adr/0011-capability-ports-for-cross-module-collaboration.md` —
  dasar `capabilities.consumes[].optional` di §5.
- `docs/adr/0020-erp-extension-readiness-contracts.md`,
  `docs/awcms-mini/erp-extension-contracts.md` — kontrak kesiapan
  ekstensi ERP tanpa modul baru (§9 di atas), Issue #755, epic #738 Wave 4.
- `docs/awcms-mini/derived-application-guide.md`,
  `docs/awcms-mini/derived-app-pilot-plan.md` — kategori Derived
  Application (§2, §4.4).
- `src/modules/module-management/README.md`, `.claude/skills/
awcms-mini-module-management/SKILL.md` — mekanisme sync/lifecycle
  registry yang mendasari §7.
- `docs/awcms-mini/20_threat_model_security_architecture.md` — kontrol
  keamanan provider eksternal (A10 SSRF, circuit breaker) yang mendasari
  §6 checklist.
- `docs/awcms-mini/18_configuration_env_reference.md`,
  `src/lib/config/registry.ts` — sumber kebenaran `profiles`/`*_ENABLED`
  yang mendasari §6 tabel kompatibilitas.
- `docs/adr/0021-reference-data-module-admission.md` — admission
  `reference_data` (value set/code efektif-tanggal, baseline-global vs
  tenant-override, import tervalidasi, module-contributed catalogs) dan
  hubungannya dengan `idn_admin_regions` — Issue #750, epic #738.
- `docs/adr/0017-document-infrastructure-module-admission.md` — admission
  `document_infrastructure` (registry dokumen generik, versi immutable,
  klasifikasi/confidentiality, evidence, numbering sequence
  concurrency-safe) — Issue #751, epic #738.
