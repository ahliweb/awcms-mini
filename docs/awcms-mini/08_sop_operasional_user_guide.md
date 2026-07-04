# Bagian 8 — SOP Operasional dan User Guide

## Setup development

```bash
git clone <repo> && cd awcms-mini
bun install
docker compose up -d postgres        # PostgreSQL lokal (port 5432)
cp .env.example .env                 # sesuaikan DATABASE_URL bila perlu
bun run db:migrate
bun run dev                          # http://localhost:4321
```

Verifikasi: `curl http://localhost:4321/api/v1/health` → `{ "success": true, ... }`.

## Perintah operasional harian

| Perintah                          | Fungsi                                    |
| --------------------------------- | ----------------------------------------- |
| `bun run dev` / `build` / `start` | Dev server / build / jalankan hasil build |
| `bun run db:migrate`              | Terapkan migration pending                |
| `bun run db:migrate:status`       | Status applied/pending/drift              |
| `bun run db:pool:health`          | Kesehatan koneksi database                |
| `bun test`                        | Seluruh unit test                         |
| `bun run api:spec:check`          | Validasi kontrak OpenAPI/AsyncAPI         |
| `bun run api:contract:test`       | Contract test terhadap server berjalan    |
| `bun run security:readiness`      | Pemeriksaan keamanan statis               |
| `bun run production:preflight`    | Seluruh checklist pre-deploy              |

## SOP deploy

1. Pastikan branch release lolos `bun run production:preflight` (gunakan `PREFLIGHT_SKIP_DB=1` hanya di CI tanpa DB).
2. Backup database (lihat di bawah) **sebelum** migration production.
3. `bun run db:migrate` → `bun run build` → restart service (`deploy/systemd`).
4. Smoke: `/api/v1/health`, `/api/v1/database/pool/health`.
5. Rollback aplikasi = artefak sebelumnya; database roll-forward (migration koreksi baru).

## SOP backup & restore PostgreSQL

```bash
deploy/backup/backup-postgres.sh    # pg_dump -Fc → file timestamped
deploy/backup/restore-postgres.sh <file>  # pg_restore ke database target
```

- Jadwalkan backup harian (cron/systemd timer); simpan off-host bila memungkinkan.
- **Uji restore berkala** — restore yang tidak pernah diuji dianggap tidak ada (gate G5 doc 07).
- Jangan commit dump/backup ke repository.

## SOP insiden keamanan

1. Deteksi (security event/log) → catat `correlation_id`.
2. Kunci akses terdampak (nonaktifkan identity/tenant user, cabut role).
3. Periksa audit trail + decision log untuk cakupan.
4. Pulihkan; tulis temuan sebagai security finding; jalankan ulang `security:readiness`.

## User guide singkat (setelah Fase 1–2 terimplementasi)

- **Setup awal:** buka aplikasi → wizard membuat tenant, owner, office pertama; setelah sukses wizard terkunci.
- **Login:** identifier + password; lockout otomatis setelah N kegagalan; hubungi owner/admin untuk buka.
- **Kelola akses:** Admin/Owner memberi role; permission mengikuti matriks doc 17; penolakan akses tercatat dan bisa diaudit.
- **Auditor:** membaca `/logs/audit`, `/logs/security`, decision log — read-only.

## Handover checklist

- `.env` production terisi dan tervalidasi (`loadConfig` fail-fast).
- Kredensial disimpan di secret manager — bukan di repo/dokumen.
- SOP backup/restore dan kontak eskalasi terdokumentasi.
- `docs/awcms-mini/` + README modul mutakhir terhadap implementasi nyata.
