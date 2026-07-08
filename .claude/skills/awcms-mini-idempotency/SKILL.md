---
name: awcms-mini-idempotency
description: Terapkan idempotency pada mutation high-risk AWCMS-Mini agar aman dari double-submit. Gunakan saat implementasi posting transaksi, cancel/return, transfer approve/ship/receive, cycle count, adjustment, VAT generate, Coretax batch, receipt send, sync push, atau workflow decision. Sesuai doc 10.
---

# AWCMS-Mini — Idempotent High-Risk Mutation

Ikuti `docs/awcms-mini/10_template_kode_coding_standard.md`.

## Alur

```mermaid
flowchart TD
  A[Baca Idempotency-Key header] --> B{Key ada di awcms_mini_idempotency_keys?}
  B -- Tidak --> C[Hitung request hash stabil] --> D[Jalankan mutation dalam transaction] --> E[Simpan key + hash + response/resource] --> F[Return response]
  B -- Ya --> G{hash sama?}
  G -- Ya --> H[Return response tersimpan]
  G -- Tidak --> I[409 IDEMPOTENCY_CONFLICT]
```

## Aturan

1. Header `Idempotency-Key` **wajib**; jika kosong → `400 IDEMPOTENCY_REQUIRED`.
2. Request hash stabil dari body ternormalisasi (urutan field konsisten).
3. Key sama + hash sama → replay response tersimpan (aman).
4. Key sama + hash beda → `409 IDEMPOTENCY_CONFLICT`.
5. Simpan status/resource hasil mutation di `awcms_mini_idempotency_keys`.
6. Kombinasikan dengan stock lock (`SELECT ... FOR UPDATE`) & transaction wrapper.
7. Deadlock retry harus aman karena idempotency.
8. Retention key: 7–30 hari.

## Endpoint wajib idempotency

POS posting, cancel/return, `profiles/resolve|links|merge-requests`, warehouse transfer approve/ship/receive, cycle-count, stock-adjustment, VAT invoice generate, Coretax batch, receipt send, sync push, workflow decision, blog post lifecycle actions (`blog_post_publish`/`_schedule`/`_archive`/`_restore`/`_purge`, `blog_revision_restore` — Issue #538/#541), `POST /api/v1/email/announcements` (Issue #497). Daftar ini tumbuh per modul baru — cek skill modul terkait (mis. `awcms-mini-blog-content`, `awcms-mini-email`) untuk endpoint idempotency-gated terbaru, jangan asumsikan daftar di atas lengkap.

## Verifikasi (test)

- Same key + same request → satu resource, response konsisten.
- Same key + different request → `409`.
- Double submit paralel → tidak dobel.
- Rollback saat error → tidak ada partial state.
