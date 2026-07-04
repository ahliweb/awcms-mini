# ADR-0001 — Modular monolith, microservice-ready

- **Status:** Accepted
- **Tanggal:** 2026-07-05
- **Terkait:** `docs/awcms-mini/01_canvas_induk.md`, `docs/awcms-mini/10_template_kode_coding_standard.md`, `docs/awcms-mini/11_implementation_blueprint.md`

## Konteks

AWCMS-Mini adalah base yang harus mudah dipahami, cepat dikembangkan tim kecil, dan tetap bisa tumbuh. Microservice sejak awal menambah kompleksitas operasional (jaringan, observability terdistribusi, konsistensi data) yang tidak sepadan pada tahap awal. Namun kami tidak ingin mengunci diri dari pemisahan layanan di masa depan.

## Keputusan

Kami memutuskan memakai **modular monolith**: satu deployable dengan modul berbatas tegas (`src/modules/<module>/` berisi `module.ts`, `domain/`, `application/`, `infrastructure/`, `api/`). Batas antar modul ditegakkan lewat **module contract** dan registry, sehingga tetap **microservice-ready** — modul dapat dipisah menjadi layanan sendiri bila terbukti perlu.

## Konsekuensi

- **Positif:** kompleksitas operasional rendah, transaksi lintas-modul mudah (satu database), onboarding cepat, batas modul eksplisit.
- **Trade-off:** disiplin diperlukan agar modul tidak saling bocor; skala horizontal terbatas pada level proses hingga dipisah.
- **Netral:** komunikasi antar modul memakai domain event (AsyncAPI) sehingga pemisahan ke layanan tidak mengubah kontrak.

## Alternatif yang dipertimbangkan

- **Microservices sejak awal** — ditolak: overhead operasional dan biaya konsistensi data terlalu tinggi untuk tahap base.
- **Monolith non-modular** — ditolak: sulit dipisah dan cenderung menjadi big ball of mud.
