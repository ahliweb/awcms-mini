---
name: awcms-mini-release
description: Jalankan proses rilis AWCMS-Mini dengan Changesets. Gunakan saat diminta merilis versi, bump version, generate CHANGELOG, membuat tag vX.Y.Z, atau memeriksa changeset pending. Sesuai kebijakan SemVer doc 09.
---

# AWCMS-Mini — Release (Changesets)

> ## ℹ️ Status pipeline rilis (#825) — jalur otomatis kini konsisten `vX.Y.Z`
>
> "Nol rilis pernah terjadi" akarnya BUKAN yang diklaim audit #825/#854. Fakta terverifikasi saat rilis nyata pertama:
>
> | Sisi                            | Nilai final (benar)                                                                                           |
> | ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
> | `bun run changeset:tag`         | memancarkan **`vX.Y.Z`** (untuk repo single-package, Changesets pakai `v<version>`, BUKAN `<name>@<version>`) |
> | `.github/workflows/release.yml` | trigger `push: tags: v*.*.*` — **sumber kebenaran yang sama** dengan tag generator                            |
>
> Catatan: tag lama `awcms-mini@0.0.x` ternyata **buatan tangan**, bukan output changeset — bukti yang menyesatkan audit. PR #854 sempat mengubah trigger ke `awcms-mini@*` (yang tak pernah dipancarkan changeset di sini) lalu **di-revert** kembali ke `v*.*.*`. Selain trigger, dua bug format juga diperbaiki agar rilis changeset benar-benar jalan: `release-verify.ts` + awk RELEASE_NOTES di `release.yml` kini menerima header changeset `## X.Y.Z` (dulu hanya `## [X.Y.Z]` → gagal/kosong).
>
> **Terbukti end-to-end**: rehearsal `workflow_dispatch` (run 29640049800) menembus sign+attest+publish; attestation SLSA provenance v1 terverifikasi pada image `dryrun-<sha>`. Environment `release` sudah punya `required_reviewers` (`ahliweb`).

Ikuti `docs/awcms-mini/09_roadmap_repository_commit.md` §Versioning dan `.changeset/README.md`. Sejak Issue #692 (epic #679, platform-hardening), langkah dari "push tag" sampai "GitHub Release + image + SBOM + signature + provenance" **sudah otomatis** lewat `.github/workflows/release.yml` — lihat [`docs/awcms-mini/release-process.md`](../../../docs/awcms-mini/release-process.md) untuk detail lengkap (SBOM tool, keyless signing, attestation, environment approval, dry-run/rehearsal, verifikasi konsumen, rollback/yank). Skill ini tetap mendokumentasikan langkah lokal (changeset → version bump → tag) yang masih manual.

## Alur rilis

```mermaid
flowchart LR
  A[changeset:status<br/>cek pending] --> B[Validasi lokal:<br/>bun run check]
  B --> C[changeset:version<br/>bump + CHANGELOG]
  C --> D[Review diff CHANGELOG<br/>+ package.json]
  D --> E[Commit chore release vX.Y.Z]
  E --> F[changeset:tag → push tag rilis itu saja]
  F --> G[release.yml: validate job<br/>+ build job SBOM x2]
  G --> H[release environment<br/>approval gate]
  H --> I[sign-attest-publish job:<br/>cosign sign + attest + publish]
```

## Prosedur

