# Bagian 5 — OpenAPI dan AsyncAPI Base

## Tujuan

Baseline kontrak API dan domain event base. **Semua API baru wajib diperbarui di `openapi/`; semua event baru wajib diperbarui di `asyncapi/`.** Konsistensi kontrak ↔ registry modul dijaga `bun run api:spec:check`.

## File kontrak

| File                                              | Isi                                              |
| ------------------------------------------------- | ------------------------------------------------ |
| `openapi/awcms-mini-public-api.openapi.yaml`      | Kontrak REST base (`/api/v1`)                    |
| `asyncapi/awcms-mini-domain-events.asyncapi.yaml` | Kontrak domain event base                        |
| `openapi/modules/*.openapi.yaml`                  | Kontrak modul domain aplikasi turunan (konvensi) |

## Standard API

Base path `/api/v1`. Envelope response (diimplementasi `_shared/api-response.ts`):

```json
{
  "success": true,
  "data": {},
  "meta": { "correlationId": "corr_...", "requestId": "req_..." }
}
```

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Data tidak valid.",
    "details": [],
    "correlationId": "corr_..."
  }
}
```

## Header standard (konstanta `_shared/tenant-context.ts`)

| Header              | Wajib                       | Fungsi         |
| ------------------- | --------------------------- | -------------- |
| `Authorization`     | Ya kecuali public           | Bearer token   |
| `X-AWCMS-Tenant-ID` | Ya untuk API tenant-scoped  | Tenant aktif   |
| `Idempotency-Key`   | Ya untuk mutation high-risk | Anti duplicate |
| `X-Correlation-ID`  | Opsional                    | Trace request  |
| `X-Request-ID`      | Opsional                    | Trace client   |
| `Accept-Language`   | Opsional                    | Locale         |
| `X-AWCMS-Node-ID`   | Ya untuk sync               | Sync node      |
| `X-AWCMS-Timestamp` | Ya untuk signed sync        | Anti replay    |
| `X-AWCMS-Signature` | Ya untuk sync               | HMAC signature |

## Error code standard

Sumber tunggal `_shared/api-error.ts` (tabel lengkap di doc 03).

## Endpoint base

### Terimplementasi

| Method | Endpoint                | Fungsi                  |
| ------ | ----------------------- | ----------------------- |
| GET    | `/health`               | Health check            |
| GET    | `/database/pool/health` | Kesehatan pool database |

### Kontrak berikutnya (skeleton modul, doc 03)

| Modul            | Endpoint                                                                             |
| ---------------- | ------------------------------------------------------------------------------------ |
| tenant_admin     | `/setup/status`, `/setup/initialize`, `/tenants/current`, `/offices`                 |
| identity_access  | `/auth/login                                                                         | logout | me`, `/access/modules | evaluate   | assignments | decision-logs` |
| profile_identity | `/profiles`, `/profiles/resolve`, `/profiles/{id}/links`, `/profiles/merge-requests` |
| observability    | `/logs/recent                                                                        | audit  | security`             |
| workflow         | `/workflow/tasks`, `/workflow/tasks/{id}/decision`                                   |
| security         | `/security/go-live-gates/evaluate`                                                   |
| sync (opsional)  | `/sync/push                                                                          | pull   | status                | conflicts` |

Endpoint wajib idempotency pada base: `POST /setup/initialize`, `POST /profiles/resolve`, `POST /profiles/{id}/links`, `POST /profiles/merge-requests`, `POST /access/assignments`, `POST /workflow/tasks/{id}/decision`, `POST /sync/push`.

## AsyncAPI event envelope

Diimplementasi `_shared/domain-event.ts` (`createDomainEvent`) — lihat schema `DomainEventEnvelope` di file AsyncAPI. Event **tidak boleh membawa raw sensitive data**.

## Event base terdaftar

| Event                       | Producer                      |
| --------------------------- | ----------------------------- |
| `tenant.created`            | tenant_admin                  |
| `tenant.office.updated`     | tenant_admin                  |
| `identity.login.succeeded`  | identity_access               |
| `identity.login.failed`     | identity_access               |
| `access.assignment.changed` | identity_access               |
| `profile.created`           | profile_identity              |
| `profile.merged`            | profile_identity              |
| `security.event.recorded`   | observability_logging         |
| `database.pool.saturated`   | database_connectivity         |
| `workflow.task.approved`    | workflow_approval             |
| `workflow.task.rejected`    | workflow_approval             |
| `sync.conflict.detected`    | sync_storage                  |
| `security.golive.blocked`   | production_security_readiness |

`api:spec:check` memastikan setiap `publishes` pada module descriptor terdaftar sebagai channel AsyncAPI — event baru tanpa kontrak akan gagal CI.

## Contract testing requirement

- `bun run api:contract:test` memverifikasi envelope endpoint publik terhadap server berjalan.
- Setiap endpoint baru menambah case contract test + entri OpenAPI + (bila high-risk) daftar idempotency.
- Tenant-scoped API wajib tenant header; sensitive fields tidak tampil penuh.
