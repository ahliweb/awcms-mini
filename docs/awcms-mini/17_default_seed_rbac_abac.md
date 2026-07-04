# Bagian 17 — Default Seed, RBAC, dan ABAC Policy

## Tujuan

Data awal agar Setup Wizard dan RBAC/ABAC base dapat diimplementasikan konkret: registry module/activity, role default, matriks permission, ABAC default policy, dan seed. Aplikasi domain **menambah** registry/role/policy-nya di atas ini (contoh lengkap: doc 17 AWPOS).

## Model akses

- **RBAC** memberi baseline permission per role (`awcms_roles` → `awcms_role_permissions` → `awcms_permissions`).
- **ABAC** menyaring berdasarkan atribut (`awcms_abac_policies`): **default deny**, **deny overrides allow**; deny high-risk dicatat di `awcms_abac_decision_logs`.
- RLS tetap wajib walau ABAC sudah cek (defense in depth).

```mermaid
flowchart TD
  Req[Access request] --> D0{Ada allow eksplisit?}
  D0 -- Tidak --> Deny[DENY - default]
  D0 -- Ya --> D1{Ada deny policy cocok?}
  D1 -- Ya --> DenyO[DENY - overrides]
  D1 -- Tidak --> Allow[ALLOW]
  Deny --> Log[Decision log bila high-risk]
  DenyO --> Log
```

## Registry module & activity base

| Module key                      | Activity code         | Action tersedia              |
| ------------------------------- | --------------------- | ---------------------------- |
| `tenant_admin`                  | `setup`               | read, create                 |
| `tenant_admin`                  | `office_management`   | read, create, update         |
| `tenant_admin`                  | `settings`            | read, configure              |
| `identity_access`               | `user_management`     | read, create, update, assign |
| `identity_access`               | `access_control`      | read, assign, configure      |
| `profile_identity`              | `profile_management`  | read, create, update         |
| `profile_identity`              | `profile_merge`       | read, approve                |
| `observability_logging`         | `logs`                | read                         |
| `database_connectivity`         | `pool_health`         | read                         |
| `workflow_approval`             | `approval`            | read, approve                |
| `management_reporting`          | `reports`             | read                         |
| `ui_experience`                 | `admin_shell`         | read                         |
| `production_security_readiness` | `go_live`             | read, approve                |
| `sync_storage`                  | `sync`                | read, configure              |
| `sync_storage`                  | `conflict_resolution` | read, approve                |

## Role default base (5 role)

| Role    | Ringkasan akses                                                                |
| ------- | ------------------------------------------------------------------------------ |
| Owner   | Semua module base, termasuk approval, go-live, konfigurasi                     |
| Admin   | Setup/office/settings, user & access, profile, laporan — tanpa go-live approve |
| Manager | Approval workflow + merge; baca laporan/profil                                 |
| Staff   | Baca profil & laporan sesuai penugasan; tanpa access control                   |
| Auditor | Read-only: logs, decision log, laporan, konfigurasi akses                      |

Aplikasi domain menambah role spesifiknya (mis. Kasir, Petugas Gudang, Tax Officer di AWPOS).

## Matriks role → permission base

Legenda: R=read, C=create, U=update, A=approve, G=assign, F=configure.

| Module.activity                       | Owner | Admin | Manager | Staff | Auditor |
| ------------------------------------- | ----- | ----- | ------- | ----- | ------- |
| tenant_admin.setup                    | RC    | RC    | –       | –     | R       |
| tenant_admin.office_management        | RCU   | RCU   | R       | –     | R       |
| tenant_admin.settings                 | RF    | RF    | –       | –     | R       |
| identity_access.user_management       | RCUG  | RCUG  | –       | –     | R       |
| identity_access.access_control        | RGF   | RGF   | –       | –     | R       |
| profile_identity.profile_management   | RCU   | RCU   | R       | R     | R       |
| profile_identity.profile_merge        | RA    | R     | RA      | –     | R       |
| observability_logging.logs            | R     | R     | –       | –     | R       |
| database_connectivity.pool_health     | R     | R     | –       | –     | R       |
| workflow_approval.approval            | RA    | R     | RA      | –     | R       |
| management_reporting.reports          | R     | R     | R       | R     | R       |
| ui_experience.admin_shell             | R     | R     | R       | R     | R       |
| production_security_readiness.go_live | RA    | R     | –       | –     | R       |
| sync_storage.sync                     | RF    | RF    | –       | –     | R       |
| sync_storage.conflict_resolution      | RA    | R     | RA      | –     | R       |

## ABAC default policy base

| #   | Policy           | Efek                                                                       |
| --- | ---------------- | -------------------------------------------------------------------------- |
| 1   | Default          | **Deny** semua yang tidak diizinkan eksplisit                              |
| 2   | Role allow       | Allow sesuai matriks role → permission                                     |
| 3   | Tenant isolation | Deny bila `resource.tenant_id != context.tenantId`                         |
| 4   | Office scope     | Deny bila resource office di luar office user (kecuali role lintas-office) |
| 5   | Self-approval    | Deny bila `approver == requester` pada workflow/merge                      |
| 6   | Sensitive reveal | Deny tampilkan identifier penuh — hanya `masked_value`                     |
| 7   | Go-live guard    | Deny go-live approve bila ada critical finding terbuka                     |

Setiap deny high-risk masuk `awcms_abac_decision_logs`.

## Seed default saat Setup Wizard (idempotent, terkunci setelah sukses)

1. **Tenant** + owner **identity** (scrypt) + **tenant_user** owner.
2. **Office** pertama (`head_office`).
3. **Katalog permission** (registry di atas) + **5 role default** + mapping matriks.
4. **ABAC default policy** (7 policy di atas).
5. **Tenant settings**: `default_locale=id`, `default_theme=system`, timezone `Asia/Jakarta`, semua provider flag off.
6. **Assignment**: owner → role Owner.
7. **Audit**: `tenant.created` + assignment awal; event `tenant.created`.

## Acceptance criteria

- Setup menghasilkan seluruh seed lalu terkunci; tidak bisa dijalankan ulang.
- Evaluator menegakkan default deny & deny overrides allow sesuai matriks & policy.
- Cross-tenant/cross-office ditolak; self-approval ditolak.
- Deny high-risk tercatat di decision log; seed idempotent.
