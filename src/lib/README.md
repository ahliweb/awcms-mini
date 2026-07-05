# Shared Runtime Library

Folder `src/lib/` disediakan untuk helper lintas-modul:

- `auth/`
- `database/`
- `errors/`
- `files/`
- `i18n/`
- `logging/`

Implementasi detail masuk issue berikutnya. Semua kode di folder ini wajib Bun-only, tidak menyimpan secret, dan mengikuti lapisan service/repository di doc 10 dan doc 16.
