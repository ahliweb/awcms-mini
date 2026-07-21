# ADR-0024 — Keluarga AWCMS sebagai template dipakai-LANGSUNG untuk pengembangan apa pun, dan penghapusan jalur aplikasi-turunan

- **Status:** Accepted
- **Tanggal:** 2026-07-21
- **Pengambil keputusan:** @ahliweb
- **Men-supersede:** [ADR-0013](0013-extension-layers-and-boundary-model.md) (lapisan Derived Application + framing "di luar base"), [ADR-0014](0014-deterministic-build-time-module-composition.md) (komposisi build-time untuk aplikasi turunan / `application-registry.ts` + namespace migration turunan), [ADR-0015](0015-derived-application-compatibility-manifest.md) (manifest kompatibilitas turunan + `extension:check`). **Meng-amend:** [ADR-0012](0012-module-admission-and-trusted-registry-boundary.md) (kategori admission — "Derived Application" tak lagi berarti repo terpisah) dan [ADR-0020](0020-erp-extension-readiness-contracts.md) (kontrak kesiapan ERP tetap, tetapi ekstensi ERP boleh hidup langsung di `src/modules/`, bukan wajib di repo terpisah). Menegaskan kembali: konvensi teknis inti (ADR-0001 modular-monolith, ADR-0002 Bun-only, ADR-0003 RLS, ADR-0004 default-deny, ADR-0011 capability ports).
- **Selaras dengan:** `awcms` ADR-0034 dan `awcms-micro` ADR-0034/0035 (template dipakai-langsung, deprecation/penghapusan jalur turunan) — dokumen ini menyelaraskan keputusan itu ke seluruh keluarga (lihat §5).

## Konteks

Epic #738 (`platform-evolution`) membangun **jalur aplikasi-turunan**: `awcms-mini` dipakai sebagai fondasi yang di atasnya dibangun aplikasi domain di **repo terpisah** (mis. sebuah AWPOS) lewat seam `src/modules/application-registry.ts` (Issue #740/ADR-0014) + migration namespace turunan 900–999 + manifest kompatibilitas `extension.manifest.json` (Issue #741/ADR-0015) + gerbang `bun run extension:check`. ADR-0013 menempatkan lapisan **Derived Application** "di luar base", dan ADR-0020 menetapkan ekstensi ERP juga hidup di repo terpisah.

Dua konsekuensi yang tidak diinginkan:

1. **Repo derivatif menambah lapisan tanpa manfaat setara.** Untuk membangun apa pun, model "buat repo turunan terpisah di atas base" mewajibkan registry aplikasi, penomoran migrasi khusus 900–999, manifest kompatibilitas SemVer, dan gate yang harus dipelihara — padahal untuk banyak kebutuhan cukup **memakai repo template secara langsung** dan menambah modul domain di dalamnya.
2. **Ketiga repo keluarga sebenarnya adalah template yang berdiri sendiri.** `awcms-mini` (standar modular-monolith), `awcms` (fondasi ERP + solusi back-office), dan `awcms-micro` (website full-online hingga toko online) masing-masing sudah lengkap sebagai titik-awal. Framing "base wajib + turunan terpisah" bertentangan dengan kenyataan itu.

## Keputusan

### 1. Tiga repo keluarga = template dipakai-LANGSUNG untuk pengembangan apa pun

`awcms-mini`, `awcms`, dan `awcms-micro` adalah **tiga template dasar yang sejajar**, masing-masing **dipakai langsung** sebagai titik awal pengembangan — bukan basis-turunan-wajib yang di atasnya harus dibangun repo aplikasi terpisah. Perbedaan mereka adalah **scope/lineage**, bukan hierarki:

| Repositori    | Peran (dipakai langsung)           | Scope                                        |
| ------------- | ---------------------------------- | -------------------------------------------- |
| `awcms-mini`  | Template standar modular-monolith  | Fondasi reusable generik                     |
| `awcms`       | Template lineage ERP / back-office | ERP, solusi bisnis, dan pengembangan apa pun |
| `awcms-micro` | Template website full-online       | Situs konten hingga toko online (e-commerce) |

Cara pakai utama: **fork/gunakan repo yang scope-nya paling dekat, lalu kembangkan modul langsung di dalamnya.** Warisan konvensi antar-repo tetap dicatat (Bun-only, RLS/FORCE, RBAC/ABAC default-deny, kontrak OpenAPI/AsyncAPI, gate CI), tetapi tidak ada repo yang diposisikan sebagai "turunan yang wajib mem-port dari repo lain secara berkelanjutan".

### 2. TIDAK membuat repo derivatif

