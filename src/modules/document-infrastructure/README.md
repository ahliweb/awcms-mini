# Document Infrastructure

Implementasi Issue #751 (epic `platform-evolution` #738 Wave 3, admission decision `docs/adr/0017-document-infrastructure-module-admission.md`) — infrastruktur metadata dokumen generik, tenant-scoped, opt-in per tenant. Modul **Official Optional Module** (lapisan ADR-0013 "Official Optional Business Foundation").

## Tujuan & batas scope

Modul ini menyediakan **infrastruktur dokumen generik** — registry, versi immutable, klasifikasi, evidence/lampiran, generic resource references, kontrol akses/audit, dan numbering sequence yang aman dari race condition — untuk dipakai ulang oleh **modul/aplikasi turunan mana pun**. Modul ini **TIDAK PERNAH**:

- Mengimplementasikan skema dokumen domain (surat, invoice, purchase order, journal batch, rekam medis, kontrak) — itu tetap dimiliki modul domainnya masing-masing.
- Menyimpan byte biner konten dokumen di kolom PostgreSQL — `content_reference`/`content_reference_kind` hanya menunjuk ke kontrak managed-object storage yang sudah disetujui (mis. `sync_storage`'s object queue key, atau URL/system reference eksternal).
- Mengintegrasikan tanda tangan elektronik/TTE, sertifikasi records-management, atau satu jadwal retensi universal.
- Mengimpor/menulis tabel modul lain secara langsung — kolaborasi lintas modul HANYA lewat capability port yang diekspor modul ini (lihat §Capability port di bawah).

## Tabel (`sql/066`–`067`)

1. **`awcms_mini_document_classifications`** — katalog klasifikasi tenant-scoped (`code`/`name`/`confidentiality_level`/`retention_reference`). `retention_reference` adalah teks bebas yang dipetakan manual ke kebijakan `data_lifecycle` (ADR-0017 §4) — bukan FK/capability call di PR ini.
2. **`awcms_mini_documents`** — registry dokumen itu sendiri: id stabil, `owner_module_key`/`document_type` (string opaque, modul ini tidak pernah membaca tabel modul lain), klasifikasi opsional, status (`active`/`superseded`/`archived`/`void`), judul/ringkasan/tanggal, confidentiality level, retention reference, dan referensi resource generik PRIMER (`resource_type`+`resource_id`). `current_version_number` adalah cache denormalisasi yang HANYA diperbarui oleh `application/document-version-service.ts`.
3. **`awcms_mini_document_versions`** — **IMMUTABLE, APPEND-ONLY** (tidak ada kolom `updated_at`/`deleted_at`, dan tidak ada statement `UPDATE`/`DELETE` terhadap tabel ini di seluruh modul — lihat header `application/document-version-service.ts`). Koreksi selalu berupa versi baru dengan `previous_version_id` menunjuk mundur.
4. **`awcms_mini_document_resource_relations`** — relasi typed TAMBAHAN dari dokumen ke resource modul lain, di LUAR referensi primer di atas. Ditulis HANYA lewat capability port.
5. **`awcms_mini_document_number_sequences`** — definisi sequence penomoran, effective-dated (SCD Type 2, pola sama `awcms_mini_organization_unit_hierarchies`) — merevisi format TIDAK PERNAH mereset/menggunakan-ulang counter.
6. **`awcms_mini_document_number_reservations`** — satu baris per nomor yang pernah dialokasikan (reserved -> committed ATAU canceled). `UNIQUE (tenant_id, sequence_id, reserved_number)` menjamin "tidak pernah reuse nomor" secara struktural.
7. **`awcms_mini_document_evidence`** — jejak evidence APPEND-ONLY untuk event numbering/versi/lifecycle dokumen.

Ketujuh tabel: `tenant_id` + `ENABLE`+`FORCE ROW LEVEL SECURITY` + index tenant-first + grant `awcms_mini_worker` read-only.

## Concurrency-safe numbering — cara kerja

`application/document-number-reservation-service.ts`'s `reserveNumber` mengunci baris definisi sequence yang SEDANG TERBUKA (`SELECT ... FOR UPDATE ... WHERE effective_to IS NULL`) sebelum membaca/menaikkan `current_value`. Dua pemanggil konkuren pada sequence YANG SAMA otomatis diserialisasi oleh row lock Postgres — pemanggil kedua baru bisa membaca setelah transaksi pertama commit/rollback. `UNIQUE (tenant_id, sequence_id, reserved_number)` adalah backstop level database: bahkan jika lock entah bagaimana terlewati, duplikat akan gagal dengan unique-violation, bukan diam-diam mengalokasikan dua kali. Dibuktikan lewat test konkurensi nyata (bukan cuma didokumentasikan) di `tests/integration/document-infrastructure.integration.test.ts` — beberapa request paralel benar-benar dikirim ke handler API yang sama, hasilnya diverifikasi tidak ada nomor duplikat.

Format nomor (`format_template`, mis. `INV/{YYYY}/{SEQ:6}`) divalidasi lewat grammar token TERBATAS (`domain/number-format-template.ts`) — parser scan karakter tunggal manual, bukan `eval`/regex bebas/dynamic code. Token yang didukung: `{SEQ}`/`{SEQ:n}` (n=1-12), `{YYYY}`, `{YY}`, `{MM}`, `{DD}`.

## Capability port — `document_resource_relations`

`application/document-resource-relation-port.ts` mengekspor `linkDocumentToResource`/`unlinkDocumentFromResource`/`listRelationsForResource`/`listRelationsForDocument` — modul LAIN meng-IMPOR dan MEMANGGIL fungsi ini langsung (in-process, pola ADR-0011 yang sama dengan `blog_content`↔`news_portal`) untuk menautkan dokumen ke salah satu resource milik mereka sendiri. Modul ini tidak pernah membaca/menulis tabel modul pemanggil, dan modul pemanggil tidak pernah menulis langsung ke `awcms_mini_document_resource_relations` (ADR-0013 §6 no-shared-table-write).

`ownerModuleKey`/`resourceType`/`resourceId` adalah string OPAQUE bagi modul ini — modul PEMANGGIL bertanggung jawab hanya pernah mengoper id yang sudah divalidasi milik tenant-nya sendiri.

## Dependency

- **Lifecycle**: `tenant_admin`, `identity_access`, `domain_event_runtime` (real producer — lihat `domain-event-runtime/domain/event-type-registry.ts`'s `DOCUMENT_INFRASTRUCTURE_*` constants).
- **Capability**: `capabilities.provides: ["document_resource_relations"]`. Tidak ada `consumes` — lihat ADR-0017 §4/§10 untuk alasan tidak ada hard-dependency ke `data_lifecycle`/`workflow_approval`/`sync_storage` di PR ini.

## Endpoint (`/api/v1/document-infrastructure/*`)

| Resource        | Endpoint                                                                                                    | Idempotency                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Classifications | `GET/POST /classifications`, `GET/PATCH/DELETE /classifications/{id}`, `POST /classifications/{id}/restore` | `POST`/`PATCH` create/update tidak; `DELETE`/`restore` wajib                                                                    |
| Documents       | `GET/POST /documents`, `GET/PATCH/DELETE /documents/{id}`, `POST /documents/{id}/{restore,void,reclassify}` | `POST create`, `DELETE`, `restore`, `void`, `reclassify` wajib Idempotency-Key (lihat catatan di bawah); `PATCH` metadata tidak |
| Versions        | `GET/POST /documents/{id}/versions`                                                                         | `POST` wajib (append-only, retry tidak boleh dobel)                                                                             |
| Relations       | `GET/POST /documents/{id}/relations`, `DELETE /documents/{id}/relations/{relationId}`                       | `POST`/`DELETE` wajib (`assign`/`revoke`)                                                                                       |
| Sequences       | `GET/POST /sequences`, `POST /sequences/{revise,deactivate,restore}`, `GET /sequences/history`              | Semua mutation wajib                                                                                                            |
| Reservations    | `GET /reservations`, `POST /reservations/reserve`, `POST /reservations/{id}/{commit,cancel}`                | Semua mutation wajib — CRITICAL untuk `reserve` (retry jaringan harus replay reservasi yang sama, bukan alokasi baru)           |
| Evidence        | `GET /evidence`                                                                                             | N/A (read-only)                                                                                                                 |

**Catatan idempotency**: `documents.create`/`versions.create` sengaja idempotency-gated MESKI `create`/`update` tidak ada di `HIGH_RISK_ACTIONS` (`identity-access/domain/access-control.ts`) — issue #751 sendiri memperingatkan eksplisit bahwa sebuah PR sibling di epic ini butuh ronde perbaikan tambahan karena pass idempotency pertamanya melewatkan endpoint `create`. Empat action baru ditambahkan ke `AccessAction`/`HIGH_RISK_ACTIONS`: `void`, `reclassify`, `reserve`, `commit` — `cancel` (reservation) reuse literal yang sudah ada TANPA menambahkannya ke `HIGH_RISK_ACTIONS` (menghindari mengubah blast radius `cancel` di modul lain); endpoint cancel reservasi modul ini tetap mewajibkan `Idempotency-Key` di level route secara independen.

**Catatan idempotency-key resource binding (Issue #795, recurring class pertama ditemukan di PR #783/#750 reference-data)**: `computeRequestHash` untuk `documents/{id}/restore`, `classifications/{id}/restore`, `documents/{id}` DELETE, `classifications/{id}` DELETE, `documents/{id}/relations/{relationId}` DELETE, `reservations/{id}/cancel`, dan `reservations/{id}/commit` kini menyertakan path param identitas resource (`id`/`relationId`) DAN literal `action` eksplisit — sebelumnya beberapa meng-hash body kosong/tanpa `id`, sehingga reuse `Idempotency-Key` lintas DUA resource berbeda bisa mereplay respons resource pertama untuk request yang seharusnya memutasi resource kedua (`request_scope` idempotency bersifat per-tipe-endpoint, dibagi seluruh resource tipe itu dalam satu tenant, bukan per-resource). `sequences/revise`/`restore`/`deactivate` DIPERIKSA dan TIDAK rentan — endpoint index-level ini mengidentifikasi resource lewat `scopeType`+`scopeId`+`sequenceKey` yang sudah bagian dari body mentah yang di-hash. Diuji adversarial di `tests/integration/document-infrastructure.integration.test.ts` (document restore, classification restore, reservation cancel).

**Catatan confidentiality-tier** (security-review Critical finding, PR #780; DIPERLUAS penuh oleh Issue #787 fast-follow): `GET /documents`, `GET /documents/{id}`, `GET /documents/{id}/versions`, `GET /documents/{id}/relations`, `GET /evidence`, dan `GET /reservations` semuanya menegakkan `confidentiality_level` — memegang `documents.read`/`versions.read`/`relations.read`/`evidence.read`/`reservations.read` dasar saja hanya memberi akses ke baris yang levelnya (atau level dokumen induknya) `public`/`internal`; membaca `confidential`/`restricted` butuh permission tambahan ADDITIF `documents_confidential.read`/`documents_restricted.read` (`068_awcms_mini_document_infrastructure_confidentiality_permissions.sql`, pola sama `visitor_analytics.raw_detail.read` — TIDAK ada migration baru untuk Issue #787, dua permission ini SUDAH cukup). Baris yang levelnya di luar clearance caller mengembalikan hasil IDENTIK dengan "tidak ditemukan" (dihilangkan dari list, `404` untuk fetch tunggal) — tidak pernah mengonfirmasi keberadaannya. Endpoint mutasi (`void`/`restore`/`reclassify`/`versions.create`/`relations.assign`/`relations.revoke`) SEKARANG JUGA mensyaratkan clearance tier yang sama terhadap CONFIDENTIALITY LEVEL SAAT INI dokumen SEBAGAI PRECONDITION (bukan permission write-tier baru — lihat ADR-0017 §7 untuk alasan reuse permission read-tier yang sama, bukan menambah `documents_confidential.write`-style baru) sebelum permission action-spesifik (`documents.void`, dst.) itu sendiri dievaluasi lebih lanjut; `GET /evidence`/`GET /reservations` memfilter baris yang tertaut ke dokumen (`document_id IS NOT NULL`) dengan cara yang sama — baris tanpa tautan dokumen (evidence sequence-only, reservasi yang belum di-commit) selalu lolos karena tidak punya dimensi confidentiality.

## Domain event (AsyncAPI: `asyncapi/awcms-mini-domain-events.asyncapi.yaml`)

`document.created`, `document.voided`, `document.restored`, `document.reclassified`, `version.created`, `number.reserved`, `number.committed`, `number.canceled` — semua diterbitkan di transaksi yang sama dengan perubahan state (`appendDomainEvent`, `domain_event_runtime`).

## Admin UI

`/admin/document-infrastructure/classifications`, `/admin/document-infrastructure/documents` (+ `/documents/{id}` detail: versi/relasi/reclassify/evidence), `/admin/document-infrastructure/sequences` (definisi sequence + reservasi: reserve/commit/cancel semuanya reachable dari layar ini — `commit` prompt id dokumen bebas teks, tidak ada picker lintas modul).

## Lima fixture netral (bukti reusability, issue #751 acceptance criterion)

`tests/integration/document-infrastructure.integration.test.ts` mendemonstrasikan modul ini dipakai ulang untuk lima skenario domain BERBEDA tanpa modul ini pernah mengetahui/mengimpor aturan domain apa pun: correspondence evidence, contract attachment, invoice reference, approval evidence, dan asset-disposal evidence — masing-masing hanya string `ownerModuleKey`/`documentType`/`resourceType` yang berbeda, bukan skema/tabel berbeda. File yang sama juga berisi negative test confidentiality-tier untuk KEEMPAT jalur baca asli (deny tanpa permission tier, allow dengan permission tier), test konkurensi numbering nyata, DAN (Issue #787) dua test tambahan: satu meng-cover keenam endpoint mutasi (`void`/`restore`/`reclassify`/`versions.create`/`relations.assign`/`relations.revoke`, masing-masing deny dengan action-permission saja lalu allow setelah tier permission ditambahkan), satu lagi meng-cover `GET /evidence`/`GET /reservations` (baris bertaut dokumen confidential disembunyikan tanpa tier, baris tanpa tautan dokumen selalu lolos).

## Belum tersedia

- Capability edge nyata ke `data_lifecycle` untuk retensi (kolom `retention_reference` tetap teks bebas sampai ada admission decision terpisah).
- Upload/download nyata lewat `sync_storage` — modul ini hanya menyimpan REFERENSI (string), tidak pernah memanggil provider penyimpanan.
- Integrasi workflow/approval (#747) untuk siklus dokumen — di luar scope PR ini.
- ~~Gating confidentiality-tier belum diterapkan pada endpoint mutasi maupun `GET /evidence`/`GET /reservations`~~ — DITUTUP oleh Issue #787 (lihat §Catatan confidentiality-tier di atas). Gating confidentiality-tier pada `reservations.reserve`/`commit`/`cancel` itu sendiri (bukan `GET /reservations`) sengaja TETAP di luar scope #787 — issue itu hanya menyebutkan enam endpoint mutasi dokumen + dua endpoint baca; commit/cancel/reserve beroperasi pada level SEQUENCE (bukan sebuah dokumen tertentu) sampai `commit` benar-benar menautkannya, titik di mana `GET /reservations` sudah memfilternya.
