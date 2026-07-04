---
name: awcms-mini-implement-issue
description: Kerjakan satu issue/sprint AWCMS-Mini secara atomic dari awal sampai laporan. Gunakan saat diminta "implementasikan Issue X.Y", "kerjakan Sprint N", "buat fitur <modul>", atau saat memulai unit kerja AWCMS-Mini apa pun. Orkestrator yang memanggil skill AWCMS-Mini lain (migration, endpoint, event, idempotency, abac, audit) sesuai kebutuhan.
---

# AWCMS-Mini — Implement Issue / Sprint (Atomic)

Skill orkestrator untuk mengeksekusi satu unit kerja AWCMS-Mini end-to-end sesuai kontrak di `AGENTS.md` dan `docs/awcms-mini/12_generator_prompt.md`.

## Prasyarat baca (WAJIB sebelum edit)

1. `AGENTS.md` — aturan wajib & guardrail.
2. `docs/awcms-mini/06_github_issues_detail.md` — detail issue.
3. `docs/awcms-mini/11_implementation_blueprint.md` — folder/file target sprint.
4. Modul, SQL, OpenAPI, AsyncAPI, dan docs yang terkait scope.

## Prosedur

```mermaid
flowchart TD
  A[Baca docs + kode terkait] --> B{Scope jelas & atomic?}
  B -- Tidak --> C[Pecah / klarifikasi]
  B -- Ya --> D[Implementasi minimal]
  D --> E{Schema berubah?} -->|Ya| M[awcms-mini-new-migration]
  D --> F{API berubah?} -->|Ya| P[awcms-mini-new-endpoint]
  D --> G{Event berubah?} -->|Ya| V[awcms-mini-new-event]
  D --> H{Mutation high-risk?} -->|Ya| I[awcms-mini-idempotency + awcms-mini-audit-log]
  M & P & V & I --> T[awcms-mini-testing]
  T --> Q[Validasi: db:migrate · api:spec:check · test · build]
  Q --> R[Update docs + laporan implementasi]
```

## Aturan atomic

- Kerjakan hanya scope issue; **jangan** sentuh file unrelated.
- Data tenant-scoped: tenant context + `awcms-mini-abac-guard` + RLS.
- Data sensitif: `awcms-mini-sensitive-data`.
- High-risk action: `awcms-mini-audit-log`; high-risk mutation: `awcms-mini-idempotency`.
- Resource deletable: soft delete + restore/purge policy; jangan hapus posted/append-only entity.
- Provider eksternal lewat outbox/queue, **tidak** di dalam DB transaction.
- Backend/tooling wajib Bun-only. Jangan menambah Node.js/npm/npx/pnpm/yarn atau adapter server Node.js kecuali Bun belum mendukung capability tersebut, maintainer sudah memberi izin eksplisit, dan pengecualian dicatat di docs/audit.

## Validasi wajib

```bash
bun run db:migrate
bun run api:spec:check
bun test
bun run build
```

## Definition of Done

Ikuti checklist DoD di `AGENTS.md`. Tutup dengan **laporan implementasi**:

```text
Summary:
Files changed:
Commands run:
Test results:
Security notes:
Documentation updates:
Remaining limitations:
Next recommended step:
```

## Skill terkait

`awcms-mini-new-module`, `awcms-mini-new-migration`, `awcms-mini-new-endpoint`, `awcms-mini-new-event`, `awcms-mini-idempotency`, `awcms-mini-abac-guard`, `awcms-mini-audit-log`, `awcms-mini-sensitive-data`, `awcms-mini-testing`, `awcms-mini-security-review`, `awcms-mini-pr-review`.
