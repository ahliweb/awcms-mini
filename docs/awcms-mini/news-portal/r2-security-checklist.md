# News Portal — R2 Security Checklist

Checklist siap-pakai untuk implementor (Issue #632-#635) dan operator
sebelum mengaktifkan mode **full-online R2-only** untuk gambar berita
(lihat [`full-online-r2-architecture.md`](full-online-r2-architecture.md)
§1 untuk asumsi full-online-only — checklist ini **tidak berlaku** untuk
offline/LAN). Setiap item merujuk bagian arsitektur yang menjelaskan
alasannya.

## 1. Validasi upload

- [ ] Ukuran file ditolak **sebelum** membaca isi file bila melebihi
      `NEWS_MEDIA_R2_MAX_UPLOAD_BYTES` (arsitektur §9 langkah 1); untuk
      Jalur A, `confirm` juga menolak reaktif via `Content-Length`
      sebenarnya dari `HEAD` (residual risk presigned PUT yang diterima
      secara eksplisit, §9 langkah 1).
- [ ] `confirm` melakukan **`GET` penuh objek dari R2, bukan `HEAD`
      saja**, sebelum status boleh naik ke `confirmed` — pada KEDUA
      jalur (§9: "kedua jalur wajib menjalankan urutan validasi yang
      sama"). `HEAD` sendirian (eksistensi/`Content-Length`/ETag) tidak
      pernah menjadi dasar `confirmed`.
- [ ] MIME divalidasi dari **magic bytes hasil `GET` di atas**, bukan
      `Content-Type` header client, ekstensi nama file, atau checksum
      yang diklaim client (§9 langkah 2).
- [ ] `image/svg+xml` **tidak** ada di allow-list default (§9 langkah 3)
      — mengizinkannya butuh keputusan terpisah + pipeline sanitasi.
- [ ] Ekstensi object key **diturunkan** dari MIME tervalidasi, bukan
      dari input client (§6/§9 langkah 4).
- [ ] Checksum SHA-256 dihitung **server-side dari isi objek** yang
      benar-benar dibaca saat `confirm` (bukan hanya dibandingkan
      terhadap `Content-Length`/ETag) sebelum status naik ke
      `confirmed`; checksum yang diklaim client hanya dipakai sebagai
      deteksi korupsi transport, tidak pernah sebagai satu-satunya
      bukti validasi konten (§9 langkah 5).
- [ ] Tidak ada jalur yang melewati salah satu dari validasi di atas
      untuk kategori file/purpose apa pun (§9 langkah 6 — defense in
      depth, tanpa pengecualian diam-diam, dan tanpa jalur yang
      "dipercaya lebih aman" hanya karena upload-nya direct-to-R2).

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

**Status: diimplementasikan oleh Issue #632** (lebih awal dari rencana
semula #635 — #632's acceptance criteria sendiri mensyaratkan
"`bun run config:validate` mencakup preset ini" dan
"`bun run security:readiness` mencakup preset ini", jadi shape+separation
checks di bawah landed bersamaan dengan preset itu sendiri, bukan
menunggu #635):

- **`bun run config:validate`** (shape-only, `scripts/validate-env.ts`):
  - `checkNewsPortalProfileConfig` — `NEWS_PORTAL_PROFILE` bila diisi
    wajib `full_online_r2`.
  - `checkNewsMediaR2Config` — bila `NEWS_MEDIA_R2_ENABLED=true`:
    `NEWS_MEDIA_R2_ACCOUNT_ID`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`,
    `_BUCKET`, `_PUBLIC_BASE_URL` wajib terisi (pola sama `checkR2Config`
    untuk `R2_*`) DAN `_PUBLIC_BASE_URL` wajib URL HTTPS absolut.
  - `checkNewsMediaR2SeparationFromSyncR2` — `NEWS_MEDIA_R2_BUCKET`/
    `_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY` ≠ `R2_BUCKET`/`R2_ACCESS_KEY_ID`/
    `R2_SECRET_ACCESS_KEY` (§2 penegakan nyata, gagal boot bila sama —
    bukan hanya dokumentasi).
- **`bun run security:readiness`** (`scripts/security-readiness.ts`):
  - `checkNewsPortalFullOnlineR2PresetReady` (**critical**) — menilai
    kombinasi penuh syarat aktivasi preset (`NEWS_PORTAL_ENABLED`,
    `NEWS_PORTAL_PROFILE`, kelengkapan+separasi `NEWS_MEDIA_R2_*`) lewat
    `evaluateNewsPortalFullOnlineR2Readiness`
    (`src/modules/news-portal/domain/news-portal-preset-readiness.ts`).
  - `checkNewsMediaR2SvgNotAllowed` (**warning**) — `image/svg+xml` tidak
    ada di `NEWS_MEDIA_R2_ALLOWED_MIME_TYPES` kecuali operator eksplisit
    override.
- **`bun run production:preflight`** — tidak butuh tahap baru (sudah
  menjalankan `config:validate` dan `security:readiness` sebagai bagian
  urutannya, doc 18); kedua check di atas otomatis ikut terpanggil.

**Masih terbuka untuk #633/#634/#635** (di luar cakupan #632): tidak ada
check di atas yang menyentuh tabel media registry itu sendiri (objek
`pending` basi, orphaned object detection — `r2-backup-lifecycle.md` §2)
atau perilaku runtime endpoint upload (MIME sniffing dari magic bytes,
checksum server-side dari isi objek — §9 arsitektur) karena tabel/endpoint
itu belum ada. Implementor #633/#634/#635 **wajib** memperbarui bagian ini
lagi begitu check readiness baru yang relevan ke schema/endpoint tersebut
ditulis.

## 8. Monitoring & audit

- [ ] Setiap `confirm` (sukses/gagal) menulis **audit event formal**
      lewat skill `awcms-mini-audit-log` (bukan hanya correlation-ID
      logging aplikasi biasa, pola `sync_storage.object_dispatch.*`) —
      ini mutation high-risk yang menaikkan status metadata ke
      `confirmed` (§7 arsitektur), sama kelas dengan aksi lain yang
      wajib audit di doc 03/10.
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
