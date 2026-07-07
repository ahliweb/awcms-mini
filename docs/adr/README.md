# Architecture Decision Records (ADR)

Folder ini menyimpan **catatan keputusan arsitektural** AWCMS-Mini. Setiap keputusan penting (arsitektur, runtime, kontrak, keamanan) dicatat sebagai satu berkas ADR agar konteks dan alasannya awet.

## Aturan

1. Satu keputusan = satu berkas `NNNN-judul-kebab.md` (nomor urut, nol di depan).
2. ADR **tidak dihapus**. Bila sebuah keputusan diganti, ADR lama ditandai `Status: Superseded by ADR-XXXX` dan ADR baru mereferensikannya.
3. Status yang valid: `Proposed`, `Accepted`, `Deprecated`, `Superseded`.
4. Perubahan standar yang mengikat (lihat [`GOVERNANCE.md`](../../GOVERNANCE.md)) wajib punya ADR.
5. Gunakan template di [`0000-template.md`](0000-template.md).

## Alur

```mermaid
flowchart LR
  P[Proposed] --> A[Accepted]
  A --> D[Deprecated]
  A --> S[Superseded]
  P --> R[Rejected / ditutup]
```

## Indeks

| ADR                                                        | Judul                                                                      | Status   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- | -------- |
| [0001](0001-modular-monolith-architecture.md)              | Modular monolith, microservice-ready                                       | Accepted |
| [0002](0002-bun-only-runtime.md)                           | Runtime & tooling Bun-only                                                 | Accepted |
| [0003](0003-postgresql-rls-multi-tenant.md)                | PostgreSQL + RLS untuk isolasi multi-tenant                                | Accepted |
| [0004](0004-rbac-abac-default-deny.md)                     | RBAC + ABAC default-deny sebagai baseline akses                            | Accepted |
| [0005](0005-soft-delete-and-immutability.md)               | Soft delete untuk master/config, immutability untuk data posted            | Accepted |
| [0006](0006-offline-first-sync-outbox.md)                  | Offline-first + transactional outbox + sync HMAC                           | Accepted |
| [0007](0007-openapi-asyncapi-contracts.md)                 | OpenAPI & AsyncAPI sebagai kontrak wajib                                   | Accepted |
| [0008](0008-independent-contract-and-module-versioning.md) | Versioning independen: package, kontrak API/event, module descriptor       | Accepted |
| [0009](0009-public-tenant-scoped-routes.md)                | Resolusi tenant untuk rute publik lewat path `tenantCode`, bukan subdomain | Proposed |

Detail rinci tiap keputusan tetap berada di paket dokumen `docs/awcms-mini/`; ADR merangkum **keputusan + alasan + konsekuensi**, bukan menggantikan dokumen teknis.
