# `_shared` — Module Contract Layer

Helper lintas modul yang meng-encode standar doc 10 (coding standard) dan doc 05 (kontrak API/event). Semua modul WAJIB memakai helper ini — jangan duplikasi.

| File | Isi |
| --- | --- |
| `module-contract.ts` | `ModuleDescriptor` + validasi struktural |
| `api-response.ts` | Envelope `{ success, data, meta }` / `{ success:false, error }` — `ok/created/fail/toErrorResponse` |
| `api-error.ts` | `ApiError` + katalog error code standard → HTTP status |
| `tenant-context.ts` | `TenantContext` + header standard + trace ID |
| `access.ts` | Kontrak ABAC (`AccessRequest/AccessDecision`), `guardAccess` default-deny |
| `audit.ts` | `AuditEventInput` + `buildAuditEvent` (redaction wajib) |
| `domain-event.ts` | `DomainEventEnvelope` + `createDomainEvent` |
| `idempotency.ts` | Request hash stabil + evaluasi replay/conflict + kontrak store |
| `validation.ts` | Validasi input standard (UUID, enum, string, numeric, unknown field) |

Aturan: `_shared` tidak boleh bergantung pada modul lain (hanya `src/lib`).
