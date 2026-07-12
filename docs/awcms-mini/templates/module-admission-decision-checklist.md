# Module admission decision checklist

Checklist siap-pakai untuk reviewer PR (manusia atau skill
`awcms-mini-pr-review`) yang menambah/mengubah modul baru, atau menambah
provider eksternal baru ke modul yang sudah ada. Setiap poin merujuk ke
`docs/awcms-mini/21_module_admission_governance.md` (dokumen sumber
kebenaran) — checklist ini merangkum, tidak menggantikan.

## A. Kategori & pohon keputusan (doc 21 §2-§3)

- [ ] Kategori (Core/System/Official Optional Module/Derived
      Application/External Integration) sudah ditentukan lewat pohon
      keputusan §3, bukan diasumsikan.
- [ ] Bila kategori = Derived Application: PR ini **ditolak** di repo
      base — arahkan ke repo aplikasi turunan.
- [ ] Bila proposal melibatkan runtime code upload/install/marketplace/
      eval dari input tenant/pihak ketiga apa pun: PR ini **ditolak**
      tanpa pengecualian (doc 21 §7) kecuali sudah ada ADR baru yang
      mensupersede ADR-0001/ADR-0002.

## B. Dependency (doc 21 §5)

- [ ] `ModuleDescriptor.dependencies` (lifecycle) hanya berisi modul yang
      benar-benar harus aktif lebih dulu — bukan orkestrasi call-time
      (lihat catatan `tenant_admin`'s dependency cycle fix, Issue #680).
- [ ] Tidak ada cycle baru di dependency graph (`bun run db:migrate`/test
      `validateModuleDependencyGraph` lolos).
- [ ] Setiap `capabilities.consumes` entry menandai `optional: true` atau
      tidak secara eksplisit, dan README modul mendokumentasikan perilaku
      degradasi saat kapabilitas itu tidak tersedia.

## C. Kompatibilitas offline/LAN vs full-online-only (doc 21 §6)

- [ ] Kelas kompatibilitas (`offline-lan-safe`/`full-online-only`)
      dinyatakan eksplisit, bukan diasumsikan.
- [ ] Bila `full-online-only`: ada test/bukti bahwa profil `offline-lan`
      tetap 100% fungsional dengan fitur ini off.
- [ ] Entri `CONFIG_REGISTRY` baru (`src/lib/config/registry.ts`) sudah
      diisi dengan `profiles` yang benar (`ALL_PROFILES` vs
      `ONLINE_PROFILES`).

## D. Provider eksternal / data governance (doc 21 §4.5/§6)

Wajib dijawab bila PR menambah/mengubah adapter provider eksternal:

- [ ] Off-by-default: flag `*_ENABLED` default `false`, boot tidak gagal
      saat provider off.
- [ ] Kredensial hanya dari `process.env`/secret manager — tidak pernah
      dari kolom DB tenant-controlled, kecuali pengecualian yang sudah
      didokumentasikan sebagai accepted risk (mis. `issuer_url` OIDC
      tenant, Issue #591/#603/#609) dengan rasional tertulis yang setara.
- [ ] Panggilan keluar terjadi **di luar** transaksi DB mana pun
      (ADR-0006 pola claim/call/finalize).
- [ ] Ada circuit breaker (`getProviderCircuitBreaker`) + timeout
      (`withTimeout`) per provider key.
- [ ] Kegagalan provider terdegradasi anggun — tidak memblokir alur
      kritikal tenant/POS, tidak merusak jaminan offline-first.
- [ ] Data yang dikirim ke provider sudah diminimalkan/dimask sesuai
      doc 04 (NPWP/NIK/telepon/email) — dokumentasikan PII apa yang
      keluar batas trust dan mengapa perlu.
- [ ] Retensi data di sisi provider didokumentasikan atau dinyatakan N/A.
- [ ] Error dari provider melewati `sanitizeErrorForLog`/
      `logScriptFailure`/`logAdminPageError` sebelum masuk log (tidak ada
      secret/PII mentah di log).
- [ ] Perubahan konfigurasi provider (aktivasi/nonaktivasi, ganti
      kredensial) menulis audit log (aksi high-risk).
- [ ] Pertanyaan data-residency/subprocessor: di mana provider menyimpan
      data, apakah ToS/DPA-nya sudah ditinjau (governance, bukan kode) —
      dicatat sebagai catatan reviewer bila belum final.
- [ ] Skill `awcms-mini-security-review` sudah dijalankan dan hasilnya
      dilampirkan di PR.

## E. Ownership & lifecycle (doc 21 §4, §8)

- [ ] Modul baru men-set `type` di `module.ts` sesuai kategori yang
      disepakati (`system`/`domain`).
- [ ] Status lifecycle awal masuk akal (`experimental` untuk fitur baru
      yang belum matang, `active` bila sudah siap produksi) — bukan
      langsung `active` tanpa pertimbangan.
- [ ] Owner (CODEOWNERS atau `maintainers` bila sudah diisi) jelas.

## F. Deprecation/removal (bila PR ini men-deprecate/menghapus modul lain)

- [ ] Status descriptor diubah ke `deprecated` dengan changeset yang
      menjelaskan jalur migrasi dan target versi removal — pola yang
      sama dengan `ConfigVarDeprecation` (Issue #689).
- [ ] Data posted/append-only milik modul yang di-deprecate/dihapus tidak
      pernah dihapus diam-diam (ADR-0005) — ada rencana arsip/retensi
      eksplisit.
- [ ] Ada jendela deprecation minimal (dicatat di changeset) sebelum kode + tabel benar-benar dihapus, dan tidak ada tenant yang masih
      `enabled` pada modul tersebut tanpa notice.
- [ ] Perubahan API/event terkait (route dihapus, event tidak dipublish
      lagi) sudah tercermin di OpenAPI/AsyncAPI dan changeset ber-bump
      `major` (breaking change, SemVer).

## G. Dokumentasi & kontrak

- [ ] OpenAPI diperbarui (`bun run api:spec:check` lolos) bila modul
      menambah endpoint.
- [ ] AsyncAPI diperbarui bila modul menambah/mengubah event.
- [ ] Migration baru (`NNN_awcms_mini_*.sql`) ada bila skema berubah,
      dengan RLS + index FK.
- [ ] Changeset ditambahkan (`bun run changeset`).
- [ ] README modul mendokumentasikan tujuan, tabel, endpoint, event,
      dependency, dan (bila relevan) provider eksternal + perilaku
      degradasinya.
