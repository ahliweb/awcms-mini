---
name: awcms-mini-ux-review
description: Audit dan tingkatkan kualitas UI/UX AWCMS-Mini di atas baseline design system. Gunakan saat diminta "review UX", "perbaiki tampilan/usability", audit aksesibilitas, atau menaikkan kualitas layar admin/POS/portal yang sudah ada. Berbeda dari awcms-mini-ui-screen (membangun layar baru sesuai standar) — skill ini menilai & menaikkan mutu layar yang sudah jadi.
---

# AWCMS-Mini — UI/UX Improvement Review

Sumber kebenaran: **`docs/awcms-mini/14_ui_ux_design_system.md`** (token, komponen, state pattern, a11y, i18n, theming) dan **`docs/awcms-mini/15_frontend_architecture_integration.md`** (SSR/islands, API client, offline). Skill ini **peningkatan** — bukan membangun dari nol (itu `awcms-mini-ui-screen`), melainkan menemukan gap kualitas dan menaikkannya.

## Prinsip peningkatan

Ukur dulu, baru ubah: identifikasi masalah nyata (heuristik usability, hasil axe/kontras, layout shift) sebelum menyentuh kode. Perbaikan UX **tidak boleh** melemahkan kontrol backend (UI hiding bukan otorisasi) atau membocorkan data sensitif.

## Checklist audit

- [ ] **Empat state lengkap** — setiap list/detail punya loading (skeleton, bukan spinner kosong), empty (+CTA), error (pesan aman ter-i18n dari error code doc 05), ready. Cari layar yang hanya render "ready".
- [ ] **A11y WCAG 2.1 AA** — kontras ≥4.5:1 (teks) / ≥3:1 (UI/grafik), fokus terlihat, label eksplisit tiap input, `aria-*` benar, dialog trap fokus + `Esc`, status tak hanya lewat warna, target sentuh ≥44px di mobile. Jalankan mental-pass axe.
- [ ] **Keyboard-only** — semua aksi tercapai tanpa mouse; POS mengikuti peta F1–F10 (doc 14); urutan tab logis; skip-link bila perlu.
- [ ] **Perceived performance** — tanpa layout shift (reserve ruang gambar/tabel), optimistic update dengan rollback (POS cart), no flash of wrong theme, feedback <100ms untuk aksi lokal.
- [ ] **Konsistensi token/komponen** — tak ada warna/ukuran/spacing hardcode; pakai `--color-*`/`--sp-*`/`--fs-*`; komponen dari `src/components/ui`, bukan duplikat ad-hoc.
- [ ] **Dark/light parity** — kedua tema diuji; kontras & keterbacaan setara; `data-theme` konsisten.
- [ ] **Responsif** — admin desktop-first tapi tetap usable di tablet; portal customer mobile-first; tak ada horizontal scroll tak sengaja; tabel lebar → scroll container.
- [ ] **Form UX** — validasi inline + pesan spesifik per field (bukan hanya banner), disable saat submit, cegah double-submit, preserve input saat error, autocomplete/inputmode tepat.
- [ ] **Micro-copy & i18n-ready** — teks jelas, ringkas, konsisten istilah (doc 19 glossary); semua string UI statis siap diekstrak ke katalog **`.po`** gettext `namespace.key` (default locale **en**, min en+id), bukan hardcode; konten data multi-bahasa dari DB per locale aktif; language switcher berikon bendera; format IDR/tanggal sadar-locale `Asia/Jakarta` (doc 14 §i18n, doc 04 §Konten multi-bahasa).
- [ ] **Masking di UI** — data sensitif lewat `MaskedText`; tak ada PII mentah tercache di IndexedDB/localStorage.
- [ ] **Offline-first terlihat** — status koneksi & antrean sync jelas (`SyncIndicator`/`OfflineBanner`); aksi tetap tersimpan lokal saat offline (doc 15).

## Heuristik usability (Nielsen, ringkas)

Visibilitas status sistem · kecocokan dengan dunia nyata · kontrol & kebebasan user (undo/cancel) · konsistensi & standar · pencegahan error (konfirmasi aksi destruktif) · recognition over recall · fleksibilitas (shortcut) · desain minimalis · pesan error membantu pemulihan · bantuan/dokumentasi bila perlu.

## Output

Daftar temuan berperingkat (blocker a11y → mayor → minor → polish), tiap temuan: lokasi (file/komponen), dampak ke user, dan patch yang disarankan. Verifikasi: 4 state dapat didemokan, keyboard-only pass, axe/kontras pass AA, tak ada string/warna hardcode, tak ada `fetch` mentah (lewat `apiFetch`).

## Skill terkait

`awcms-mini-ui-screen` (membangun layar sesuai standar), `awcms-mini-sensitive-data` (masking), `awcms-mini-testing` (render/state test), `awcms-mini-performance` (waktu muat & data fetching).
