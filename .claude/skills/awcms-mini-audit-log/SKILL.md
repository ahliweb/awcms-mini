---
name: awcms-mini-audit-log
description: Tulis audit log untuk aksi high-risk AWCMS-Mini dengan redaction. Gunakan pada login, setup initialize, access assignment, profile resolve/merge, workflow decision, sync conflict resolution, dan security readiness decision; aplikasi domain menambah aksinya sendiri (posting, adjustment, export, dsb.). Sesuai doc 03 & 10.
---

# AWCMS-Mini — Audit Log (High-Risk)

Ikuti `docs/awcms-mini/03_srs_detail_per_modul.md` dan `docs/awcms-mini/10_template_kode_coding_standard.md`.

## Bentuk input

```ts
type AuditEventInput = {
  tenantId: string;
  actorTenantUserId?: string;
  moduleKey: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  severity?: "info"|"warning"|"critical";
  message: string;
  attributes?: Record<string, unknown>; // WAJIB sudah diredaksi
  correlationId?: string;
};
```

## Aksi yang WAJIB diaudit

Base: login failed/success · setup initialize · access assignment · profile resolve/link/merge · workflow decision · sync conflict resolution · security readiness decision. Aplikasi domain menambah daftar high-risk-nya (mis. AWPOS: posting, cancel/return, adjustment, transfer, export).

## Aturan

1. Audit **tenant-scoped** (`tenant_id`), tulis ke `awcms_audit_events`.
2. **Redaksi dulu** attributes — jangan pernah masukkan: password, token, API key, `authorization`, NPWP/NIK penuh, phone/WhatsApp/email penuh, token akses apa pun.
3. Audit **melengkapi**, bukan menggantikan, domain event & structured log.
4. Sertakan `correlationId` untuk trace.
5. Untuk denial high-risk, koordinasikan dengan decision log (`awcms-mini-abac-guard`).

## Redaction keys

`password`, `passwordHash`, `token`, `accessToken`, `refreshToken`, `apiKey`, `secret`, `authorization`, `npwp`, `nik`, `phone`, `whatsapp`, `email`.

## Verifikasi

- Aksi high-risk menghasilkan satu audit event.
- Tidak ada secret/PII mentah di kolom attributes.
- Retention audit: 1–5 tahun sesuai kebutuhan.
