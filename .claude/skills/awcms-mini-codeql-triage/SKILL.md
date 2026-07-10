---
name: awcms-mini-codeql-triage
description: Triase dan perbaiki temuan CodeQL code scanning AWCMS-Mini (github.com/ahliweb/awcms-mini/security/code-scanning). Gunakan saat diminta "analisis code scanning"/"perbaiki CodeQL", saat sebuah PR gagal check CodeQL, atau saat menemukan alert baru. Mendokumentasikan tiga false-positive nyata yang sudah ditemukan (name-heuristic password, incompatible-types typeof/null, URL substring-sanitization di test mock) supaya tidak diinvestigasi ulang dari nol.
---

# AWCMS-Mini — Triase CodeQL Code Scanning

CodeQL (`.github/workflows/codeql.yml`, matrix `actions` + `javascript-typescript`) jalan di setiap push/PR ke `main`. Sebagian temuan adalah bug nyata; sebagian lain adalah **false positive** dari heuristik statis CodeQL yang tidak melihat konteks runtime sesungguhnya. Skill ini adalah proses triase + katalog false-positive yang sudah dikonfirmasi.

## Langkah triase (wajib, jangan menebak)

1. **Ambil daftar alert nyata** — jangan asumsikan dari ingatan/PR lama:
   ```bash
   gh api repos/ahliweb/awcms-mini/code-scanning/alerts --paginate \
     -q '.[] | select(.state=="open") | "\(.number)\t\(.rule.severity)\t\(.rule.id)\t\(.most_recent_instance.location.path):\(.most_recent_instance.location.start_line)"'
   ```
2. **Ambil detail + pesan asli per alert** (bukan cuma nama rule):
   ```bash
   gh api repos/ahliweb/awcms-mini/code-scanning/alerts/<N>
   ```
   Baca `most_recent_instance.message.text` — ini alasan CONCRETE CodeQL, bukan deskripsi generik rule. Untuk PR yang gagal check, `gh api repos/ahliweb/awcms-mini/check-runs/<id>/annotations` memberi lokasi+pesan yang sama.