Pengembangan baru **tidak** dilakukan dengan membuat repo aplikasi-turunan terpisah di atas salah satu template. Modul domain — termasuk ekstensi ERP dan modul konten/website — **boleh dan seharusnya** hidup langsung di `src/modules/` template yang dipakai. Ini meng-amend ADR-0020 (ekstensi ERP di repo terpisah) dan kategori "Derived Application" ADR-0012/0013: pembatasan repo-terpisah dicabut. Kontrak kesiapan ERP ADR-0020 (`_shared/business-transaction-contract.ts`, `_shared/ports/period-lock-port.ts`, `_shared/erp-reference-data-contract.ts`) **tetap** — ia sekarang dikonsumsi oleh modul domain in-repo, bukan oleh repo turunan eksternal.

### 3. Jalur aplikasi-turunan di `awcms-mini`: DIHAPUS

`awcms-mini` **menghapus** permukaan yang **khusus jalur-turunan** (bukan sekadar men-deprecate), meniru langkah `awcms`:

- Seam turunan `src/modules/application-registry.ts` (yang selalu `undefined` di base), gerbang `bun run extension:check` (`scripts/extension-check.ts`).
- Mesin manifest kompatibilitas turunan: `src/modules/module-management/domain/extension-compatibility.ts`, `src/modules/_shared/extension-manifest-contract.ts`, `src/modules/_shared/capability-contract-versions.ts`, dan konsep `extension.manifest.json` (ADR-0015) beserta fixture `tests/fixtures/extension-contract-incompatible/`.
- Konsep migration namespace turunan (900–999) — tipe komposisi `ApplicationModuleRegistry`/`ModuleMigrationNamespace` (`_shared/module-contract.ts`), konstanta `BASE_MODULE_MIGRATION_NAMESPACE` dan check `prohibited_base_override`/`invalid_module_type`/`migration_namespace_overlap`/`mergeModuleRegistries` (`module-composition.ts`).

`MODULE_CONTRACT_VERSION` naik `1.4.0` → `2.0.0` (MAJOR: tipe kontrak yang diekspor dihapus). Tidak ada field `ModuleDescriptor` yang berubah — setiap `module.ts` base tetap valid tanpa perubahan.

**Yang DIPERTAHANKAN** karena load-bearing base (bukan derived-only, dipakai perakitan registry base, module-management, reporting, ERP-readiness, SaaS control plane): `src/modules/index.ts` `listModules()`/`listBaseModules()`, kontrak `ModuleDescriptor`/`defineModule` (`_shared/module-contract.ts`), `module-management`, dan validasi komposisi base sejauh ia memeriksa **registry base sendiri** (`composeModuleRegistry`/`validateComposedModuleRegistry`/`buildComposedModuleInventory` menerima `readonly ModuleDescriptor[]`) — check DAG, duplicate module key, capability binding, deployment profile, navigation, dan job descriptor semuanya invariant base yang juga berlaku saat modul domain baru ditambahkan langsung ke `src/modules/`. Gate `modules:compose:check` + `modules:composition:inventory:check` tetap ada. Penghapusan dilakukan sebagai langkah **evidence-gated** terpisah (PR sendiri, `bun run check` + CI penuh hijau); ADR ini adalah keputusannya.

### 4. Dokumen & issue jalur-turunan: usang

`docs/awcms-mini/derived-application-guide.md`, `derived-app-pilot-plan.md`, dan `extension-compatibility-policy.md` ditandai **DEPRECATED** (menunjuk ADR ini). Kapabilitas fondasi yang sudah selesai dan bernilai (kontrak kesiapan ERP #755/ADR-0020, SaaS control plane #868/ADR-0022, kontrak OpenAPI/AsyncAPI) **tetap** — hanya premis "repo turunan terpisah" yang dicabut.

### 5. Harmonisasi lintas keluarga

Sikap yang sama diterapkan ke ketiga repo (langkah terpisah per-repo):

- **awcms:** ADR-0034 miliknya + penghapusan penuh permukaan derived-only.
- **awcms-micro:** ADR-0034/0035 miliknya (deprecate framing + tahan kode komposisi load-bearing).
- **awcms-mini:** dokumen ini + penghapusan penuh permukaan derived-only (§3), mengikuti langkah `awcms`.

## Konsekuensi

- **Positif:** tidak ada lapisan repo-turunan wajib; pengembangan langsung di template; modul domain/ERP/website boleh masuk base.
- **Ditegakkan terpisah (PR ini):** penghapusan kode/gate derived-only di `awcms-mini` (§3) — evidence-gated `bun run check` penuh hijau; fixture `tests/fixtures/derived-application-example/` direlokasi jadi test-support non-derived `tests/fixtures/example-domain-modules/` (cakupan test #740/#741/#755 dipertahankan setara).
- **Tidak berubah:** seluruh konvensi runtime (Bun-only, RLS/FORCE, RBAC/ABAC default-deny, kontrak, registry base saat ini, gate CI non-derived) dan kontrak kesiapan ERP/SaaS. ADR ini mengubah **model pemakaian & tata kelola**, bukan arsitektur runtime.
