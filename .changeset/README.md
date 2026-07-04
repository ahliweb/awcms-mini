# Changesets

Folder ini dikelola oleh [Changesets](https://github.com/changesets/changesets) untuk versioning dan pembuatan CHANGELOG AWPOS.

## Cara pakai singkat

1. Setelah membuat perubahan yang mempengaruhi perilaku, tambahkan changeset:

   ```bash
   bun run changeset      # atau: npx changeset
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

## Aturan AWPOS

- **Setiap PR** yang mengubah perilaku (fitur, fix, perubahan schema/API/event) **wajib menyertakan changeset**.
- Perubahan **docs-only/chore** boleh tanpa changeset.
- Tingkat bump mengikuti SemVer (lihat `docs/awpos/09_roadmap_repository_commit.md`).
- Format changeset:

  ```md
  ---
  "awpos": minor
  ---

  Ringkasan singkat perubahan yang berdampak ke pengguna.
  ```

> Catatan: Changesets aktif penuh setelah `package.json` diperluas dan dependency terinstall (mulai Issue 0.1). Konfigurasi & workflow sudah disiapkan di repository ini.
