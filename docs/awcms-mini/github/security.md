# GitHub Security Setup AWCMS-Mini

Snapshot: 2026-07-06T14:02:04.204Z

Dokumen ini mencatat konfigurasi GitHub Security untuk `ahliweb/awcms-mini`: Bun + Astro 7 + PostgreSQL, base generik selesai (v0.23.5). Baris konfigurasi diperbarui saat setup berubah (baris CodeQL code scanning disegarkan untuk Issue #452 — coverage `javascript-typescript`); metrik point-in-time (alert count, commit run) mengikuti timestamp snapshot di atas dan disegarkan lewat §Proses Refresh. Refresh 2026-07-06 (Issue #461): dua temuan nyata dari scan `javascript-typescript` pertama (alert #8 `js/file-system-race`, #9 `js/unused-local-variable`) diperbaiki dan dikonfirmasi `state: fixed` via API — lihat §Alert Count Saat Setup.

## Ringkasan Live State

| Kontrol                               | Status                                                                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository visibility                 | Public                                                                                                                                                                                                              |
| Viewer permission saat setup          | Admin                                                                                                                                                                                                               |
| Security policy                       | Ditambahkan lewat `SECURITY.md`                                                                                                                                                                                     |
| Dependabot alerts                     | Enabled                                                                                                                                                                                                             |
| Dependabot security updates           | Enabled                                                                                                                                                                                                             |
| Dependabot version updates            | Ditambahkan lewat `.github/dependabot.yml`                                                                                                                                                                          |
| Secret scanning                       | Enabled                                                                                                                                                                                                             |
| Secret scanning push protection       | Enabled                                                                                                                                                                                                             |
| Secret scanning non-provider patterns | Disabled pada GitHub saat setup                                                                                                                                                                                     |
| Secret scanning validity checks       | Disabled pada GitHub saat setup                                                                                                                                                                                     |
| Code scanning                         | Enabled lewat `.github/workflows/codeql.yml` untuk GitHub Actions **dan** `javascript-typescript` (source TypeScript/Astro, Issue #452); default setup `not-configured` agar tidak konflik dengan advanced workflow |
| Private vulnerability reporting       | Enabled; gunakan link GitHub advisory di `SECURITY.md`                                                                                                                                                              |
| Latest CodeQL run                     | Success pada `main` commit `c3bf97e` (2026-07-06T13:51:47Z)                                                                                                                                                         |

## Alert Count Saat Setup

| Alert type      | Open | Fixed / historical | Catatan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------- | ---: | -----------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependabot      |    0 |                 40 | Semua alert yang terambil dari API berstatus `fixed`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Code scanning   |    0 |                  9 | Semua alert yang terambil dari API berstatus `fixed` (#1 `js/insecure-randomness` fixed 2026-04-15T01:44:30Z; #2 `js/clear-text-logging` fixed 2026-04-25T09:33:03Z; #3 `js/clear-text-logging` fixed 2026-04-25T09:33:03Z; #4 `js/clear-text-logging` fixed 2026-04-25T09:33:03Z; #5 `js/clear-text-logging` fixed 2026-07-04T09:13:25Z; #6 `actions/missing-workflow-permissions` fixed 2026-07-04T10:01:12Z; #7 `actions/unpinned-tag` fixed 2026-07-05T00:05:32Z; #8 `js/file-system-race` fixed 2026-07-06T13:02:21Z; #9 `js/unused-local-variable` fixed 2026-07-06T13:02:21Z). |
| Secret scanning |    0 |                  0 | Tidak ada alert saat setup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## File Yang Menjadi Standar

| File                                 | Fungsi                                                                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SECURITY.md`                        | Instruksi pelaporan vulnerability dan baseline kontrol keamanan.                                                                                                                                 |
| `.github/dependabot.yml`             | Dependabot weekly untuk ecosystem `bun` dan `github-actions`.                                                                                                                                    |
| `.github/workflows/codeql.yml`       | CodeQL advanced setup: matrix `actions` + `javascript-typescript` (`build-mode: none`, no-build source extraction, Bun-only) dengan query `security-extended,security-and-quality` (Issue #452). |
| `docs/awcms-mini/github/security.md` | Snapshot audit konfigurasi security repo.                                                                                                                                                        |

## Catatan Bun

Dependabot dikonfigurasi dengan `package-ecosystem: "bun"` karena repo menggunakan `bun.lock` text lockfile dan `packageManager: "bun@1.3.14"`. Jangan mengganti ke `npm`, `pnpm`, atau `yarn`.

## Proses Refresh

```bash
gh repo view ahliweb/awcms-mini --json isSecurityPolicyEnabled,securityPolicyUrl,viewerPermission,viewerCanAdminister
gh api repos/ahliweb/awcms-mini --jq '.security_and_analysis'
gh api repos/ahliweb/awcms-mini/dependabot/alerts --paginate
gh api repos/ahliweb/awcms-mini/code-scanning/alerts --paginate
gh api repos/ahliweb/awcms-mini/secret-scanning/alerts --paginate
gh api repos/ahliweb/awcms-mini/actions/workflows
```

Setelah refresh, update snapshot, alert count, dan catatan fitur yang berubah.
