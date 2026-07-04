---
name: awpos-audit-log
description: Tulis audit log untuk aksi high-risk AWPOS dengan redaction. Gunakan pada login, access assignment, profile merge, price change, transaction posted/cancel/return, stock adjustment, warehouse transfer, Coretax export, sync conflict resolution, AI tool call, dan security readiness decision. Sesuai doc 03 & 10.
---

# AWPOS — Audit Log (High-Risk)

Ikuti `docs/awpos/03_srs_detail_per_modul.md` dan `docs/awpos/10_template_kode_coding_standard.md`.

## Bentuk input

```ts
type AuditEventInput = {
  tenantId: string;
  actorTenantUserId?: string;
  moduleKey: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  severity?: "info" | "warning" | "critical";
  message: string;
  attributes?: Record<string, unknown>; // WAJIB sudah diredaksi
  correlationId?: string;
};
```

## Aksi yang WAJIB diaudit

Login failed/success · access assignment · profile merge · product price change · transaction posted/cancel/return · stock adjustment · warehouse transfer · Coretax export · sync conflict resolution · AI tool call · security readiness decision.

## Aturan

1. Audit **tenant-scoped** (`tenant_id`), tulis ke `awpos_audit_events`.
2. **Redaksi dulu** attributes — jangan pernah masukkan: password, token, API key, `authorization`, NPWP/NIK penuh, phone/WhatsApp/email penuh, receipt token.
3. Audit **melengkapi**, bukan menggantikan, domain event & structured log.
4. Sertakan `correlationId` untuk trace.
5. Untuk denial high-risk, koordinasikan dengan decision log (`awpos-abac-guard`).

## Redaction keys

`password`, `passwordHash`, `token`, `accessToken`, `refreshToken`, `apiKey`, `secret`, `authorization`, `npwp`, `nik`, `phone`, `whatsapp`, `email`.

## Verifikasi

- Aksi high-risk menghasilkan satu audit event.
- Tidak ada secret/PII mentah di kolom attributes.
- Retention audit: 1–5 tahun sesuai kebutuhan.
