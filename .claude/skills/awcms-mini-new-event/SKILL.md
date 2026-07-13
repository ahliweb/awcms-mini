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
  eventType: string; // mis. "sales.transaction.posted"
  eventVersion: string; // "1.0"
  tenantId: string;
  nodeId?: string;
  aggregateType: string; // mis. "sales_document"
  aggregateId: string;
  occurredAt: string; // ISO timestamptz
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
5. Node hybrid: event masuk `awcms_mini_sync_outbox` untuk sync (`awcms-mini-sync-hmac`).
6. **Update AsyncAPI** (`asyncapi/`) untuk event & payload baru; jalankan `api:spec:check`.

## Event inti (contoh channel nyata — bukan daftar lengkap)

`asyncapi/awcms-mini-domain-events.asyncapi.yaml` adalah satu-satunya
sumber kebenaran (51 channel terdaftar hari ini — `grep -n "^  awcms-mini\."
asyncapi/awcms-mini-domain-events.asyncapi.yaml` untuk daftar hidup
lengkap). Contoh representatif lintas modul yang BENAR-BENAR ada di sana:

- `awcms-mini.blog-content.post.published` (`blog_content`)
- `awcms-mini.social-publishing.job.published` (`social_publishing`)
- `awcms-mini.email.message.sent` (`email`)
- `awcms-mini.sync.push.requested` (baseline envelope `sync-storage`)
- `awcms-mini.database.pool.saturated` (backpressure/pooling, doc 16)

Jangan karang nama channel domain retail/POS (mis. `sales.*`/
`warehouse.*`/`tax.*`/`crm.*`) sebagai contoh — modul-modul itu tidak ada
di base repo ini, dipindahkan ke aplikasi turunan contoh (mis. AWPOS);
lihat `docs/awcms-mini/06_github_issues_detail.md` §"Riwayat perubahan
backlog" dan skill `awcms-mini-legacy-migration`. Event baru mengikuti
pola `namespace.aggregate.action` di atas, dengan `namespace` = `module_key`
modul nyata yang menerbitkannya.

## Verifikasi

```bash
bun run api:spec:check
```

Register `publishes`/`subscribes` di `module.ts` modul terkait dan perbarui tabel event di doc 05 bila menambah event inti.
