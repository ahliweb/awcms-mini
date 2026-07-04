---
name: awpos-implement-issue
description: Kerjakan satu issue/sprint AWPOS secara atomic dari awal sampai laporan. Gunakan saat diminta "implementasikan Issue X.Y", "kerjakan Sprint N", "buat fitur <modul>", atau saat memulai unit kerja AWPOS apa pun. Orkestrator yang memanggil skill AWPOS lain (migration, endpoint, event, idempotency, abac, audit) sesuai kebutuhan.
---

# AWPOS — Implement Issue / Sprint (Atomic)

Skill orkestrator untuk mengeksekusi satu unit kerja AWPOS end-to-end sesuai kontrak di `AGENTS.md` dan `docs/awpos/12_generator_prompt.md`.

## Prasyarat baca (WAJIB sebelum edit)

1. `AGENTS.md` — aturan wajib & guardrail.
2. `docs/awpos/06_github_issues_detail.md` — detail issue.
3. `docs/awpos/11_implementation_blueprint.md` — folder/file target sprint.
4. Modul, SQL, OpenAPI, AsyncAPI, dan docs yang terkait scope.

## Prosedur

```mermaid
flowchart TD
  A[Baca docs + kode terkait] --> B{Scope jelas & atomic?}
  B -- Tidak --> C[Pecah / klarifikasi]
  B -- Ya --> D[Implementasi minimal]
  D --> E{Schema berubah?} -->|Ya| M[awpos-new-migration]
  D --> F{API berubah?} -->|Ya| P[awpos-new-endpoint]
  D --> G{Event berubah?} -->|Ya| V[awpos-new-event]
  D --> H{Mutation high-risk?} -->|Ya| I[awpos-idempotency + awpos-audit-log]
  M & P & V & I --> T[awpos-testing]
  T --> Q[Validasi: db:migrate · api:spec:check · test · build]
  Q --> R[Update docs + laporan implementasi]
```

## Aturan atomic

- Kerjakan hanya scope issue; **jangan** sentuh file unrelated.
- Data tenant-scoped: tenant context + `awpos-abac-guard` + RLS.
- Data sensitif: `awpos-sensitive-data`.
- High-risk action: `awpos-audit-log`; high-risk mutation: `awpos-idempotency`.
- Provider eksternal lewat outbox/queue, **tidak** di dalam DB transaction.

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

`awpos-new-module`, `awpos-new-migration`, `awpos-new-endpoint`, `awpos-new-event`, `awpos-idempotency`, `awpos-abac-guard`, `awpos-audit-log`, `awpos-sensitive-data`, `awpos-testing`, `awpos-security-review`, `awpos-pr-review`.
