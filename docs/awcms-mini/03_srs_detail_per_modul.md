# Bagian 3 — SRS Detail Per Modul

> **Contoh domain (ilustratif).** Dokumen ini memakai domain retail/POS bergaya AWPOS sebagai contoh berjalan. **Pola & standar**-nya reusable untuk base AWCMS-Mini; **entitas, endpoint, layar, dan istilah domain** (produk, POS, gudang, pajak, CRM, AI, dsb.) adalah ilustrasi yang **diganti** oleh aplikasi turunan. Lihat [README paket dokumen](README.md) §Reusable vs domain turunan.

## Tujuan SRS

Dokumen ini menjabarkan kebutuhan teknis AWCMS-Mini per modul, mencakup functional requirement, non-functional requirement, validation, audit, security, dan integration point.

## Pipeline request lintas modul

```mermaid
sequenceDiagram
  participant C as Client
  participant A as Auth MW
  participant T as Tenant/RLS MW
  participant G as ABAC Guard
  participant I as Idempotency MW
  participant S as Service (transaction)
  participant DB as PostgreSQL
  participant AU as Audit
  C->>A: Request + Bearer token
  A->>A: Validasi token
  A->>T: Set tenant context
  T->>DB: SET app.current_tenant_id
  T->>G: Evaluasi akses (default deny)
  G-->>C: 403 ACCESS_DENIED (jika ditolak)
  G->>I: Cek Idempotency-Key (mutation high-risk)
  I-->>C: 409 IDEMPOTENCY_CONFLICT (jika hash beda)
  I->>S: Jalankan service
  S->>DB: Query/mutation (FOR UPDATE bila stok)
  S->>AU: Audit high-risk
  S-->>C: Response standar (data ter-mask)
```

## Requirement umum lintas modul

### Multi-tenant

- Semua tabel tenant-scoped wajib memiliki `tenant_id`.
- Semua query tenant-scoped wajib memfilter tenant aktif.
- RLS wajib aktif pada tabel tenant-scoped.
- Tenant context wajib diset dalam transaction.

### Security

- Auth wajib kecuali endpoint public eksplisit.
- ABAC default deny.
- Data sensitif wajib dimasking.
- Error response tidak boleh expose stack trace.
- Provider secret hanya dari environment.

### Transaction safety

- Mutation high-risk wajib `Idempotency-Key`.
- Transaksi POS wajib atomic.
- Stock row/bin balance yang berubah wajib dikunci.
- Posted sales document immutable.
- Movement stok append-only.

### Soft delete

- Resource master/config/draft yang deletable wajib memakai soft delete: isi `deleted_at`, `deleted_by`, dan `delete_reason`; jangan `DELETE` fisik pada jalur operasional normal.
- Query list/detail default wajib `deleted_at IS NULL`; include archived/deleted hanya lewat permission eksplisit dan parameter API terdokumentasi.
- Restore dan purge adalah aksi high-risk: butuh ABAC, audit, dan idempotency bila endpoint mutation dapat diulang.
- Posted sales document, posted stock movement, audit log, security event, sync conflict, VAT invoice exported/accepted, dan Coretax batch exported tidak boleh di-soft-delete; koreksi lewat reversal/cancel/return/adjustment atau status lifecycle.
- Soft-deleted record tetap tenant-scoped, tetap terkena RLS, dan tetap masuk retention/legal hold.

### Audit

Audit wajib untuk:

- Login failed/success.
- Access assignment.
- Profile merge.
- Product price change.
- Soft delete, restore, dan purge resource tenant-scoped.
- Transaction posted/cancel/return.
- Stock adjustment.
- Warehouse transfer.
- Coretax export.
- Sync conflict resolution.
- AI tool call.
- Security readiness decision.

## 1. Tenant Admin

### Functional requirement

- Sistem dapat membuat tenant pertama melalui setup wizard.
- Sistem dapat membuat office dengan tipe `head_office`, `branch`, `store`, `warehouse`, `other`.
- Sistem dapat mengunci setup setelah selesai.
- Sistem dapat menonaktifkan tenant/office.

