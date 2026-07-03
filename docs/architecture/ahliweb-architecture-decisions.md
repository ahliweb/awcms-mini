# Keputusan Arsitektur AhliWeb (ADR) — Berlaku untuk AWCMS-Mini

**Tujuan:** Ringkasan kanonik keputusan arsitektur product-line AWCMS (ADR-013…023) dengan **kolom keberlakuan per produk**, sehingga repo ini selaras dengan keputusan terbaru. **Source of truth** = repo `personal-coding` (`docs/concepts/canvas-arsitektur-awcms-mini-awcms-emdash-pattern.md`, `docs/ahliweb-repo-decision-log.md`).

> **FOKUS REPO INI (AWCMS-Mini):** single-tenant; **stack sendiri Astro + Hono + PostgreSQL** (pg + Kysely); runtime **Bun**; **EmDash = rujukan arsitektur saja** (paket `emdash` dilepas bertahap via seam `src/cms/`); PostgreSQL-only (tanpa SQLite).

---

## Document Control

| Field           | Value                                   |
| --------------- | --------------------------------------- |
| Status          | Referensi (mirror dari personal-coding) |
| Source of truth | `ahliweb/personal-coding`               |
| Berlaku untuk   | `awcms-mini`                            |
| Last updated    | 2026-07-03                              |
| Classification  | internal                                |

---

## Matriks keberlakuan ADR per produk

| ADR     | Keputusan                                                                                        |            Micro            |            **Mini**             |           AWCMS            |
| ------- | ------------------------------------------------------------------------------------------------ | :-------------------------: | :-----------------------------: | :------------------------: |
| ADR-013 | Konektivitas PostgreSQL via **pooler OSS** (Supavisor/PgBouncer/PgCat); mode Session/Transaction |           — (D1)            |           ✅ Session            |    ✅ edge=Transaction     |
| ADR-014 | **PostgreSQL murni tanpa Supabase**                                                              |           — (D1)            |               ✅                |        ✅ (migrasi)        |
| ADR-015 | **RLS wajib** semua tabel                                                                        |   — (D1 prefix isolation)   |               ✅                |             ✅             |
| ADR-016 | SIKESRA & SatuSehatKobar = **plugin di Mini**; plugin Micro di-deprecate                         |        ✅ deprecate         |             ✅ host             |             —              |
| ADR-017 | AWCMS = platform modular **ERP ala Odoo**                                                        |              —              |                —                |             ✅             |
| ADR-018 | **Kontrak plugin manifest + data adapter**                                                       |    ✅ adapter D1/EmDash     |    ✅ adapter PostgreSQL+RLS    |             ✅             |
| ADR-019 | **Toolchain + runtime Bun**                                                                      | ❌ (ikut EmDash/Cloudflare) | ✅ runtime Bun; test `bun test` | ✅ admin/mcp; edge=Workers |
| ADR-020 | **EmDash = rujukan saja** (Mini/AWCMS); full EmDash hanya Micro                                  |     ✅ **full EmDash**      |         ✅ rujukan saja         |      ✅ rujukan saja       |
| ADR-021 | **Logging Pino** (Workers-native di edge)                                                        |     — (EmDash/Workers)      |             ✅ Pino             |     ✅ Workers-native      |
| ADR-022 | **Tiga rujukan arsitektur** (Supabase/Odoo/EmDash)                                               |              —              |               ✅                |             ✅             |
| ADR-023 | **CQRS pencarian** (Tier 1 PostgreSQL; Tier 2 Kafka skala besar)                                 |              —              |               ✅                |             ✅             |

Legenda: ✅ berlaku · — tidak relevan · ❌ sengaja tidak diberlakukan.

---

## Aturan operasional repo ini (turunan ADR)

1. **Runtime Bun** (ADR-019): `bun install`/`bun run`/`bun server/index.mjs`, Docker `oven/bun:1-alpine`. Server HTTP Hono = **`Bun.serve` native** (bukan `@hono/node-server`); Astro SSR (`@astrojs/node`) jalan di atas Bun via Node-compat. **Test runner = `bun test tests/unit/`** (kompatibel penuh `node:test`, 526 test). PostgreSQL-only.
2. **EmDash seam** (ADR-020): dilarang `import ... from "emdash"` di luar `src/cms/`. Guard: `tests/unit/cms-seam.test.mjs`. Inventaris touchpoint: `docs/architecture/emdash-touchpoint-inventory.md`.
3. **Plugin contract** (ADR-018): manifest `kind: awcms-mini-plugin`, `data.adapter: postgres`, `data.rls: required`; FF7 `bun run check:plugin-manifests`.
4. **RLS wajib** (ADR-015): `buildPluginRlsStatements()` per tabel plugin; FF6 `bun run check:rls-coverage`.
5. **Pooler** (ADR-013): `DATABASE_TRANSPORT=pooler` + mode **Session** (default Mini); aturan transaction mode di `docs/architecture/database-access.md`.
6. **Logging Pino** (ADR-021): `src/observability/logger.mjs` + redaction; jangan `console.*` ad-hoc.
7. **CQRS search** (ADR-023): query side read-only `src/search/` + `src/plugins/<x>/search/`; read DTO, masking, sort whitelist, audit data sensitif. Tier 2 (Kafka) hanya saat skala besar.

---

## Referensi

- Source of truth: `ahliweb/personal-coding` — `docs/concepts/canvas-arsitektur-awcms-mini-awcms-emdash-pattern.md` (ADR penuh), `docs/ahliweb-repo-decision-log.md` (DL-010…021).
- Dokumen turunan di repo ini: `AGENTS.md`, `REQUIREMENTS.md`, `docs/architecture/database-access.md`, `docs/architecture/emdash-touchpoint-inventory.md`, `src/cms/README.md`.
