# `src/cms/` — Seam Kontrak Internal (decoupling EmDash, ADR-020)

Lapisan **seam** (pola *strangler fig*) yang membungkus kapabilitas yang saat ini
berasal dari paket `emdash`, agar kode aplikasi `awcms-mini` **tidak mengimpor
`emdash` secara langsung**.

## Aturan (Fase 2 epic #327)

- Kode di luar `src/cms/` (dan `astro.config.mjs`) **DILARANG** `import ... from "emdash"`.
- Semua kebutuhan runtime EmDash diakses lewat seam ini.
- Saat penggantian native siap (Fase 3–5), **implementasi di balik seam ditukar**
  tanpa mengubah call-site.

## Isi

| Modul | Menyediakan | Sumber sekarang | Pengganti (fase) |
|---|---|---|---|
| `context.mjs` | `runWithContext` | `emdash` | helper konteks native (Fase 2/4) |
| `plugin-runtime.mjs` | `definePlugin`, `PluginRouteError` | `emdash` | registry/loader + tipe error native (#318, Fase 3) |

> Rujukan: personal-coding `docs/architecture/awcms-mini-emdash-decoupling-plan.md`,
> `docs/architecture/emdash-touchpoint-inventory.md` (di repo ini), ADR-020.