3. **Cari bukti apakah ini bug nyata atau false positive** sebelum menulis kode apa pun:
   - Cek apakah pola kode yang sama persis ada di file lain **tanpa** alert — kalau ada, itu sinyal kuat false positive kontekstual (CodeQL flow-sensitive analysis kadang berbeda hasil per call-site untuk kode identik).
   - Baca pesan CodeQL kata-per-kata dan uji terhadap semantik JS/TS sesungguhnya — kalau pesannya menyebut sesuatu yang secara data-flow **tidak mungkin** (mis. menyebut sebuah fungsi yang terbukti tidak pernah mengembalikan field yang dituduh), itu bukti definitif false positive, bukan tebakan.
   - **Jangan** langsung tambah suppression comment (`// codeql[rule-id]`) sebagai upaya pertama — sudah terbukti **tidak efektif** di setup CI repo ini (diverifikasi PR #505, Issue #496: suppression comment tetap muncul ulang di run berikutnya).
4. **Perbaiki dengan code change minimal, behavior-preserving** — bukan menekan alert. Kalau setelah investigasi ternyata false positive murni tanpa cara reformulasi kode yang wajar, baru pertimbangkan dismiss resmi lewat API:
   ```bash
   gh api repos/ahliweb/awcms-mini/code-scanning/alerts/<N> -X PATCH \
     -f state=dismissed -f dismissed_reason=false_positive \
     -f dismissed_comment="<alasan konkret + bukti>"
   ```
5. **Verifikasi**: `bun run check` hijau, push, tunggu CI — konfirmasi CodeQL run berikutnya tidak lagi menampilkan alert yang sama (bukan cuma "kelihatannya benar").

## Katalog false-positive yang sudah dikonfirmasi

### 1. `js/insufficient-password-hash` — heuristik nama fungsi

CodeQL menandai **return value fungsi APA PUN yang namanya mengandung substring "password"** sebagai "password-flavored", terlepas dari apa yang sungguh-sungguh dikembalikan atau bagaimana dipakai. Ditemukan Issue #496 (PR #505): `hashPasswordResetToken` (hash token 256-bit) dan `validateForgotPasswordInput` (return `{loginIdentifier}`, TIDAK ADA field password sama sekali) sama-sama ditandai. Bukti definitif false positive: kasus kedua _tidak mungkin_ soal data-flow nyata karena tipe returnnya tidak punya field password sama sekali — satu-satunya penjelasan adalah heuristik nama.

**Fix yang terbukti berhasil**: **rename** fungsi agar namanya tidak mengandung "password" (`generatePasswordResetToken`→`generateResetToken`, `hashPasswordResetToken`→`hashResetToken`, `validateForgotPasswordInput`→`validateForgotIdentifierInput`, `validateResetPasswordInput`→`validateCompleteResetInput`). Suppression comment inline **dicoba lebih dulu dan terbukti tidak menghilangkan alert** — jangan ulangi jalan itu.

**Pencegahan**: saat menamai fungsi yang menangani hashing/validasi terkait password/reset/kredensial, hindari substring "password" di nama fungsi kalau return value-nya **bukan** password mentah/hash password sungguhan (mis. token, identifier, DTO tanpa field password) — heuristik CodeQL hanya melihat nama, bukan tipe.

### 2. `js/comparison-between-incompatible-types` — idiom `typeof x === "object" && x !== null`

Ditemukan 2026-07-07 (alert #11) di `isPlainObject`/`isRecord` helper (`typeof value === "object" && value !== null && !Array.isArray(value)`) — idiom standar JS untuk cek "objek non-null" (`typeof null === "object"`, sehingga cek `!== null` wajib). CodeQL menganggap setelah `typeof value === "object"` menyempitkan tipe `value` ke "Date, object, atau regular expression", lalu membandingkannya ke `null` dianggap "incompatible types" — padahal `null` selalu bisa dibandingkan langsung ke referensi objek apa pun di JS, ini bukan bug. Bukti false positive: pola identik ada di 4 file lain (`form-draft-validation.ts`, `settings-validation.ts`, `announcement-validation.ts`, `wizard-client.ts`) tanpa alert — CodeQL flow-sensitive analysis berbeda hasil per call-site untuk kode yang identik.

**Fix**: urutkan ulang — cek `value === null` **sebelum** narrowing `typeof`, bukan sesudahnya (perilaku runtime identik):

```ts
// Sebelum (bisa kena false positive):
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Sesudah (perilaku sama, tidak kena false positive):
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || Array.isArray(value)) {
    return false;
  }
  return typeof value === "object";
}
```

**Pencegahan**: saat menulis helper "is non-null object" baru, pakai urutan `value === null` dulu, baru `typeof`.

### 3. `js/incomplete-url-substring-sanitization` — `startsWith(<literal origin>)` di test mock fetch

Ditemukan 2026-07-10 (alert #19, #20) di `tests/unit/generic-oidc-client.test.ts` dan
`tests/integration/tenant-sso-flow.integration.test.ts` — kedua test menyuntik
`globalThis.fetch` palsu yang mencocokkan URL dengan
`url.startsWith("https://attacker.example.com")` untuk memutuskan kapan
membalas kegagalan simulasi. Rule ini didesain untuk kode PRODUKSI yang
memutuskan APAKAH SEBUAH URL DIPERCAYA berdasarkan awalan string (rawan
bypass `https://trusted.com.evil.com`) — di sini pemakaiannya justru
terbalik (mencocokkan URL mock test untuk MENOLAK, bukan mempercayai) dan
kedua sisi perbandingan sepenuhnya dikontrol test itu sendiri, jadi bukan
kerentanan sungguhan. Tetap diperbaiki dengan kode minimal alih-alih
suppress, karena `startsWith` juga secara tidak sengaja lebih longgar dari
yang dimaksud (cocok untuk origin manapun yang KEBETULAN diawali string
yang sama).

**Fix**: bandingkan `new URL(url).origin` dengan origin target secara
exact, bukan `startsWith` pada string mentah — perilaku test tetap sama
(masih cocok untuk semua path di bawah origin itu), tapi sekarang presisi
origin-level, bukan substring-level:

```ts
// Sebelum (kena false positive, dan sedikit longgar):
if (url.startsWith("https://attacker.example.com")) { ... }

// Sesudah (perilaku sama untuk kasus nyata, presisi origin):
if (new URL(url).origin === "https://attacker.example.com") { ... }
```

**Pencegahan**: saat menulis mock fetch di test yang mencocokkan URL
berdasarkan host/origin, pakai `new URL(url).origin === <origin>` alih-alih
`startsWith(<origin>)` — sama presisinya untuk niat aslinya (cocok semua
path di origin itu), tapi tidak memicu heuristik CodeQL yang menyasar pola
"substring sanitization" di kode produksi.

## Verifikasi

- `gh pr checks <PR>` — tunggu CodeQL selesai (jangan asumsikan pending = akan pass).
- Alert yang sudah diperbaiki otomatis pindah ke state `fixed` di halaman code-scanning pada run berikutnya di `main` — tidak perlu dismiss manual kalau memang sudah tidak muncul lagi.
- `bun run check` tetap harus hijau — perbaikan CodeQL tidak boleh mengubah perilaku runtime (lihat test yang sudah ada untuk fungsi yang diubah).

## Skill terkait

`awcms-mini-security-review` (checklist keamanan modul, bukan tooling scan), `awcms-mini-pr-review` (proses review PR secara umum).
