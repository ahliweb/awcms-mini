---
name: awcms-mini-security-review
description: Jalankan security review modul AWCMS-Mini terhadap checklist keamanan. Gunakan sebelum merge modul sensitif atau saat diminta "security review <modul>". Memeriksa secret, auth, tenant/ABAC/RLS, audit, idempotency, masking, HMAC, dan AI read-only sesuai doc 12.
---

# AWCMS-Mini — Security Review Modul

Ikuti `docs/awcms-mini/12_generator_prompt.md` (Prompt Security Review) dan `docs/awcms-mini/13_final_master_index_traceability.md` (matrix security control).

## Checklist (per modul)

- [ ] Tidak ada hardcoded secret; provider credential dari env.
- [ ] Auth required kecuali endpoint public eksplisit.
- [ ] Tenant context diset; query tenant-scoped filter `tenant_id`.
- [ ] ABAC default deny + deny overrides allow (`awcms-mini-abac-guard`).
- [ ] RLS aktif pada semua tabel tenant-scoped.
- [ ] Audit high-risk tertulis + redaksi (`awcms-mini-audit-log`).
- [ ] Idempotency pada mutation high-risk (`awcms-mini-idempotency`).
- [ ] Soft delete default filter aktif untuk resource deletable; restore/purge berizin, diaudit, dan tidak berlaku pada posted/append-only entity.
- [ ] Data sensitif dimasking (`awcms-mini-sensitive-data`); tidak bocor ke response/log/event.
- [ ] Error aman, tanpa stack trace.
- [ ] Sync HMAC + anti-replay bila modul sync (`awcms-mini-sync-hmac`).
- [ ] AI read-only: no raw SQL, no mutation, no raw PII/tax identity, tool call diaudit.
- [ ] Stock lock (`FOR UPDATE`) & immutable posted transaction bila relevan.
- [ ] Consent dicek sebelum kirim (CRM); receipt token non-sequential.
- [ ] File checksum diverifikasi (sync/R2, tax export).

## Fokus per area

| Area        | Cek utama                                                                    |
| ----------- | ---------------------------------------------------------------------------- |
| Identity    | password hash modern, login lockout, failed login audit                      |
| POS         | idempotency, stock lock, atomic, immutable                                   |
| Tax         | NPWP/NIK/NITKU masked, export approval + audit                               |
| CRM         | consent, provider key env, phone/email masked                                |
| Sync        | HMAC, anti-replay, node inactive ditolak                                     |
| AI          | read-only, safe aggregate views, no raw PII                                  |
| Master data | soft delete hidden by default, restore conflict check, purge retention/legal |

## Perangkap terverifikasi (audit repo 2026-07-17, epic #818)

Kelas cacat yang **benar-benar lolos review** di repo ini. Cek eksplisit ke sini — checklist di atas tidak menangkapnya.

### 1. Default-allow menyamar sebagai default-deny (#820)

```ts
const sensitiveFieldNames = descriptor?.sensitiveFields?.fieldNames ?? [];
let canSeeRawValues = sensitiveFieldNames.length === 0; // [] → true → semua mentah
```

Field deklarasi **opsional** + default `[]` ⇒ **lupa mendeklarasikan = membuka**, bukan menutup. Checklist "ABAC default deny" lolos karena guard terluar ada; yang terbalik adalah default **di dalam** guard.

**Cek**: untuk tiap deklarasi keamanan opsional, tanya "kalau ini tidak diisi, apa yang terjadi?" Jawaban yang benar selalu **tutup**, bukan buka.

### 2. Validator ada tapi tak tersambung (#820, berulang — lih. #769/#740)

`rawValuePermission` divalidasi ketat saat registrasi (format + kewajiban), lalu **nol enforcement site** di seluruh pohon — route memakai konstanta hardcoded. Kontraknya menjanjikan proteksi yang tidak pernah dieksekusi.

**Cek**: telusuri tiap field kontrak keamanan **MUNDUR dari jalur tulis/baca nyata**, jangan maju dari test-nya sendiri. `grep -rn "<namaField>" src/` — kalau hanya muncul di registry + tipe, ia **tidak menegakkan apa pun**.

### 3. Fail-open yang komentarnya mengklaim fail-closed (#820)

```ts
if (!descriptor || !descriptor.requiredPermission) return { allowed: true };
// baris berikutnya: "A malformed ... fails CLOSED, never open"
```

Dua kondisi berbeda digabung satu `||`: "tak ada syarat tambahan" (boleh lolos) vs "descriptor tak ditemukan" (harus tolak). Efek: resource jadi **lebih terbuka setelah modulnya di-disable**.

**Cek**: jangan percaya komentar; baca kondisinya. Pisahkan "tidak ada syarat" dari "tidak bisa diverifikasi".

### 4. Aksi high-risk dengan `recordAuditEvent` diimpor tapi nyaris tak dipanggil (#821)

`auth/login.ts` mengimpor `recordAuditEvent`, memanggilnya **sekali** (`mfa_challenge_issued`) — **login sukses & gagal tidak diaudit**. Tabel "Fokus per area" di atas sudah menuntut "failed login audit" sejak awal; tetap lolos bertahun-tahun.

**Cek**: `grep -c "recordAuditEvent" <file>` lalu bandingkan dengan jumlah aksi high-risk di file itu. Impor ≠ cakupan.

### 5. Asumsi tak ditegakkan pada data sensitif (#820)

`maskSensitiveFields` melewati `naturalKey`, _"which is **assumed** non-sensitive"_ — padahal natural key import profil lazimnya justru email/NIK (itu kunci dedup-nya). Asumsi dalam komentar bukan invarian.

### 6. Idempotency tidak konsisten antar padanan (#822, kelas #795)

`blog/posts/[id]/purge` punya idempotency; `profiles/[id]/purge` (hard DELETE, lebih merusak) **tidak**. Bandingkan endpoint sejenis lintas modul — inkonsistensi = biasanya yang satu terlupa, bukan keputusan.

### Sudah diverifikasi bersih (per 2026-07-17) — jangan audit ulang dari nol

- **RLS**: 129/129 tabel tenant-scoped punya `ENABLE` + `FORCE` + `CREATE POLICY`. Nol ENABLE-tanpa-policy, nol owner-bypass.
- **Auth guard**: 25 dari 289 route tanpa guard ABAC — semuanya public sah (auth pre-session, health, setup wizard, sync HMAC, webhook HMAC). Ada **dua** gaya guard (`authorizeInTransaction` dan `evaluateAccess` inline, sebagian didelegasikan ke service) — grep satu pola saja akan **salah melaporkan ~43 route** sebagai tanpa guard.
- **Masking**: `identifier-directory.ts` tidak pernah menyeleksi `normalized_value`, hanya `masked_value`.
- **Hardcoded secret**: nol; tak ada fallback default pada env secret.

## Catatan scope

Baris **POS / Tax / CRM / AI** pada tabel "Fokus per area" adalah **domain ilustratif** (doc 02) — modul itu **tidak ada** di base repo ini dan ditambahkan aplikasi turunan. Lihat #828. Baris Identity/Sync/Master data berlaku nyata di sini.

## Output

Verdict (Approve / Request changes / Comment) + daftar temuan: critical, security, functional, data/migration, contract, testing gap, docs gap, saran patch. Critical finding **memblokir** go-live.
