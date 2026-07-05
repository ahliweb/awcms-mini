# AWCMS-Mini Architecture

AWCMS-Mini memakai arsitektur modular monolith berbasis Bun + Astro 7 + PostgreSQL.

Rujukan kanonik:

- `README.md` untuk front door repo.
- `AGENTS.md` untuk kontrak agent dan kontributor.
- `docs/adr/` untuk keputusan arsitektural.
- `docs/awcms-mini/01_canvas_induk.md` sampai `docs/awcms-mini/20_threat_model_security_architecture.md` untuk dokumen master.

Issue 0.1 menyediakan foundation skeleton: Astro build, module contract, module registry, response helper, soft-delete convention, health endpoint, dan folder standar. Modul tenant/auth/RBAC/sync/reporting/deployment ditambahkan pada issue berikutnya.
