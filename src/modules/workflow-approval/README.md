# Modul Workflow Approval (`workflow_approval`)

Approval lintas modul untuk high-risk action: definisi, instance, task, decision; larang self-approval.

> **Status: skeleton (experimental).** Belum production-ready — lihat TODO di bawah.
> Struktur wajib: `module.ts`, `domain/`, `application/`, `infrastructure/`, `api/` (doc 10).

## Endpoint (kontrak doc 05, base path `/api/v1`)

- `GET /api/v1/workflow/tasks`
- `POST /api/v1/workflow/tasks/{id}/decision`

## Tabel yang dimiliki

- `awcms_workflow_definitions (rencana)`
- `awcms_workflow_instances (rencana)`
- `awcms_workflow_tasks (rencana)`
- `awcms_workflow_decisions (rencana)`

## Aturan wajib

- Route tipis -> ABAC guard -> validasi -> service -> repository (doc 10).
- Data tenant-scoped: tenant context + filter `tenant_id` + RLS (doc 16).
- High-risk action: audit + (bila mutation) Idempotency-Key.
- Data sensitif dimask/redact sebelum keluar (mapper safe DTO).

## TODO implementasi

- [ ] Schema workflow (migration baru saat diimplementasi)
- [ ] Decision idempotent (Idempotency-Key) + deny self-approval (ABAC policy 7)
