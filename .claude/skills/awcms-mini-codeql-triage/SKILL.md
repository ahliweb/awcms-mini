---
name: awcms-mini-codeql-triage
description: Triase dan perbaiki temuan CodeQL code scanning AWCMS-Mini (github.com/ahliweb/awcms-mini/security/code-scanning). Gunakan saat diminta "analisis code scanning"/"perbaiki CodeQL", saat sebuah PR gagal check CodeQL, atau saat menemukan alert baru. Mendokumentasikan satu TRUE-positive terkonfirmasi (password sungguhan → digest cepat yang dipersist = oracle cracking offline, plus dua "fix" yang membungkam alert tanpa memperbaiki apa pun) dan lima false-positive nyata (name-heuristic password, incompatible-types typeof/null, URL substring-sanitization di test mock, dua kasus dismiss resmi tanpa reformulasi kode, dan Bun.SQL tagged-template null-cast) plus pola "unused-local-variable di test kadang menandai coverage gap" — supaya tidak diinvestigasi ulang dari nol.
---

# AWCMS-Mini — Triase CodeQL Code Scanning

CodeQL (`.github/workflows/codeql.yml`, matrix `actions` + `javascript-typescript`) jalan di setiap push/PR ke `main`. Sebagian temuan adalah bug nyata; sebagian lain adalah **false positive** dari heuristik statis CodeQL yang tidak melihat konteks runtime sesungguhnya. Skill ini adalah proses triase + DUA katalog: true-positive dan false-positive yang sama-sama sudah dikonfirmasi. Rule yang sama (`js/insufficient-password-hash`) muncul di kedua katalog — jangan pernah menyimpulkan dari nama rule saja.

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
4. **Perbaiki dengan code change minimal, behavior-preserving** — bukan menekan alert. Kalau setelah investigasi ternyata false positive murni tanpa cara reformulasi kode yang wajar, baru pertimbangkan dismiss resmi lewat API (lihat §4 katalog di bawah untuk dua kasus nyata):
   ```bash
   gh api repos/ahliweb/awcms-mini/code-scanning/alerts/<N> -X PATCH \
     -f state=dismissed -f "dismissed_reason=false positive" \
     -f dismissed_comment="<alasan konkret + bukti, maks 280 karakter>"
   ```
   `dismissed_reason` harus PERSIS `"false positive"` / `"won't fix"` / `"used in tests"` (dengan spasi) — `false_positive` dengan underscore ditolak API (422). `dismissed_comment` dibatasi 280 karakter; taruh alasan lengkap di katalog skill ini, bukan di comment.
5. **Verifikasi**: `bun run check` hijau, push, tunggu CI — konfirmasi CodeQL run berikutnya tidak lagi menampilkan alert yang sama (bukan cuma "kelihatannya benar").

## Katalog TRUE-POSITIVE yang sudah dikonfirmasi

**Baca bagian ini SEBELUM katalog false-positive di bawahnya.** Katalog FP itu
panjang dan mudah membuat bias "CodeQL biasanya salah" — padahal setidaknya satu
alert `js/insufficient-password-hash` ternyata **bug nyata**. Rule yang sama bisa
menghasilkan FP dan TP; yang menentukan adalah SUMBER-nya, bukan nama rule-nya.

### T1. `js/insufficient-password-hash` — password sungguhan → digest cepat yang DIPERSIST (alert #63/#64)

Ditemukan 2026-07-25 di
`src/modules/tenant-provisioning/application/provisioning-orchestrator.ts`
(`computeProvisioningInputsHash`). **Bukan** heuristik nama (pattern FP-1):
pesan CodeQL menyebut `an access to password`, dan sumbernya memang
`input.owner.password` — password yang dipilih manusia, bukan token CSPRNG.

