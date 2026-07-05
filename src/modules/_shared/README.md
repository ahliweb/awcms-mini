# Shared Module Foundation

Folder ini berisi kontrak lintas-modul yang boleh dipakai semua modul AWCMS-Mini.

## Module Contract

Setiap modul wajib mendeklarasikan `ModuleDescriptor` dari `module-contract.ts`, lalu mendaftarkannya lewat `src/modules/index.ts`.

## API Response

Endpoint REST memakai helper dari `api-response.ts` agar response konsisten:

- sukses: `{ ok: true, data, meta }`
- gagal: `{ ok: false, error: { code, message, details? }, meta }`

## Soft Delete Convention

Resource master/config/draft yang bisa dihapus wajib memakai kolom:

- `deleted_at`
- `deleted_by`
- `delete_reason`

Query list/detail default harus menyaring `deleted_at IS NULL`. Akses arsip, restore, dan purge harus memakai permission eksplisit dan audit log. Helper awal tersedia di `soft-delete.ts`; repository spesifik modul tetap wajib memakai query terparametrisasi dan RLS sesuai doc 10/16.
