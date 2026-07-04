# Modul Identity & Access (`identity_access`)

Login identity, tenant user, RBAC role/permission, ABAC policy evaluator (default deny), dan decision log.

> **Status: skeleton (experimental).** Belum production-ready — lihat TODO di bawah.
> Struktur wajib: `module.ts`, `domain/`, `application/`, `infrastructure/`, `api/` (doc 10).

## Endpoint (kontrak doc 05, base path `/api/v1`)

- `POST /api/v1/auth/login`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/me`
- `GET /api/v1/access/modules`
- `POST /api/v1/access/evaluate`
- `POST /api/v1/access/assignments`
- `GET /api/v1/access/decision-logs`

## Tabel yang dimiliki

- `awcms_identities`
- `awcms_tenant_users`
- `awcms_roles`
- `awcms_permissions`
- `awcms_role_permissions`
- `awcms_tenant_user_roles`
- `awcms_abac_policies`
- `awcms_abac_decision_logs`

## Aturan wajib

- Route tipis -> ABAC guard -> validasi -> service -> repository (doc 10).
- Data tenant-scoped: tenant context + filter `tenant_id` + RLS (doc 16).
- High-risk action: audit + (bila mutation) Idempotency-Key.
- Data sensitif dimask/redact sebelum keluar (mapper safe DTO).

## TODO implementasi

- [ ] Implement evaluator ABAC: default deny, deny overrides allow, decision log (doc 17)
- [ ] Implement login + lockout (AUTH_LOGIN_MAX_ATTEMPTS) + audit
- [ ] Auth middleware: token -> TenantContext tervalidasi