Kenapa nyata: hasilnya di-fold ke `inputs_hash` yang **dipersist dua kali**
(`awcms_mini_tenant_provisioning_requests.inputs_hash` dan `request_hash` di
idempotency store). SEMUA field lain yang masuk digest itu bisa dibaca pembaca
DB yang sama — `tenantCode`/`tenantName`/`options` ada di kolom `inputs` jsonb
di sebelahnya; `ownerLoginIdentifier`, `legalName`, `officeCode`, `officeName`,
`ownerDisplayName` ada di tabel identity/tenant/office yang ditulis run yang
sama. Jadi siapa pun dengan akses READ DB bisa menebak password dengan biaya
dua SHA-256 per tebakan dan mengonfirmasi hit ke kolom tersimpan → **oracle
cracking offline untuk password administrator awal sebuah tenant**, tanpa perlu
hak tulis apa pun.

**Fix**: derivasi **scrypt** dengan salt = pepper ber-domain-separation
(`AUTH_JWT_SECRET`) di `application/owner-secret-commitment.ts`. Argon2id TIDAK
bisa dipakai: nilainya harus deterministik dan dapat dihitung ulang dari body
request di setiap replay, sedangkan argon2id di-salt acak per panggilan.
Kredensial asli tidak tersentuh — sudah argon2id lewat `src/lib/auth/password.ts`.