### Validation

- `tenant_code` unik.
- `office_code` unik per tenant.
- Setup initialize ditolak jika setup locked.

### Security

- Endpoint setup hanya public sebelum setup locked.
- Setelah locked, setup initialize ditolak.
- Tenant inactive tidak dapat dipakai transaksi.

## 2. Identity & Access

### Functional requirement

- User dapat login.
- User terkait ke tenant melalui `tenant_user`.
- Role dapat diassign.
- ABAC mengevaluasi action berdasarkan module, activity, resource, context, dan environment.

### Validation

- Password wajib memenuhi policy.
- Login identifier unik.
- Tenant user inactive ditolak.

### Security

- Password disimpan dalam hash modern.
- Failed login dicatat.
- Default deny.
- Deny overrides allow.

## 3. Central Profile

### Functional requirement

- Membuat profile person/organization.
- Menambahkan identifier.
- Resolve profile berdasarkan email/phone/WhatsApp/NPWP/NIK/customer code.
- Link profile ke entity lintas modul.
- Merge profile melalui workflow.

### Validation

- Identifier dinormalisasi.
- Identifier hash unik per tenant/type.
- Profile merge tidak boleh source = target.

### Security

- Identifier sensitif dimasking.
- Raw value tidak tampil ke response umum.
- Merge high-risk diaudit dan membutuhkan approval.

## 4. Catalog & Inventory

### Functional requirement

- CRUD produk.
- Product search by SKU, barcode, nama.
- Harga aktif berdasarkan periode.
- Stok per office.
- Stock movement append-only.

### Validation

- SKU unik per tenant.
- Barcode unik jika ada.
- Quantity tidak boleh negatif kecuali movement delta yang valid.
- Product inactive tidak boleh dijual.

### Security

- Price update butuh permission.
- Adjustment stok butuh reason dan audit.

## 5. Sales POS

### Functional requirement

- Membuat checkout.
- Menambahkan/mengubah/menghapus item.
- Menghitung total server-side.
- Menambahkan payment.
- Posting transaksi.
- Membuat sales document, lines, payments, stock movements, audit, domain event.

### Validation

- Checkout status harus `draft` atau `held` sebelum posting.
- Payment cukup.
- Stock tersedia.
- Idempotency key wajib.

### Security

- Kasir hanya akses office sesuai ABAC.
- Discount mengikuti permission.
- Error stok user-friendly.
- Provider eksternal tidak dipanggil dalam DB transaction.

## 6. Shared Stock Routing

### Functional requirement

- Membuat stock pool.
- Menambahkan member tenant.
- Mapping product antar tenant.
- Routing transaksi berdasarkan rule.
- Mencatat routing decision.

### Validation

- Rule harus punya legal basis.
- Effective date valid.
- Target tenant harus member pool.

### Security

- Routing rule create/approve butuh permission.
- Routing decision diaudit.

## 7. Warehouse Management

### Functional requirement

- Warehouse dari office.
- Zone dan bin.
- Bin balance.
- Lot/batch/serial/expired.
- Transfer order, shipment, receipt.
- In-transit balance.
- Cycle count.
- Stock adjustment request.

### Validation

- Source dan destination warehouse tidak boleh sama.
- Ship tidak boleh melebihi approved quantity.
- Receive tidak boleh melebihi shipped quantity.
- Expired/damaged masuk quarantine.

### Security

- Warehouse scope via ABAC.
- Adjustment membutuhkan reason.
- High-risk adjustment membutuhkan approval.

## 8. Accounting Tax/Coretax

### Functional requirement

- Tax profile tenant.
- Tax business unit/NITKU.
- Party tax profile.
- Product tax profile.
- Generate VAT invoice dari sales posted.
- Validate VAT invoice.
- Coretax XML batch export.

### Validation

- Missing NPWP/NITKU/product tax profile menghasilkan error validasi.
- VAT invoice exported/accepted locked.
- Batch export menyimpan checksum.

