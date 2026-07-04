---
name: awcms-mini-new-event
description: Tambah atau ubah domain event AWCMS-Mini. Gunakan saat mem-publish event baru (mis. sales.transaction.posted), mengubah payload event, atau menambah subscriber. Menegakkan envelope event standar dan update AsyncAPI sesuai doc 05.
---

# AWCMS-Mini — New / Changed Domain Event

Ikuti `docs/awcms-mini/05_openapi_asyncapi_detail.md`.

## Envelope wajib

```ts
type DomainEventEnvelope<TPayload> = {
  eventId: string;
  eventType: string;        // mis. "sales.transaction.posted"
  eventVersion: string;     // "1.0"
  tenantId: string;
  nodeId?: string;
  aggregateType: string;    // mis. "sales_document"
  aggregateId: string;
  occurredAt: string;       // ISO timestamptz
  actor?: { tenantUserId?: string; profileId?: string };
  correlationId?: string;
  causationId?: string;
  payload: TPayload;
  metadata: { sourceModule: string; schemaVersion: string };
};
```

## Aturan

1. Nama event `namespace.aggregate.action` (lowercase, titik).
2. Bump `eventVersion`/`schemaVersion` bila payload berubah tidak-kompatibel.
3. **Payload tidak boleh** membawa raw PII/tax identity (mask dulu — `awcms-mini-sensitive-data`).
4. Publish **setelah** commit transaction (atau lewat outbox), bukan menggantikan audit.
5. Node hybrid: event masuk `awcms-mini_sync_outbox` untuk sync (`awcms-mini-sync-hmac`).
6. **Update AsyncAPI** (`asyncapi/`) untuk event & payload baru; jalankan `api:spec:check`.

## Event inti (producer → consumer)

- `sales.transaction.posted` → Inventory, Tax, CRM, Sync, Reporting, Audit.
- `warehouse.transfer.shipped/received` → Inventory, Sync, Reporting.
- `tax.vat_invoice.generated`, `tax.coretax.batch_exported` → Reporting, Audit.
- `crm.message.sent`, `sync.conflict.detected`, `workflow.task.approved`, `security.golive.blocked`.

## Verifikasi

```bash
bun run api:spec:check
```

Register `publishes`/`subscribes` di `module.ts` modul terkait dan perbarui tabel event di doc 05 bila menambah event inti.
