# Changesets

Folder ini dikelola oleh [Changesets](https://github.com/changesets/changesets) untuk versioning SemVer AWCMS-Mini.

Alur:

1. Setiap PR yang mengubah perilaku (fitur, fix, schema/API/event) wajib menambah satu changeset: `bun run changeset`.
2. Perubahan docs-only/chore boleh tanpa changeset.
3. Rilis: `bun run changeset:version` (bump versi + CHANGELOG), lalu tag `vX.Y.Z`.

Detail: `docs/awcms-mini/09_roadmap_repository_commit.md`.
