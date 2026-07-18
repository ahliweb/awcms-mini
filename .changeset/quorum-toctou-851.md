---
"awcms-mini": patch
---

Perbaiki bug keamanan quorum-`all` bypass pada `POST /api/v1/workflows/tasks/{id}/decisions` (Issue #851, spin-off epic #818).

Satu approver yang di-assign ke task ber-quorum `all` bisa memenuhi quorum SENDIRIAN dengan mengirim dua approve konkuren ber-`Idempotency-Key` berbeda (READ COMMITTED TOCTOU): `findEligibleAssignment` membaca assignment tanpa row lock, `recordWorkflowTaskDecision` meng-`UPDATE` assignment ke `decided` tanpa predikat `status = 'pending'`, dan tabel `awcms_mini_workflow_decisions` tidak punya unique constraint per decider. Dua transaksi konkuren sama-sama melihat `pending`, sama-sama mencatat decision, dan instance berpindah ke `approved`.

Perbaikan berlapis:

- `findEligibleAssignment` kini `SELECT ... ORDER BY id FOR UPDATE` pada baris assignment task (blocking wait, urutan lock deterministik anti-deadlock) — request kedua menunggu request pertama commit, membaca ulang status `decided`, lalu dilaporkan tidak eligible (403).
- `UPDATE ... SET status = 'decided'` kini bersyarat `AND status = 'pending'` (menolak transisi ganda).
- Migration `078` menambah partial UNIQUE index `awcms_mini_workflow_decisions (tenant_id, workflow_task_id, decided_by_tenant_user_id) WHERE is_administrative_override = false` — satu suara ordinari per decider per task (administrative override sengaja dikecualikan). Juga menutup varian sekuensial di mana satu user adalah assignee langsung sekaligus delegate assignee lain pada task yang sama.
- Duplikat konkuren/sekuensial dipetakan ke `409 IDEMPOTENCY_CONFLICT` via `WorkflowTaskDecisionConflictError`, bukan `500`. Replay `Idempotency-Key` yang sama tetap bekerja seperti sebelumnya.
