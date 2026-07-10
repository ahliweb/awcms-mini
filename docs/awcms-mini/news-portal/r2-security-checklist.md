# News Portal — R2 Security Checklist

Checklist siap-pakai untuk implementor (Issue #632-#635) dan operator
sebelum mengaktifkan mode **full-online R2-only** untuk gambar berita
(lihat [`full-online-r2-architecture.md`](full-online-r2-architecture.md)
§1 untuk asumsi full-online-only — checklist ini **tidak berlaku** untuk
offline/LAN). Setiap item merujuk bagian arsitektur yang menjelaskan
alasannya.

## 1. Validasi upload

- [ ] Ukuran file ditolak **sebelum** membaca isi file bila melebihi
      `NEWS_MEDIA_R2_MAX_UPLOAD_BYTES` (arsitektur §9 langkah 1).
- [ ] MIME divalidasi dari **magic bytes**, bukan `Content-Type` header
      client atau ekstensi nama file (§9 langkah 2).
- [ ] `image/svg+xml` **tidak** ada di allow-list default (§9 langkah 3)
      — mengizinkannya butuh keputusan terpisah + pipeline sanitasi.
- [ ] Ekstensi object key **diturunkan** dari MIME tervalidasi, bukan
      dari input client (§6/§9 langkah 4).
- [ ] Checksum SHA-256 aktual dicocokkan terhadap checksum yang diklaim
      sebelum status naik ke `confirmed` (§9 langkah 5).
- [ ] Tidak ada jalur yang melewati salah satu dari empat validasi di
      atas untuk kategori file/purpose apa pun (§9 langkah 6 — defense
      in depth, tanpa pengecualian diam-diam).

## 2. Object key & penyimpanan

- [ ] Format object key = `news-media/{tenantId}/{yyyy}/{mm}/{uuid}.{ext}`
      (arsitektur §6) — `tenantId` UUID, bukan `tenantCode`.
- [ ] Object key **tidak pernah** menyertakan nama file asli/input teks
      bebas client (§6).
- [ ] `original_filename` disimpan hanya sebagai metadata tampilan,
      terpisah dari object key (§5/§6).
- [ ] Tidak ada kolom binary (`bytea`, base64 text besar, dsb.) di tabel
      metadata mana pun (§3.2/§5 arsitektur).
- [ ] Tidak ada jalur kode yang menulis bytes gambar ke
      `LOCAL_STORAGE_PATH`/disk lokal server sebagai fallback (§3.3/§3.4).

## 3. Presigned URL

- [ ] TTL presigned upload PUT = `NEWS_MEDIA_R2_PRESIGNED_UPLOAD_TTL_SECONDS`,
      default pendek (300 detik) (arsitektur §8).
- [ ] Tidak ada presigned URL untuk **GET**/baca — pembacaan selalu lewat
      custom domain publik (§8/§11).
- [ ] Langkah `confirm` memverifikasi eksistensi + checksum aktual
      sebelum status `confirmed` (§7/§9) — presigned URL yang valid
      tidak otomatis berarti kontennya sah.
- [ ] Presigned URL **tidak pernah** dicatat penuh di log aplikasi
      (perlakukan setara bearer credential jangka pendek, ASVS V3.x).

## 4. CORS

- [ ] `AllowedOrigins` bucket media berita = daftar eksplisit origin
      admin tenant — **tidak pernah** `"*"` (arsitektur §10).
- [ ] `AllowedMethods` hanya `PUT` (+ preflight) — tidak ada `GET`/`DELETE`
      lewat CORS untuk bucket ini.
- [ ] Konfigurasi CORS bucket media **tidak** disalin ke bucket
      `sync-storage` — bucket itu tidak butuh CORS sama sekali (§2/§10).

## 5. Custom domain & Cache-Control

- [ ] `NEWS_MEDIA_R2_PUBLIC_BASE_URL` HTTPS absolut, custom domain R2
      (bukan `*.r2.dev`) (arsitektur §11).
- [ ] URL publik objek selalu di-derive dari `object_key` + base URL saat
      render — tidak disimpan sebagai kolom URL absolut terpisah (§11).
- [ ] Objek diberi `Cache-Control: public, max-age=31536000, immutable`
      saat upload (arsitektur §12).
- [ ] Mengganti gambar = upload objek/key baru, bukan overwrite key lama
      (§12 — mencegah cache poisoning).

## 6. Kredensial R2 — least privilege & rotasi

- [ ] `NEWS_MEDIA_R2_BUCKET` **berbeda** dari `R2_BUCKET` (bucket
      `sync-storage`) — divalidasi tidak sama saat `config:validate`
      (arsitektur §2/§4).
- [ ] `NEWS_MEDIA_R2_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY` **berbeda** dari
      `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` (§2/§13).
- [ ] API token R2 media berita di-scope ke **satu bucket** saja, bukan
      "Account API Token" administratif penuh (§13).
- [ ] Token yang disuntik ke runtime aplikasi **tidak** punya permission
      administratif bucket (ubah CORS/lifecycle/hapus bucket) — hanya
      `Object Read & Write` (§13).
- [ ] Rotasi terjadwal (rekomendasi 90 hari) mengikuti urutan: buat token
      baru → update env → redeploy → cabut token lama (§13, tanpa
      downtime, tanpa window tanpa kredensial valid).
- [ ] Rotasi darurat (pasca-insiden) mengikuti
      [`r2-incident-response.md`](r2-incident-response.md), bukan jadwal
      rutin.

### Contoh kebijakan API token R2 (least privilege, ilustratif)

```json
{
  "token_name": "news-media-r2-app-token",
  "permission_groups": ["Object Read & Write"],
  "resources": {
    "com.cloudflare.edge.r2.bucket.<account-id>_<news-media-bucket>": "*"
  },
  "not_allowed": [
    "Bucket delete",
    "Bucket CORS/lifecycle configuration",
    "Account-level R2 administration"
  ]
}
```

Konfigurasi bucket (CORS, lifecycle, custom domain) tetap dilakukan
operator lewat dashboard/Terraform terpisah dengan kredensial admin
terpisah — **tidak pernah** lewat token yang sama yang disuntik ke
`NEWS_MEDIA_R2_ACCESS_KEY_ID` runtime aplikasi.

## 7. Readiness gates (`config:validate` / `security:readiness` / `production:preflight`)

Acceptance criteria Issue #631 mensyaratkan readiness checklist ini
merujuk tiga command yang sudah ada di repo — status saat ini (Issue
#631, docs-only): **belum ada check khusus news media** di ketiganya;
Issue #635 ("Add Cloudflare R2 image delivery readiness checks") adalah
yang mengimplementasikannya. Kontrak yang wajib dipenuhi Issue #635:

- **`bun run config:validate`** (shape-only, `scripts/validate-env.ts`)
  wajib menambah:
  - Bila `NEWS_MEDIA_R2_ENABLED=true`: `NEWS_MEDIA_R2_ACCOUNT_ID`,
    `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_BUCKET`,
    `_PUBLIC_BASE_URL` wajib terisi (pola sama `checkR2Config` yang
    sudah ada untuk `R2_*`).
  - `NEWS_MEDIA_R2_BUCKET` ≠ `R2_BUCKET` (bila keduanya aktif) — gagal
    validasi bila sama (§2 penegakan, bukan hanya dokumentasi).
  - `NEWS_MEDIA_R2_PUBLIC_BASE_URL` harus URL HTTPS absolut.
- **`bun run security:readiness`** (safety/severity, cross-field) wajib
  menambah pengecekan **critical**:
  - Bucket media dan bucket sync tidak sama (redundan dengan
    `config:validate` sebagai defense in depth, pola yang sama dipakai
    check lain di repo yang menduplikasi validasi shape+safety).
  - Kredensial media berbeda dari kredensial sync.
  - `image/svg+xml` tidak ada di `NEWS_MEDIA_R2_ALLOWED_MIME_TYPES`
    kecuali operator eksplisit override (warning bila di-override, tidak
    pernah default-on).
- **`bun run production:preflight`** — tidak butuh tahap baru (sudah
  menjalankan `config:validate` dan `security:readiness` sebagai bagian
  urutannya, doc 18) — cukup pastikan kedua check di atas benar-benar
  terpanggil dari urutan yang sudah ada, tidak membuat jalur pintas
  terpisah.

Implementor #635 **wajib** memperbarui bagian ini (ganti "belum ada"
menjadi nama fungsi/test nyata) begitu check-nya ditulis — jangan
biarkan dokumen ini menyiratkan check sudah ada padahal belum
(konsisten dengan status "Belum dikerjakan" di skill).

## 8. Monitoring & audit

- [ ] Setiap `confirm` (sukses/gagal) dicatat lewat correlation ID
      terstruktur (pola `sync_storage.object_dispatch.*` yang sudah ada).
- [ ] Percobaan checksum-mismatch berulang dari identity/IP yang sama
      dalam jendela waktu pendek memicu perhatian operator (lihat
      `r2-incident-response.md` §Malicious upload untuk ambang & respons).
- [ ] Rotasi kredensial (§6) dicatat sebagai audit event high-risk
      (skill `awcms-mini-audit-log`), bukan hanya perubahan env var yang
      tidak terlacak.

## 9. Referensi

- `full-online-r2-architecture.md` — arsitektur & pemetaan kepatuhan lengkap.
- `r2-upload-sop.md` — alur operasional upload.
- `r2-incident-response.md` — respons insiden.
- `r2-backup-lifecycle.md` — retensi dan lifecycle objek.
- `.claude/skills/awcms-mini-security-hardening/SKILL.md` — audit OWASP/ASVS/ISO tingkat repo.