1. `bun run changeset:status` — pastikan ada changeset pending dan tingkat bump sesuai SemVer (MAJOR breaking / MINOR fitur / PATCH fix). Bila kosong tapi ada perubahan perilaku → minta changeset dulu, jangan rilis. Setiap PR yang membutuhkan changeset sudah ditegakkan otomatis oleh `.github/workflows/changesets.yml` (`bun run changesets:policy:check`) — pending changeset di titik ini seharusnya sudah lengkap, bukan ditemukan baru saat rilis.
2. Validasi lokal: `bun run check` (lint, docs, contracts, typecheck, test, build — `release.yml`'s `validate` job re-runs persis perintah yang sama, dan sebenarnya lebih ketat dari `ci.yml`'s `quality` job hari ini karena `quality` belum menjalankan `i18n:pot:check`/`config:docs:check`/`logging:lint:check`, lihat `release-process.md` §validate job); untuk rilis production tambah `bun run production:preflight` (gate doc 07 — critical finding memblokir). `bun run check` juga menjalankan `extension:check` (Issue #741/ADR-0015) — bila repo turunan Anda mem-fork pipeline rilis ini dan sudah mempublikasikan `extension.manifest.json`, langkah ini memverifikasi manifest itu tetap kompatibel dengan versi/kontrak/checksum migration rilis yang sedang di-tag, tanpa gerbang terpisah untuk dikonfigurasi.
3. `bun run changeset:version` — konsumsi changeset → bump `package.json` + entri `CHANGELOG.md`.
4. Review diff; pastikan versi cocok peta doc 09 (0.1.0 Foundation … 1.0.0 production MVP).
5. Commit: `chore(release): vX.Y.Z` (sertakan CHANGELOG + package.json + penghapusan file changeset), push ke `main`.
6. `bun run changeset:tag` (memancarkan tag `vX.Y.Z`), lalu push **hanya tag rilis itu**: `git push origin vX.Y.Z`. **Jangan** `git push --tags` — itu mendorong SEMUA tag lokal di `refs/tags`, sehingga tag `v*` lain yang belum dipublikasi di clone Anda ikut ter-push dan bisa memicu `release.yml` berkali-kali (trigger `v*.*.*`). Tag rilis ini **memicu** `.github/workflows/release.yml` (#825): guard ancestor-of-`main`, `bun run release:verify` (versi/CHANGELOG/changeset tersisa harus konsisten), full quality gate, lalu — setelah disetujui lewat `release` environment (lihat doc `release-process.md` §Environment approval) — build image, dua SBOM CycloneDX (source + image), checksums, `cosign sign` keyless, `actions/attest-build-provenance`/`attest-sbom`, push `ghcr.io/ahliweb/awcms-mini` (image tag **`X.Y.Z` polos** + `:sha-<commit>` + `:latest`), dan `gh release create` dengan asset terlampir.
7. **Jangan** lagi menjalankan `gh release create` manual — itu sekarang bagian dari `release.yml`; menjalankannya manual sebelum workflow selesai akan bentrok dengan asset yang coba di-attach otomatis.

## Aturan

- Jangan rilis dari branch selain `main` (atau `release/vX.Y.Z` sesuai doc 09) — `release.yml` menolak tag yang bukan ancestor `origin/main`.
- Jangan edit CHANGELOG entri lama; koreksi lewat entri baru.
- Pra-1.0.0: minor boleh memuat penyesuaian belum stabil; tetap catat breaking di ringkasan changeset.
- Tag `vX.Y.Z` (format yang dipancarkan `changeset:tag`) harus menunjuk commit rilis, bukan commit sesudahnya — `bun run release:verify` menolak bila `package.json`/CHANGELOG tidak cocok dengan tag.
- Sebelum tag rilis production pertama, jalankan rehearsal (`gh workflow run release.yml --ref main`) minimal sekali dan pastikan reviewer benar-benar approve gerbang environment `release` — lihat doc `release-process.md` §Dry-run/rehearsal.

## Verifikasi

- `git tag --points-at HEAD` menunjukkan tag baru; CHANGELOG punya seksi versi; `package.json` versi sama dengan tag.
- Setelah `release.yml` selesai: `gh attestation verify oci://ghcr.io/ahliweb/awcms-mini:X.Y.Z --owner ahliweb` (image tag polos, bukan `v`-prefixed) dan `cosign verify ...` (perintah lengkap di `release-process.md` §Verification) — tidak butuh akses repo secret.
