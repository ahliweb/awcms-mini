# GitHub Security Setup AWCMS-Mini

Snapshot: 2026-07-04T11:16:36Z

Dokumen ini mencatat konfigurasi GitHub Security untuk `ahliweb/awcms-mini` sesuai baseline repo: Bun + Astro 7 + PostgreSQL, docs-only sampai scaffold Issue 0.1 tersedia.

## Ringkasan Live State

| Kontrol | Status |
|---|---|
| Repository visibility | Public |
| Viewer permission saat setup | Admin |
| Security policy | Ditambahkan lewat `SECURITY.md` |
| Dependabot alerts | Enabled |
| Dependabot security updates | Enabled |
| Dependabot version updates | Ditambahkan lewat `.github/dependabot.yml` |
| Secret scanning | Enabled |
| Secret scanning push protection | Enabled |
| Secret scanning non-provider patterns | Disabled pada GitHub saat setup |
| Secret scanning validity checks | Disabled pada GitHub saat setup |
| Code scanning | Enabled lewat `.github/workflows/codeql.yml` untuk GitHub Actions; default setup `not-configured` agar tidak konflik dengan advanced workflow |
| Private vulnerability reporting | Enabled; gunakan link GitHub advisory di `SECURITY.md` |
| Latest CodeQL run | Success pada `main` commit `5f080b0` |

## Alert Count Saat Setup

| Alert type | Open | Fixed / historical | Catatan |
|---|---:|---:|---|
| Dependabot | 0 | 40 | Semua alert yang terambil dari API berstatus `fixed`. |
| Code scanning | 0 | 6 | Semua alert yang terambil dari API berstatus `fixed`. |
| Secret scanning | 0 | 0 | Tidak ada alert saat setup. |

## File Yang Menjadi Standar

| File | Fungsi |
|---|---|
| `SECURITY.md` | Instruksi pelaporan vulnerability dan baseline kontrol keamanan. |
| `.github/dependabot.yml` | Dependabot weekly untuk ecosystem `bun` dan `github-actions`. |
| `.github/workflows/codeql.yml` | CodeQL advanced setup untuk GitHub Actions pada baseline docs-only; tambah `javascript-typescript` setelah scaffold Astro/Bun tersedia. |
| `docs/awcms-mini/github/security.md` | Snapshot audit konfigurasi security repo. |

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
