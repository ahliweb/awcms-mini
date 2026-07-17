---
"awcms-mini": patch
---

Tutup celah "CI diam-diam menjalankan subset `bun run check`" untuk keempat
kalinya (Issue #823, epic #818). Lima langkah ada di komposit `check` tetapi tak
pernah dicerminkan ke `.github/workflows/ci.yml`: `api:docs:check`,
`repo:inventory:check`, `i18n:pot:check`, `config:docs:check`, dan
`logging:lint:check`. Kelimanya lolos saat dipasang, jadi ini risiko laten
(regresi inventory/API-docs/i18n/config-docs/logging bisa merge hijau), bukan
drift aktif.

Menambal lima langkah itu saja tidak cukup — daftar di `ci.yml` adalah cermin
manual dari `check`, dan cermin itu sudah melenceng empat kali
(#685/#740/#745/#746/#750) meski `ci.yml` memuat komentar peringatan panjang di
tiap langkah. Karena itu ditambahkan gate sesungguhnya:
`tests/unit/ci-check-parity.test.ts` mengurai komposit `check` dari
`package.json` lalu memastikan setiap langkahnya benar-benar dijalankan
`ci.yml`, sehingga menambah langkah `check` tanpa memasangnya di CI langsung
merah. Pemeriksaannya sengaja satu arah (`check` ⊆ `ci.yml`) karena CI memang
menjalankan lebih banyak (`db:migrate`, performance suite, DR drill); langkah
yang CI jalankan dengan bentuk perintah berbeda (`bun test`, `build`)
didaftarkan eksplisit di `RUN_DIFFERENTLY`, dan entri usang di daftar itu ikut
gagal supaya pengecualian tidak bertahan diam-diam setelah alasannya hilang.

Gate-nya diverifikasi benar-benar menangkap drift: menyisipkan langkah palsu ke
`check` membuat test merah dengan pesan yang menyebut langkah itu, dan hijau
kembali setelah dipulihkan.

Branch protection `main` (bagian kedua Issue #823) tetap butuh aksi owner dan
tidak termasuk perubahan ini.
