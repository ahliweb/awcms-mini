# Branch Protection — Required Status Checks

Issue #685 (epic #679, platform-hardening) acceptance criterion: "Branch
protection documentation identifies required checks." This document is
that reference.

> ## ✅ AKTIF sejak 2026-07-17 (Issue #823, epic #818)
>
> `main` **sudah diproteksi**. Sebelumnya tidak sama sekali
> (`404 Branch not protected`) — CI berjalan tapi **advisory**: PR dengan
> check merah tetap bisa di-merge, dan itu akar beberapa temuan audit
> [#818](https://github.com/ahliweb/awcms-mini/issues/818).
>
> Konfigurasi terpasang (verifikasi: `gh api repos/ahliweb/awcms-mini/branches/main/protection`):
>
> | Setelan                            | Nilai                    | Alasan                                                                                                                                                         |
> | ---------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | Required checks                    | 6 (lihat tabel di bawah) | CI tidak lagi advisory                                                                                                                                         |
> | `strict`                           | `false`                  | PR tidak dipaksa selalu up-to-date dengan `main` — trade-off sadar agar banyak PR paralel tidak terserialisasi. Pertimbangkan `true` setelah epic #818 selesai |
> | Approval wajib                     | `0`                      | PR tetap wajib + CI wajib hijau, tapi alur agent masih bisa me-merge PR hijau. Naikkan ke `1` bila ingin review manusia wajib                                  |
> | `enforce_admins`                   | `false`                  | Menyisakan jalan darurat bila CI rusak total                                                                                                                   |
> | Force push                         | diblokir                 |                                                                                                                                                                |
> | Penghapusan branch                 | diblokir                 |                                                                                                                                                                |
> | `required_conversation_resolution` | `true`                   | Temuan review tidak bisa diabaikan diam-diam                                                                                                                   |
>
> **`CodeQL` (yang polos) sengaja TIDAK diwajibkan** — check itu melapor
> `skipping` pada sebagian run, dan mewajibkannya akan menggantungkan PR
> selamanya. Yang diwajibkan adalah dua job `Analyze (...)` yang benar-benar
> berjalan. Ini jebakan nyata: required check yang bisa "skip" = deadlock.

Mengubah proteksi adalah perubahan shared-state (memengaruhi alur merge
setiap kontributor) — lakukan eksplisit oleh maintainer, jangan otomatis dari
doc ini atau dari CI.

## Required status checks (recommended)

These are the exact check names GitHub reports for `.github/workflows/ci.yml`
and `.github/workflows/codeql.yml` — a branch protection rule's "required
status checks" list must reference these names verbatim (GitHub matches on
the job's `name:`, not its internal id):

| Check name (verbatim)                                  | Workflow / job                    | What it gates                                                                                                                                                                                        |
| ------------------------------------------------------ | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Quality (lint + docs + contracts + typecheck + test)` | `ci.yml` / `quality`              | Prettier, docs checks, `api:spec:check` (OpenAPI/AsyncAPI + route parity + public-operation allow-list), `modules:dag:check`, `i18n:parity:check`, typecheck, `bun test` (unit + integration), build |
| `E2E smoke (Playwright)`                               | `ci.yml` / `e2e-smoke`            | Real-browser smoke coverage against a live app + isolated Postgres (login, admin/security both gate states, admin/analytics access control)                                                          |
| `Repo hygiene (Bun-only + no secrets)`                 | `ci.yml` / `hygiene`              | Bun-only tooling convention, no committed `.env`, both `docker-compose*.yml` files parse                                                                                                             |
| `Analyze (actions)`                                    | `codeql.yml` / `analyze`          | CodeQL static analysis of GitHub Actions workflow files                                                                                                                                              |
| `Analyze (javascript-typescript)`                      | `codeql.yml` / `analyze`          | CodeQL static analysis (security-extended + security-and-quality queries) of the TypeScript/Astro source                                                                                             |
| `Changeset required for behavior changes`              | `changesets.yml` / `policy-check` | Issue #692: fails a PR touching non-docs/non-agent-tooling files without a new `.changeset/*.md` — see `release-process.md` §PR-time gate                                                            |

`GitGuardian Security Checks` (a GitHub App check, not a workflow file in
this repo) also already reports on every PR — include it in the required
list too if the org's GitGuardian integration is expected to stay enabled
long-term; it is not configured by anything in `.github/workflows/`, so
it isn't itemized above with the rest.

## Mengubah proteksi (sudah diterapkan — bagian ini untuk MENGUBAH, bukan memasang)

> Perintah & anjuran di bawah ditulis **sebelum** proteksi aktif dan
> mencerminkan usulan awal, bukan kondisi terpasang. Yang benar-benar aktif
> ada di kotak ✅ di bagian atas. **Dua nilai sengaja berbeda dari contoh di
> bawah**: `strict=false` (bukan `true`) agar PR paralel tidak terserialisasi,
> dan `enforce_admins=false` (bukan `true`) untuk menyisakan jalan darurat.
> Contoh di bawah juga memakai `required_pull_request_reviews=null`, sedangkan
> yang terpasang mewajibkan PR dengan `0` approval.
>
> Cara terpasangnya: `gh api -X PUT ... --input <file.json>` (payload JSON
> penuh) — bentuk `-f key.subkey=value` di bawah rapuh untuk struktur bersarang.
> **Selalu verifikasi dengan `GET` setelah mengubah.**

Via the GitHub UI: **Settings → Branches → Add branch protection rule**,
pattern `main`, enable **Require status checks to pass before merging**,
then search for and add each check name from the table above (GitHub only
offers checks that have reported at least once — merge/re-run this PR
first if a check is missing from the picker). Recommended alongside it,
consistent with this repo's existing PR-based workflow (every merge in
this project's history has gone through a PR, never a direct push):
**Require a pull request before merging**, **Require branches to be up to
date before merging**.

Equivalent `gh api` command (run by a repo admin, adjust `required_status_checks.contexts`
if the check list above has since changed):

```bash
gh api -X PUT repos/ahliweb/awcms-mini/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  -f required_status_checks.strict=true \
  -f 'required_status_checks.contexts[]=Quality (lint + docs + contracts + typecheck + test)' \
  -f 'required_status_checks.contexts[]=E2E smoke (Playwright)' \
  -f 'required_status_checks.contexts[]=Repo hygiene (Bun-only + no secrets)' \
  -f 'required_status_checks.contexts[]=Analyze (actions)' \
  -f 'required_status_checks.contexts[]=Analyze (javascript-typescript)' \
  -f 'required_status_checks.contexts[]=Changeset required for behavior changes' \
  -f enforce_admins=true \
  -f required_pull_request_reviews=null \
  -f restrictions=null
```

(`required_pull_request_reviews=null`/`restrictions=null` here mean "don't
additionally require review approvals / don't restrict who can push" —
tighten those separately if desired; they're independent of the status
check requirement this doc is about.)

## Why `bun run check` and CI must stay the same source of truth

`package.json`'s `check` script runs **13** steps in order: `lint`,
`check:docs`, `api:spec:check`, `api:docs:check`, `repo:inventory:check`,
`modules:dag:check`, `i18n:pot:check`, `i18n:parity:check`,
`config:docs:check`, `logging:lint:check`, `typecheck`, `test`, `build`.

`.github/workflows/ci.yml`'s `quality` job (verified directly against the
workflow file) currently runs only **8** of those 13, as named steps in
this order: `lint` ("Prettier check"), `check:docs` ("Docs checks"),
`api:spec:check` ("API spec + route + AsyncAPI contract check"),
`modules:dag:check` ("Module dependency graph check"), `i18n:parity:check`
("i18n EN/ID/POT key parity check"), `typecheck`, `test` (as `bun test`,
after a separate `db:migrate` setup step), and `build` ("Build Astro
foundation") — plus a DR/resilience-drill step that isn't part of `bun run
check` at all. Before Issue #685, CI silently ran a subset of `check`
missing `api:spec:check` and `modules:dag:check` entirely; Issue #685
closed that gap for those two, but **5 steps still only run in
`release.yml`**, not in `ci.yml`'s `quality` job: `api:docs:check`,
`repo:inventory:check`, `i18n:pot:check`, `config:docs:check`, and
`logging:lint:check` — all 13 run there via one "Full quality gate (`bun
run check`)" step against a real, migrated Postgres service (reviewer
finding on PR #715 originally flagged the last three of these five; see
[`release-process.md`](release-process.md) §3 for the full context).

Concretely, this means an API-docs drift, a repo-inventory drift, an i18n
`.pot` drift, a config-docs drift, or a raw-error-logging violation can
merge to `main` via a green PR today and only surface when a release tag
is pushed — closing this gap (either by adding the 5 missing steps to
`ci.yml`'s `quality` job, or by accepting the two-tier design explicitly)
is tracked as a separate follow-up, out of this doc's own scope to apply.
Whenever a new step is added to `bun run check`, add the matching named
step to `ci.yml`'s `quality` job in the same PR (or explicitly document
why it stays release-only) — silent drift between the two is exactly the
failure mode Issue #685 exists to close.

## Lihat juga

- [`06_github_issues_detail.md`](06_github_issues_detail.md) — issue
  #685's own body and epic #679 (platform-hardening).
- [`07_sprint_testing_production_readiness.md`](07_sprint_testing_production_readiness.md)
  — testing pyramid and production readiness checklist this CI
  orchestration serves.
- `.claude/skills/awcms-mini-browser-test/SKILL.md` — E2E spec-writing
  conventions; its own "Status" section previously noted E2E was
  "belum bagian dari CI" (not yet part of CI) — Issue #685 is the issue
  that closed that gap, referenced there.
- `.github/workflows/ci.yml` / `.github/workflows/codeql.yml` — the
  actual workflow definitions this doc describes.
- [`release-process.md`](release-process.md) — Issue #692's
  `changesets.yml` (PR-time changeset policy gate, table row above) and
  `release.yml` (tag-triggered build/SBOM/sign/attest/publish pipeline),
  including its own repo-admin manual step (the `release` GitHub
  Environment's required reviewers) that follows this same "document, don't
  self-apply" pattern.