**Percobaan pertama memakai HMAC-SHA256 ber-pepper, dan CodeQL TETAP menandainya**
(diverifikasi di CI, PR #937 run pertama) — HMAC-SHA256 tetap sebuah
"fast hash" sink bagi rule ini, terlepas dari adanya kunci. scrypt dengan salt
TETAP bersifat deterministik sekaligus mahal, sehingga memenuhi dua-duanya:

- **berkunci** — pepper ada di environment proses, bukan di kolom, jadi pembaca
  DB saja tidak bisa mereproduksi digest dari tebakan;
- **mahal** — kalaupun pepper bocor, tiap tebakan berharga satu derivasi scrypt
  penuh, bukan satu SHA-256.

Jadi pindah dari HMAC ke scrypt bukan sekadar menyenangkan CodeQL: ia menutup
single-point-of-failure "kalau pepper bocor, semuanya instan". **Pelajaran
umum**: kalau `js/insufficient-password-hash` menuntut "computational effort"
tapi nilainya harus deterministik, jawabannya adalah **KDF lambat dengan salt
tetap** (scrypt/PBKDF2), bukan HMAC. Pin parameter biaya secara eksplisit
(`{N,r,p}`) — digest ini DIPERSIST dan dibandingkan saat replay, jadi default
runtime yang berubah akan membatalkan seluruh `inputs_hash` tersimpan secara
diam-diam. Jangan pakai `promisify(scrypt)`: ia runtuh ke overload 3-argumen
dan MENGABAIKAN parameter biaya tersebut tanpa error. Biaya terukur ~30 ms per
derivasi.

**Dua jebakan saat memperbaiki alert kelas ini** (keduanya menghilangkan alert
TANPA memperbaiki apa pun — security theater):

1. **Rename**. Karena FP-1 membuktikan CodeQL memakai heuristik nama, mengganti
   `input.owner.password` → `input.owner.secret` akan MEMBUNGKAM alert sambil
   meninggalkan oracle-nya utuh. Jangan.
2. **Buang password dari hash**. Juga membungkam alert, tapi menukar oracle
   dengan lubang korektness: retry dengan `Idempotency-Key` sama tapi password
   BERBEDA akan dijawab replay 201 asli, sehingga pemanggil percaya password
   barunya berlaku padahal tidak.

**Aturan triase yang diturunkan**: untuk `js/insufficient-password-hash`,
tentukan dulu apakah sumbernya **password pilihan manusia** atau **nilai random
256-bit / DTO tanpa field password**. Kalau yang pertama DAN hasilnya
dipersist, anggap TRUE POSITIVE sampai terbukti sebaliknya. Sapu kelasnya
(`grep -rn "createHash(" --include=*.ts src scripts`) — per 2026-07-25 semua
call site lain berisi checksum konten, JSON kanonik, atau token CSPRNG, jadi
ini satu-satunya instance.

**Red-verification wajib**: test yang hanya mengecek "menghasilkan hash" tetap
hijau terhadap versi rentan. Yang mengunci properti sebenarnya adalah test
**ketergantungan pepper** — hitung hash, ganti `process.env.AUTH_JWT_SECRET`,
lalu assert hasilnya berubah. Test itu gagal untuk derivasi tak-berkunci MAUPUN
untuk password yang dibuang, terlepas dari penamaan field. Lihat
`tests/unit/tenant-provisioning-owner-secret-commitment.test.ts` (tiga mutasi
sudah diverifikasi merah). Hati-hati: assertion "hasilnya != formula pra-fix"
saja TIDAK cukup — ia juga lolos hanya karena nama field JSON berubah.

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

### 4. `js/insufficient-password-hash` dan `js/clear-text-logging` — dismiss resmi tanpa reformulasi kode (Issue #614)

Ditemukan 2026-07-09 (alert #16, #17, #18), diinvestigasi dan di-dismiss
2026-07-10. Berbeda dari pattern #1-#3 di atas (semua diperbaiki dengan
code change), ketiga alert ini di-dismiss resmi lewat API karena
reformulasi kode yang wajar tidak tersedia tanpa mengorbankan tujuan
sungguhan kode tersebut:

- **Alert #18** (`js/insufficient-password-hash`,
  `src/lib/auth/oauth-state-token.ts:30`): CodeQL menandai return value
  `generateOAuthState()`/`parseOAuthStateParam()` yang mengalir ke
  `hashOAuthState`'s sha256 sebagai "password". BUKAN heuristik nama fungsi
  (pattern #1) — nama fungsi ini sama sekali tidak mengandung substring
  "password", jadi trigger mechanism-nya berbeda dan tidak sepenuhnya
  dikonfirmasi. Tapi argumen keamanannya independen dan kokoh:
  `generateOAuthState()` mengembalikan `randomBytes(32).toString("base64url")`
  — nilai CSPRNG 256-bit, BUKAN input user/password. `hashOAuthState`
  memakai bentuk fast-hash-with-prefix (`sha256:<hex>`) yang PERSIS sama
  dengan tiga file token lain yang TIDAK di-flag (`session-token.ts`'s
  `hashSessionToken`, `password-reset-token.ts`'s `hashResetToken`,
  `mfa-challenge-token.ts`'s `hashChallengeToken`) — alasan yang sama
  berlaku: hash lambat (bcrypt/argon2/scrypt) hanya menambah biaya
  verifikasi tanpa manfaat keamanan nyata untuk nilai random 256-bit yang
  mustahil di-brute-force offline berapa pun kecepatan hash-nya. Mencoba
  rename tanpa tahu trigger mechanism pastinya berisiko sia-sia (CI cycle
  terbuang tanpa kepastian fix), jadi dismiss dipilih dengan bukti
  keamanan independen sebagai justifikasi, bukan sekadar asumsi "sama
  seperti pattern #1".
- **Alert #16, #17** (`js/clear-text-logging`, `scripts/validate-env.ts` — the
  `EnvCheckResult` printer near the end of `config:validate`'s CLI output
  block, NOT a fixed line number; line numbers in this file drift as the
  script grows, describe by function/context instead of re-citing a line):
  CodeQL menandai `console.log` yang mem-print `EnvCheckResult.name`/`.detail`
  sebagai membocorkan `AUTH_MFA_REQUIRED_WHEN_ENABLED` (array konstan berisi
  NAMA var, isinya `["AUTH_MFA_SECRET_ENCRYPTION_KEY"]`) secara clear-text.
  Diverifikasi langsung dari `checkMfaConfig`: yang benar-benar mengalir ke
  `console.log` hanya STRING LITERAL nama var (`name`, mis.
  `"AUTH_MFA_SECRET_ENCRYPTION_KEY"`) dan teks statis (`"is set."`, `"is
missing or empty."`, dst) — nilai asli `env[name]` (secret sungguhan)
  HANYA pernah dipakai di dalam predikat boolean (`isSet(env[name])`,
  `isMfaEncryptionKeyWellFormed(env)`), tidak pernah masuk ke variabel yang
  di-log. Reformulasi kode tidak masuk akal di sini karena tujuan
  `console.log` ini MEMANG untuk memberi tahu operator var mana yang hilang
  saat `bun run config:validate` gagal — menghapus nama var dari pesan
  error menghancurkan kegunaan tool ini untuk operator.

**Pencegahan**: kalau menemukan alert serupa (nama VAR/konstanta config
di-flag sebagai "sensitive data" padahal yang di-log cuma label/nama, bukan
nilai), verifikasi eksplisit dengan membaca SETIAP jalur data yang
benar-benar sampai ke sink (console.log/hash call) sebelum memutuskan
dismiss — jangan asumsikan dari nama alert saja. Simpan bukti konkret di
`dismissed_comment` (API `PATCH .../code-scanning/alerts/<N>`, `dismissed_reason`
harus persis `"false positive"`/`"won't fix"`/`"used in tests"` dengan spasi,
BUKAN `false_positive` dengan underscore — API menolak keduanya kalau
salah format; `dismissed_comment` dibatasi 280 karakter, taruh alasan
lengkap di skill ini, bukan di comment).

### 5. `js/implicit-operand-conversion` — Bun.SQL tagged template dengan argumen yang provably-always-`null`

Ditemukan 2026-07-14 (alert #48, #49), Issue #788: dua instance pada baris
yang sama, `business-scope-facts.ts:59`
(`AND (${excludeAssignmentId}::uuid IS NULL OR id <> ${excludeAssignmentId})`
di dalam `` tx`...` ``, sebuah Bun.SQL tagged template). CodeQL menganggap
`${excludeAssignmentId}` di-stringify seperti template literal biasa
(`` `${null}` `` → `"null"`), padahal **tagged template TIDAK melakukan
implicit toString** — nilai substitusi diteruskan mentah ke fungsi tag
(`tx`), yang mem-bind-nya sebagai parameter SQL asli (`NULL` sungguhan,
bukan string `"null"`). CodeQL hanya menandai baris ini karena satu-satunya
call site `fetchActiveAssignmentRows` (fungsi privat, satu caller) selalu
memanggilnya dengan literal `null` — dataflow-nya "provably always null" di
sini, tapi konversi implisit yang dituduh tetap tidak pernah terjadi
(bukan soal apakah nilainya null, tapi bukan JS's implicit-toString sama
sekali karena tagged template). Bukti definitif false positive: pola
identik persis (`${excludeAssignmentId}::uuid IS NULL OR bsa.id <>
${excludeAssignmentId}`) ada di baris 186 file yang SAMA (fungsi
`resolveSoDAssignmentFacts`, dipanggil dari 2 caller eksternal — juga
selalu dengan literal `null` di kedua caller saat ini) dan 12+ file lain
di repo memakai pola `${x ?? null}::uuid IS NULL OR ...` yang sama —
semuanya tidak di-flag CodeQL. Ini murni artefak heuristik per-call-site,
bukan sinyal bug sistematis.

**Fix**: dismiss resmi (bukan reformulasi) — reformulasi kode (mis. cabang
if/else terpisah untuk null vs non-null) hanya menambah kompleksitas nyata
untuk kode yang sudah benar dan konsisten dengan 12+ file lain di repo.

**Pencegahan**: kalau CodeQL menandai `js/implicit-operand-conversion` pada
sebuah `` tx`...${x}...` `` (Bun.SQL/postgres.js tagged template), cek dulu
apakah ekspresi itu benar-benar di dalam tagged template (bukan
concatenation string biasa) — kalau ya, implicit-toString tidak pernah
terjadi secara runtime, dan alert ini adalah false positive berbasis
pola string-interpolation generik yang tidak paham parameter binding SQL
client library. Cari pola identik di file lain sebagai bukti sebelum
dismiss.

### (USANG — ADR-0024) `js/trivial-conditional` build-time extension seam

**Entri ini TIDAK berlaku lagi — jangan hitung sebagai false-positive aktif.**
Dulu (alert #44, Issue #788) mendokumentasikan `js/trivial-conditional` di
`scripts/validate-module-composition.ts:41` atas `applicationModuleRegistry`
(diimpor dari `src/modules/application-registry.ts`) yang SELALU `undefined` di
base — sebuah _build-time extension seam_ jalur aplikasi-turunan. ADR-0024
**MENGHAPUS** seluruh jalur itu: `application-registry.ts`, `extension-check.ts`,
dan seam terkait tidak ada lagi di repo, sehingga alert ini tak akan muncul
kembali. Model sekarang: kontribusi = tambah modul domain LANGSUNG di
`src/modules/` (tidak ada nilai seam yang sengaja `undefined`). Dipertahankan
hanya sebagai catatan historis agar tidak diinvestigasi ulang sebagai FP baru.

### Pola tambahan: `js/unused-local-variable` di test kadang menandai coverage gap, bukan sekadar dead code

Dari 11 alert `js/unused-local-variable` di Issue #788 (semua di file
test), 8 memang leftover import/variable murni (aman dihapus). Tapi 3
adalah TEST HELPER YANG DITULIS DENGAN BENAR tapi tidak pernah dipanggil
— masing-masing menunjuk ke satu jalur test yang seharusnya ada tapi
hilang:

- `createCategoryTerm` (`news-portal-homepage-sections.integration.test.ts`)
  — hanya ada test REJECT untuk `category_grid` (categorySlug tidak ada),
  tidak ada test ACCEPT (categorySlug valid) — helper-nya sudah ditulis
  lengkap, cuma tidak pernah dipanggil dari sebuah test.
- Destructured `has` di test "stale orphaned ... gets its R2 object
  deleted" (`news-media-r2-reconciliation-job.integration.test.ts`) — judul
  test menjanjikan verifikasi penghapusan objek R2 tapi body hanya mengecek
  counter (`result.staleOrphaned.deleted`) dan status DB, tidak pernah
  memanggil `has(key)` untuk membuktikan objeknya benar-benar hilang dari
  R2 (dan tidak pernah `put()` objeknya lebih dulu).
- `resolveLinkedInApiVersion` (`linkedin-provider-config.test.ts`) — semua
  fungsi lain yang diexport modul itu punya `describe` block sendiri,
  hanya fungsi ini yang diimpor tapi tidak pernah diuji langsung.

**Aturan triase**: sebelum menghapus binding `js/unused-local-variable` di
file test, cek APAKAH nama binding itu match sebuah kapabilitas/skenario
yang disebut di judul test lain, docstring file, atau nama fungsi lain di
modul yang sama — kalau ya, kemungkinan besar itu coverage gap (helper
ditulis untuk test yang lalu terlupa/terpotong), bukan dead code murni.
Wire ke assertion baru yang sesuai (menutup gap SEKALIGUS menghilangkan
alert) alih-alih sekadar menghapus.

## Verifikasi

- `gh pr checks <PR>` — tunggu CodeQL selesai (jangan asumsikan pending = akan pass).
- Alert yang sudah diperbaiki otomatis pindah ke state `fixed` di halaman code-scanning pada run berikutnya di `main` — tidak perlu dismiss manual kalau memang sudah tidak muncul lagi.
- `bun run check` tetap harus hijau — perbaikan CodeQL tidak boleh mengubah perilaku runtime (lihat test yang sudah ada untuk fungsi yang diubah).

## Skill terkait

`awcms-mini-security-review` (checklist keamanan modul, bukan tooling scan), `awcms-mini-pr-review` (proses review PR secara umum).
