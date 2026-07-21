# Changesets

Folder ini dikelola oleh [Changesets](https://github.com/changesets/changesets) untuk versioning dan pembuatan CHANGELOG AWCMS-Mini.

## Cara pakai singkat

1. Setelah membuat perubahan yang mempengaruhi perilaku, tambahkan changeset:

   ```bash
   bun run changeset
   ```

   Pilih tingkat bump (**patch/minor/major**) dan tulis ringkasan perubahan. File markdown baru muncul di `.changeset/`.

2. Saat rilis, konsumsi semua changeset untuk menaikkan versi dan memperbarui `CHANGELOG.md`:

   ```bash
   bun run changeset:version
   ```

3. Commit hasilnya, lalu (bila relevan) buat tag rilis:

   ```bash
   bun run changeset:tag
   ```

## Aturan AWCMS-Mini

- **Setiap PR** yang mengubah perilaku (fitur, fix, perubahan schema/API/event) **wajib menyertakan changeset**.
- Perubahan **docs-only/chore** boleh tanpa changeset.
- Tingkat bump mengikuti SemVer (lihat `docs/awcms-mini/09_roadmap_repository_commit.md`). Sejak **`v1.0.0`** (tercapai 2026-07-21, ADR-0024) SemVer ketat berlaku penuh: breaking pada API/kontrak/schema publik **wajib `major`** — aturan pra-1.0.0 (breaking cukup `minor`) tidak berlaku lagi.
- Format changeset:

  ```md
  ---
  "awcms-mini": minor
  ---

  Ringkasan singkat perubahan yang berdampak ke pengguna.
  ```

> Catatan: Changesets aktif penuh di repository ini. Baseline rilis kini **`v1.0.0`** (base production-ready); proses rilis end-to-end didokumentasikan di skill `awcms-mini-release` dan `docs/awcms-mini/release-process.md`.
