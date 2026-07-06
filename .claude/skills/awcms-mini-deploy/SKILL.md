---
name: awcms-mini-deploy
description: Pilih dan jalankan profil deployment AWCMS-Mini (development/staging/production/offline-LAN). Gunakan saat menyiapkan deployment baru, memutuskan LAN-first vs registry-based, atau deploy ke Coolify. Sesuai doc 18 dan deployment-profiles.md/deploy-coolify.md.
---

# AWCMS-Mini — Deployment Profile & Execution

Ikuti `docs/awcms-mini/deployment-profiles.md` (peta profil ke berkas
`deploy/*`) dan `docs/awcms-mini/deploy-coolify.md` (khusus Coolify).

## Pilih jalur

```mermaid
flowchart TD
  A{Topologi target?} -->|LAN-first satu server,\noperator git pull in-place| B[docker-compose.yml]
  A -->|Registry/CI-push,\norkestrator container| C[Dockerfile.production]
  C --> D{Orkestrator?}
  D -->|Coolify| E[deploy-coolify.md]
  D -->|k8s/ECS/lain| F[Adaptasi pola Dockerfile.production yang sama]
```

`docker-compose.yml` tetap jalur yang **direkomendasikan** untuk
LAN-first/offline satu server — jangan beralih ke `Dockerfile.production`
kecuali orkestrator memang mengharapkan image siap-pakai (build-saat-startup
tidak diinginkan).

## Command inti (semua profil)

```bash
bun run config:validate      # wajib pertama — konfigurasi valid sebelum apa pun
bun run db:migrate           # migrasi sebagai role privileged, sebelum container app pertama
bun run production:preflight # orkestrasi migrate -> api:spec:check -> test -> build -> db:pool:health -> security:readiness
```

## Checklist per topologi

**LAN-first (`docker-compose.yml`)**: `export APP_UID=$(id -u) APP_GID=$(id -g)`
sebelum `docker compose up --build` (wajib — tanpanya container jadi root
dan menulis `node_modules/`/`dist/` sebagai root di bind mount host);
health check `curl http://localhost:4321/api/v1/health`.

**Registry-based/Coolify (`Dockerfile.production`)**: migration one-shot
**terpisah** (image tidak menjalankannya — role runtime least-privilege
tidak punya hak DDL); role app selalu `awcms_mini_app` atau setara, tidak
pernah superuser; database tidak perlu public port bila app+DB satu
internal network; secret selalu via env var/orkestrator, tidak pernah
dibakar ke image (`.dockerignore` mengecualikan `.env`).

**Multi-aplikasi dalam satu VPS/Coolify**: setiap aplikasi wajib
domain/secret/database (atau minimal schema+role) terpisah — jangan reuse
`AUTH_JWT_SECRET`/HMAC/kredensial R2 antar aplikasi; lihat
`deploy-coolify.md` §Opsi PostgreSQL untuk perbandingan satu cluster vs
satu container per aplikasi vs managed database eksternal.

## Model dua-peran basis data (wajib di semua profil)

Migrasi = role privileged (DDL/GRANT). Runtime app = `awcms_mini_app`
least-privilege, `FORCE ROW LEVEL SECURITY` ditegakkan untuknya. Jangan
pernah menjalankan aplikasi sebagai superuser/owner — `bun run
security:readiness` memblokir go-live bila terdeteksi.

## Rollback

Image immutable (Pola registry) → redeploy tag sebelumnya. **Migration
caution**: rollback image tidak membatalkan migrasi skema yang sudah
diterapkan — uji migrasi backward-compatible (expand-first) sebelum
deploy, atau siapkan restore dari backup (`deploy/backup/restore-postgres.sh`)
sebagai jalur rollback skema.

## Output

Laporan: profil dipilih + alasan, checklist yang terpenuhi, health check
hasil, dan (bila registry-based) rencana rollback singkat.
