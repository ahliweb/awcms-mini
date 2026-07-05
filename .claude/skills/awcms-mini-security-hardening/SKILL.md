---
name: awcms-mini-security-hardening
description: Audit keamanan berbasis standar (OWASP Top 10, OWASP ASVS, ISO/IEC 27001 Annex A) untuk AWCMS-Mini. Gunakan saat diminta "security hardening", audit OWASP/ASVS/ISO, penilaian kepatuhan, atau pengerasan menjelang go-live/audit eksternal. Berbeda dari awcms-mini-security-review (checklist DoD per modul) — skill ini memetakan kontrol ke kerangka standar industri.
---

# AWCMS-Mini — Security Hardening (OWASP / ASVS / ISO)

Sumber kebenaran: **`docs/awcms-mini/20_threat_model_security_architecture.md`** (STRIDE, kontrol berlapis, trust boundary), **`docs/awcms-mini/10_template_kode_coding_standard.md`** (guardrail), dan **`docs/awcms-mini/13_final_master_index_traceability.md`** (matrix kontrol). Skill ini **memetakan** kontrol proyek ke kerangka standar; pakai bersama `awcms-mini-security-review` (checklist per modul) dan subagent `awcms-mini-security-auditor`.

## OWASP Top 10 (2021) → kontrol di base

| #   | Kategori                       | Cek utama di AWCMS-Mini                                                                                                                                                                                                               |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01 | Broken Access Control          | ABAC default-deny + deny-overrides (ADR-0004); RLS `ENABLE`+`FORCE` (ADR-0003); DB role non-superuser; `WHERE id=<tenant>` eksplisit pada tabel RLS-free (`awcms_mini_tenants`); IDOR — cek tiap resource difilter tenant/kepemilikan |
| A02 | Cryptographic Failures         | Password argon2id (`Bun.password`); token sesi opaque (hanya hash disimpan); identifier sensitif `value_hash`+`masked_value`; HTTPS di produksi; cookie `HttpOnly`/`Secure`/`SameSite`                                                |
| A03 | Injection                      | Query hanya via tagged template parametrik `Bun.SQL` (tak ada string-concat SQL); `tx.unsafe`/`SET LOCAL` hanya untuk nilai tervalidasi (`assertUuid`); validasi input tiap endpoint; output encoding (Astro auto-escape)             |
| A04 | Insecure Design                | Threat model doc 20; immutability posted; idempotency; self-approval ditolak; fail-closed default (GUC tenant zero-UUID)                                                                                                              |
| A05 | Security Misconfiguration      | Secret hanya env; `.env` gitignored; CI menolak `.env`; `security:readiness` memblokir go-live (RLS FORCE, role bukan superuser); error tanpa stack trace                                                                             |
| A06 | Vulnerable Components          | Bun-only (ADR-0002); Dependabot; lockfile terkunci; minim dependency                                                                                                                                                                  |
| A07 | Identification & Auth Failures | Login lockout setelah N gagal; pesan generik anti-enumeration; TTL sesi; revoke saat logout                                                                                                                                           |
| A08 | Software & Data Integrity      | Checksum file sync/objek/backup; audit append-only; CodeQL; migration checksum                                                                                                                                                        |
| A09 | Logging & Monitoring Failures  | Audit high-risk + decision log + correlation ID; log terstruktur; **redaksi** secret/PII wajib sebelum log                                                                                                                            |
| A10 | SSRF                           | URL provider dari env tepercaya, bukan input user; provider di luar transaksi (ADR-0006)                                                                                                                                              |

## OWASP ASVS (L1/L2 relevan)

- [ ] **V2 Auth** — hashing modern, lockout, session fixation dicegah (token baru saat login), logout mencabut sesi.
- [ ] **V3 Session** — cookie `HttpOnly`+`SameSite=Lax`+`Secure` (prod); token opaque server-side; expiry.
- [ ] **V4 Access Control** — default deny, cek per-request (bukan sekali), RLS defense-in-depth, tak ada IDOR.
- [ ] **V5 Validation/Encoding** — validasi tiap input, output encoding, CSRF via Astro `checkOrigin` (wajib `Content-Type` pada mutation).
- [ ] **V7 Error/Logging** — error aman tanpa detail internal; log tanpa data sensitif.
- [ ] **V9 Communications** — TLS di produksi; HMAC untuk kanal mesin-ke-mesin (sync).
- [ ] **V12 Files** — checksum diverifikasi; path/objek tak dari input tak tepercaya.

## ISO/IEC 27001:2022 Annex A (kontrol yang relevan ke kode)

A.5.15 access control · A.5.17 authentication info · A.8.2 privileged access (DB role least-privilege) · A.8.5 secure authentication · A.8.12 data leakage prevention (masking/redaction) · A.8.15 logging · A.8.16 monitoring · A.8.24 cryptography · A.8.28 secure coding (guardrail doc 10) · A.8.31 separation of environments. Sisanya (kebijakan, personel, fisik) di luar cakupan kode base.

## Cara kerja

1. Petakan tiap item ke bukti nyata di repo (query DB, panggilan fungsi domain, grep file) — **bukan** asumsi; pola sama seperti `scripts/security-readiness.ts`.
2. Tandai: terpenuhi / gap / di luar scope base. Temuan **critical** memblokir go-live.
3. Prioritaskan gap berdasarkan dampak (STRIDE/EoP & Info-disclosure paling tinggi).

## Output

Matrix kepatuhan (kategori → status → bukti/lokasi → remediasi) + daftar temuan berperingkat critical→low + saran patch. Jalankan `bun run security:readiness` sebagai gate objektif.

## Skill terkait

`awcms-mini-security-review` (checklist DoD per modul), `awcms-mini-abac-guard`, `awcms-mini-audit-log`, `awcms-mini-sensitive-data`, `awcms-mini-sync-hmac`, `awcms-mini-production-preflight`; subagent `awcms-mini-security-auditor`.
