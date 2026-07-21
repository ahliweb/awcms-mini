# AWCMS-Mini Architecture

AWCMS-Mini memakai arsitektur modular monolith berbasis Bun + Astro 7 + PostgreSQL.

Rujukan kanonik:

- `README.md` untuk front door repo.
- `AGENTS.md` untuk kontrak agent dan kontributor.
- `docs/adr/` untuk keputusan arsitektural.
- `docs/awcms-mini/01_canvas_induk.md` sampai `docs/awcms-mini/20_threat_model_security_architecture.md` untuk dokumen master.

Foundation skeleton (Issue 0.1) menyediakan Astro build, module contract, module registry, response helper, soft-delete convention, health endpoint, dan folder standar. Modul tenant/auth/RBAC/sync/reporting/deployment **sudah** ditambahkan dan berjalan — base generik selesai (v1.0.0, seluruh 18 issue backlog doc 06 + peningkatan pasca-backlog M9 tuntas; lihat `README.md` §Versioning dan `docs/awcms-mini/AUDIT_STANDAR_PENGEMBANGAN_2026-07-17.md`). Pekerjaan baru = aplikasi turunan / modul domain di atas base ini (lihat `docs/awcms-mini/README.md` §Langkah berikutnya).
