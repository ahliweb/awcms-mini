---
"awcms-mini": patch
---

docs(governance): reposisi README/AGENTS ke ADR-0024 (template dipakai-langsung)

Menyelaraskan dokumen pintu-depan dengan ADR-0024 (keluarga AWCMS = tiga template dipakai-langsung, jalur aplikasi-turunan dihapus) yang sudah Accepted & sudah men-supersede ADR-0013/0014/0015:

- README & AGENTS: narasi "base + aplikasi turunan di repo terpisah" → "template modular monolith standar dipakai-langsung; modul domain ditambahkan langsung di `src/modules/`"; node mermaid & guide turunan diberi caveat DEPRECATED (rujukan historis).
- Perbaiki dua deskripsi command basi di AGENTS: `modules:compose:check` tak lagi menyebut `application-registry.ts` (dihapus ADR-0024), dan baris `extension:check` dihapus (command sudah tidak ada).

Doc-only.
