---
"awcms-mini": patch
---

Backfill dedicated high-risk integration coverage untuk Issue #827 (epic #818):
workflow-approval decision endpoint dan integration-hub outbound SSRF guard.
Perubahan tests-only (plus regenerasi `docs/awcms-mini/repo-inventory.md`), tidak
mengubah perilaku runtime.

- `tests/integration/workflow-approval-decision-hardening.integration.test.ts`:
  idempotent replay (respons tersimpan verbatim, tak re-decide, tak dobel-audit),
  isolasi idempotency lintas-resource (bug berulang #750/#795 — hash memuat
  taskId), dan probe konkurensi `test.failing` yang mendokumentasikan quorum-'all'
  bypass NYATA (dilaporkan sebagai #851).
- `tests/integration/integration-hub-ssrf.integration.test.ts`: penolakan SSRF di
  write-time (subscription create ke alamat privat/link-local ditolak 400, tak
  disimpan) dan pertahanan berlapis di dispatch-time (target privat yang lolos
  write-time diblokir sebelum ada HTTP keluar; delivery dead-letter non-retryable).

Tiap assertion penting diverifikasi MERAH via mutation ke kode produksi lalu
dikembalikan. data-exchange tidak disentuh: file 40-blok yang ada sudah menutup
ketiga butir DoD #827 (masking preview #820, formula injection, error impor
parsial), diverifikasi hijau terhadap Postgres nyata.