### Security

- Tax data dimasking untuk non-tax role.
- Export membutuhkan audit dan approval jika policy aktif.

## 9. CRM Communication

### Functional requirement

- Generate receipt PDF.
- Simpan file lokal.
- Queue WhatsApp/email message.
- Dispatch via provider saat online.
- Retry failed message.
- Customer portal tokenized.

### Validation

- Consent wajib aktif.
- Channel valid.
- Receipt PDF harus tersedia.

### Security

- Provider API key dari env.
- Phone/email dimasking.
- Token receipt tidak sequential.

## 10. Sync Storage

### Functional requirement

- Register sync node.
- Push/pull event.
- Store checkpoint.
- Detect conflict.
- Resolve conflict manual.
- Upload object queue to R2 optional.

### Validation

- HMAC valid.
- Timestamp anti replay.
- Duplicate event idempotent.

### Security

- Node inactive ditolak.
- Posted transaction immutable.
- Conflict high-risk butuh audit.

## 11. AI Business Analyst

### Functional requirement

- Chat endpoint.
- Safe aggregate tools.
- Tool policy.
- Audit tool call.

### Security

- Read-only.
- No raw SQL.
- No mutation.
- No raw PII/tax identity.

## 12. UI Experience

### Functional requirement

- Admin dashboard.
- POS fullscreen.
- Customer receipt portal.
- Navigation role-aware.
- Dark/light/system theme.
- i18n minimal ID/EN.

### Security

- UI hiding bukan kontrol utama.
- Backend tetap validasi permission.

## 13. Observability, Pooling, Workflow, Security

### Functional requirement

- Structured log.
- Audit log.
- Pool health.
- Backpressure.
- Workflow approval.
- Security readiness.
- Go-live gates.

### Security

- Redaction wajib.
- Critical security control fail memblokir go-live.

## Error code standar

```mermaid
flowchart TD
  E[Exception di service] --> K{Tipe error}
  K -->|Validasi| V[400 VALIDATION_ERROR]
  K -->|Belum login| A1[401 AUTH_REQUIRED]
  K -->|Tak berhak| A2[403 ACCESS_DENIED]
  K -->|Idempotency| I[400/409 IDEMPOTENCY_*]
  K -->|Stok kurang| ST[409 STOCK_NOT_AVAILABLE]
  K -->|Konflik sync| SY[409 SYNC_CONFLICT]
  K -->|Pool sibuk| D[503 DATABASE_BUSY]
  K -->|Tak terduga| IN[500 INTERNAL_ERROR<br/>tanpa stack trace]
  V & A1 & A2 & I & ST & SY & D & IN --> R[Response error standar + correlationId]
```

| Code                   | HTTP | Arti                        |
| ---------------------- | ---: | --------------------------- |
| `VALIDATION_ERROR`     |  400 | Data tidak valid            |
| `AUTH_REQUIRED`        |  401 | Belum login                 |
| `ACCESS_DENIED`        |  403 | Tidak punya akses           |
| `TENANT_REQUIRED`      |  400 | Tenant wajib                |
| `RESOURCE_NOT_FOUND`   |  404 | Resource tidak ditemukan    |
| `IDEMPOTENCY_REQUIRED` |  400 | Idempotency key wajib       |
| `IDEMPOTENCY_CONFLICT` |  409 | Key dipakai request berbeda |
| `STOCK_NOT_AVAILABLE`  |  409 | Stok tidak cukup            |
| `SYNC_CONFLICT`        |  409 | Konflik sync                |
| `DATABASE_BUSY`        |  503 | Pool/DB sibuk               |
| `INTERNAL_ERROR`       |  500 | Kesalahan internal          |

## Testing requirement minimum

- Unit test untuk business logic.
- Integration test untuk migration, RLS, POS posting, warehouse transfer.
- API contract test untuk OpenAPI.
- AsyncAPI event validation.
- Security test untuk cross-tenant dan access denied.
- Performance test untuk POS concurrent dan DB pool.
