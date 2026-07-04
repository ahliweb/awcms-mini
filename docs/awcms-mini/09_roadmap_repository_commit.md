# Bagian 9 — Roadmap Repository dan Urutan Commit

## Prinsip repository

1. Setiap perubahan atomic; jangan campur perubahan unrelated.
2. Database change → migration; API change → OpenAPI; event change → AsyncAPI.
3. Mutation high-risk → idempotent; high-risk action → audit.
4. Jangan commit `.env`, token, backup, dump DB, data asli.

## Struktur repository final

```text
awcms-mini/
├── AGENTS.md                # kontrak kerja agent/kontributor
├── README.md
├── CHANGELOG.md             # digenerate Changesets
├── .changeset/
├── .claude/skills/          # skill proyek Claude Code
├── .claude/agents/          # subagents (coder, reviewer, security-auditor)
├── package.json
├── astro.config.mjs
├── tsconfig.json
├── .env.example
├── .gitignore
├── docker-compose.yml
├── src/
│   ├── lib/                 # config, errors, logging, database, auth, files, i18n
│   ├── modules/             # _shared + modul base (+ modul domain aplikasi)
│   └── pages/               # index + api/v1
├── sql/                     # NNN_awcms_<area>_<desc>.sql
├── scripts/                 # db-migrate, api-spec-check, readiness, preflight
├── openapi/
├── asyncapi/
├── docs/awcms-mini/         # paket dokumen 01–19
├── deploy/                  # systemd, nginx, pgbouncer, backup
├── tests/
└── fixtures/
```

## Struktur modul standard

```text
src/modules/<module>/
├── module.ts        # ModuleDescriptor (didaftarkan di src/modules/index.ts)
├── domain/
├── application/
├── infrastructure/
├── api/
└── README.md
```

## Branch strategy

| Branch                      | Fungsi                                                           |
| --------------------------- | ---------------------------------------------------------------- |
| `main`                      | Stabil/production-ready                                          |
| `feature/<issue>-<name>`    | Fitur atomic                                                     |
| `fix/<issue>-<name>`        | Bug fix                                                          |
| `release/vX.Y.Z`            | Release prep                                                     |
| `hotfix/vX.Y.Z-<name>`      | Hotfix production                                                |
| `legacy/pre-awpos-standard` | Arsip implementasi lama (Hono + emdash) sebelum refaktor standar |

## Commit convention

```text
<type>(<scope>): <summary>
```

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `security`, `perf`, `ci`, `build`.
Scopes base: `foundation`, `db`, `api`, `auth`, `access`, `profile`, `tenant`, `ui`, `logging`, `pooling`, `workflow`, `reporting`, `security`, `sync`, `docs`. Aplikasi domain menambah scope-nya sendiri (mis. `pos`, `inventory`).

## Urutan commit fase berikutnya

Sprint 2: `feat(tenant): add setup wizard API and default seed` → `feat(auth): add identity login with lockout` → `feat(auth): add auth middleware and tenant context` → `feat(profile): add profile resolver and identifier masking`.

Sprint 3: `feat(access): seed permission catalog and default roles` → `feat(access): implement ABAC evaluator with deny by default` → `feat(access): add access assignment API and decision log`.

Sprint 4: `feat(logging): add audit log security event repositories` → `feat(pooling): add database pool gate and backpressure`.

## Migration order

```text
001_awcms_foundation_schema.sql                 ✅
002_awcms_tenant_identity_profile_schema.sql    ✅
003_awcms_access_control_schema.sql             ✅
004_awcms_observability_schema.sql              ✅
005_awcms_workflow_approval_schema.sql          (rencana)
006_awcms_i18n_theme_schema.sql                 (rencana)
007_awcms_sync_storage_schema.sql               (rencana)
008_awcms_security_readiness_schema.sql         (rencana)
```

Migration yang sudah applied **tidak boleh diubah** (checksum drift = error); koreksi lewat migration baru. Aplikasi domain melanjutkan nomor berikutnya.

## Versioning (SemVer + Changesets)

- Setiap PR yang mengubah perilaku wajib satu changeset (`bun run changeset`); docs-only/chore boleh tanpa.
- Rilis: `bun run changeset:version` → bump + CHANGELOG → tag `vX.Y.Z` (skill `awcms-mini-release`).
- Baseline `0.0.0`; rilis pertama `0.1.0` (Foundation — refaktor standar ini).

| Versi  | Isi                                           |
| ------ | --------------------------------------------- |
| v0.1.0 | Foundation + schema base + kontrak + skeleton |
| v0.2.0 | Setup wizard, login, profile                  |
| v0.3.0 | RBAC/ABAC evaluator + assignment              |
| v0.4.0 | Observability + pooling                       |
| v0.5.0 | Workflow + admin shell                        |
| v0.6.0 | Sync opsional                                 |
| v1.0.0 | Base production-ready (gates doc 07)          |

## PR checklist

Scope sesuai issue · tanpa unrelated change · no secret · build pass · test pass · migration/OpenAPI/AsyncAPI bila relevan · security notes · docs update · changeset.

## Pre-deploy checklist

Lihat doc 07 / `bun run production:preflight`.
