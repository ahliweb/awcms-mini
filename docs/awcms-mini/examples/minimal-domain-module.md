# Contoh Modul Domain Minimal

Issue #463. Contoh konkret satu modul domain minimal — dari struktur
folder sampai test checklist — sebagai referensi praktis untuk aplikasi
turunan yang mengikuti [`derived-application-guide.md`](../derived-application-guide.md)
§Alur membangun aplikasi turunan (9 langkah).

> **Ini adalah template, bukan modul base.** Domain contoh di sini
> (`asset-register` — pencatatan aset sederhana) sengaja netral, tidak
> mengunci ke domain nyata mana pun (bukan AWPOS, bukan Satu Sehat).
> Salin polanya, **ganti nama domain, entitas, permission, dan field**
> sesuai kebutuhan Anda — jangan salin `asset-register` apa adanya ke
> production. Tidak satu pun kode di dokumen ini ada di `src/modules/`
> base ini; base tetap bersih dari modul domain contoh.

## Struktur folder

Mengikuti pola modul aktif (`src/modules/tenant-admin/`,
`src/modules/workflow-approval/`, dst.) — `domain/` untuk logika murni
tanpa I/O, `application/` untuk orkestrasi transaksi/DB, `api/` untuk
tipe request/response spesifik endpoint bila diperlukan, route Astro
tetap di `src/pages/api/v1/...` (bukan di dalam folder modul):

```
src/modules/asset-register/
├── module.ts
├── README.md
├── domain/
│   └── asset-validation.ts       # validasi murni, tanpa DB
└── application/
    └── asset-directory.ts        # fungsi yang menerima `tx`, menjalankan query
```

Route endpoint tetap ada di `src/pages/api/v1/assets/index.ts` (atau path
sesuai domain Anda) — konsisten dengan seluruh modul aktif base ini, yang
tidak menaruh route Astro di dalam folder modul.

## `module.ts` — descriptor awal

Modul baru **selalu** mulai `version: "0.1.0"`, `status: "experimental"`
(ADR-0008) — naik ke `active`/`1.0.0` setelah memenuhi kriteria "matang"
di `derived-application-guide.md` §Kapan modul dianggap "matang":

```typescript
import { defineModule } from "../_shared/module-contract";

export const assetRegisterModule = defineModule({
  key: "asset_register",
  name: "Asset Register",
  version: "0.1.0",
  status: "experimental",
  description:
    "Pencatatan aset tenant-scoped — contoh modul domain minimal (Issue #463).",
  dependencies: ["identity_access"],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/assets"
  },
  events: {
    asyncApiPath: "asyncapi/awcms-mini-domain-events.asyncapi.yaml",
    publishes: ["awcms-mini.asset-register.asset.registered"]
  }
});
```

`dependencies: ["identity_access"]` karena modul ini memakai
`evaluateAccess`/`resolveTenantContext` milik `identity-access` — pola
yang sama seperti modul aktif lain, bukan menulis ulang RBAC/ABAC-nya
sendiri (lihat `derived-application-guide.md` §Base reusable vs
domain-specific).

## Migration PostgreSQL + RLS

**Wajib**: `tenant_id`, `ENABLE`+`FORCE ROW LEVEL SECURITY` di migration
yang sama, index berprefiks `(tenant_id, …)`. Migrasi 013 (yang
menerapkan `FORCE` ke 31 tabel) adalah backfill satu kali untuk tabel yang
sudah ada saat itu — **tidak** otomatis meng-cover tabel baru. Tabel
domain baru manapun **harus** menyertakan `FORCE` sendiri di migration
yang membuatnya, seperti contoh berikut:

```sql
-- NNN_awcms_mini_asset_register_schema.sql — contoh modul domain minimal (Issue #463).

CREATE TABLE IF NOT EXISTS awcms_mini_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_mini_tenants (id),
  asset_code text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  CONSTRAINT awcms_mini_assets_status_check
    CHECK (status IN ('active', 'retired'))
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_mini_assets_code_dedup
  ON awcms_mini_assets (tenant_id, asset_code)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_mini_assets_tenant_idx
  ON awcms_mini_assets (tenant_id);

-- ENABLE dan FORCE wajib SATU migration yang sama — jangan pisah ke
-- migration terpisah, dan jangan lupakan FORCE (lihat 013's finding: RLS
-- tanpa FORCE tidak berlaku untuk owner/migrasi role).
ALTER TABLE awcms_mini_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_mini_assets FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_mini_assets_tenant_isolation
  ON awcms_mini_assets
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Grant DML ke role least-privilege aplikasi (sql/013 membuat role ini;
-- tabel baru tetap perlu grant eksplisit sendiri).
GRANT SELECT, INSERT, UPDATE, DELETE ON awcms_mini_assets TO awcms_mini_app;
```

Skill terkait: `awcms-mini-new-migration` (konvensi penomoran, checksum
runner) — jangan menulis migration di luar pola `NNN_awcms_mini_<area>_<desc>.sql`.

## Seed permission/role/policy (pola doc 17)

Domain baru menambah permission-nya sendiri, mengikuti pola penamaan
`<module>.<resource>.<action>` yang sudah dipakai modul aktif (bukan
menyalin isi ilustratif doc 17, hanya polanya):

```sql
INSERT INTO awcms_mini_permissions (key, module_key, description) VALUES
  ('asset_register.asset.read', 'asset_register', 'Lihat daftar aset tenant'),
  ('asset_register.asset.write', 'asset_register', 'Buat/ubah aset tenant')
ON CONFLICT (key) DO NOTHING;
```

Assign permission ke role lewat `awcms_mini_role_permissions` seperti pola
modul lain — **tidak ada grant implisit**: tanpa baris di tabel ini, ABAC
default-deny menolak semua akses ke permission baru.

## Service/application function

`application/asset-directory.ts` — menerima transaksi (`tx`) dari
`withTenant`, tidak membuka koneksi sendiri:

```typescript
export type RegisterAssetInput = {
  tenantId: string;
  assetCode: string;
  name: string;
};

export async function registerAsset(
  tx: Bun.TransactionSQL,
  input: RegisterAssetInput
) {
  const rows = await tx`
    INSERT INTO awcms_mini_assets (tenant_id, asset_code, name)
    VALUES (${input.tenantId}, ${input.assetCode}, ${input.name})
    RETURNING id, asset_code, name, status, created_at
  `;

  return rows[0];
}
```

Validasi murni (format `asset_code`, panjang `name`, dst.) tetap di
`domain/asset-validation.ts` tanpa import DB apa pun — dipanggil dari
route sebelum `application/` dijalankan, konsisten dengan pemisahan
domain/application modul aktif lain.

## Endpoint REST — route tipis

Pola standar (auth → tenant context → ABAC guard → validasi → idempotency
bila high-risk → service+transaksi → response helper), meniru struktur
nyata `src/pages/api/v1/reports/tenant-activity.ts`:

```typescript
// src/pages/api/v1/assets/index.ts
import type { APIRoute } from "astro";
import { fail, ok } from "../../../../modules/_shared/api-response";
import { getDatabaseClient } from "../../../../lib/database/client";
import { withTenant } from "../../../../lib/database/tenant-context";
import { hashSessionToken } from "../../../../lib/auth/session-token";
import { extractBearerToken } from "../../../../modules/identity-access/application/session-lookup";
import {
  fetchGrantedPermissionKeys,
  resolveTenantContext
} from "../../../../modules/identity-access/application/auth-context";
import { recordDecisionLog } from "../../../../modules/identity-access/application/decision-log";
import { evaluateAccess } from "../../../../modules/identity-access/domain/access-control";
import { recordAuditEvent } from "../../../../modules/logging/application/audit-log";
import { registerAsset } from "../../../../modules/asset-register/application/asset-directory";
import { validateAssetInput } from "../../../../modules/asset-register/domain/asset-validation";

const GUARD_REQUEST = {
  moduleKey: "asset_register",
  activityCode: "asset",
  action: "write" as const
};

export const POST: APIRoute = async ({ request }) => {
  const tenantId = request.headers.get("x-awcms-mini-tenant-id");
  if (!tenantId) {
    return fail(400, "TENANT_REQUIRED", "Tenant header is required.");
  }

  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) {
    return fail(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const body = await request.json();
  const validation = validateAssetInput(body);
  if (!validation.valid) {
    return fail(400, "VALIDATION_ERROR", validation.message);
  }

  const sql = getDatabaseClient();
  const tokenHash = hashSessionToken(token);
  const now = new Date();

  return withTenant(
    sql,
    tenantId,
    async (tx) => {
      const context = await resolveTenantContext(tx, tenantId, tokenHash, now);
      if (!context) {
        return fail(401, "AUTH_REQUIRED", "Session is invalid or expired.");
      }

      const grantedPermissionKeys = await fetchGrantedPermissionKeys(
        tx,
        tenantId,
        context.tenantUserId
      );
      const decision = evaluateAccess(
        context,
        GUARD_REQUEST,
        grantedPermissionKeys
      );
      await recordDecisionLog(
        tx,
        tenantId,
        context.tenantUserId,
        GUARD_REQUEST,
        decision
      );

      if (!decision.allowed) {
        return fail(403, "ACCESS_DENIED", decision.reason);
      }

      const asset = await registerAsset(tx, {
        tenantId,
        assetCode: body.assetCode,
        name: body.name
      });

      // High-risk domain action -> audit trail (doc 10/12/13 checklist).
      await recordAuditEvent(tx, {
        tenantId,
        actorTenantUserId: context.tenantUserId,
        moduleKey: "asset_register",
        action: "asset.registered",
        resourceType: "asset",
        resourceId: asset.id,
        message: `Asset ${asset.asset_code} registered.`
      });

      return ok(asset);
    },
    { workClass: "interactive" }
  );
};
```

Bila endpoint ini dianggap mutation high-risk yang perlu aman diulang
(retry client), tambahkan parameter `Idempotency-Key` dan bungkus dengan
`findIdempotencyRecord`/`saveIdempotencyRecord`
(`src/modules/_shared/idempotency.ts`) — skill `awcms-mini-idempotency`
menjelaskan pola lengkapnya; contoh nyatanya ada di endpoint keputusan
workflow (`src/pages/api/v1/workflows/tasks/[id]/decisions.ts`).

## Snippet OpenAPI

Sejak Issue #695 (epic #679), `openapi/awcms-mini-public-api.openapi.yaml`
adalah artefak GENERATED — jangan edit langsung. Tambahkan path baru ke
fragment sumber modul ini, `openapi/modules/<module-key>.openapi.yaml`
(bikin baru bila modul ini belum punya satu — satu file per
modul/tag, jangan campur dengan modul lain), lalu jalankan
`bun run openapi:bundle` untuk regenerate file bundle publikasi. Kontrak
yang DIPUBLIKASIKAN tetap tunggal (ADR-0007) — hanya representasi sumber
yang sekarang dipecah per modul, lihat `openapi/README.md`:

```yaml
/api/v1/assets:
  post:
    tags:
      - Asset Register
    summary: Register a new asset for the caller's tenant
    operationId: assetsRegisterAsset
    security:
      - bearerAuth: []
        tenantHeader: []
    parameters:
      - $ref: "#/components/parameters/CorrelationId"
      - $ref: "#/components/parameters/RequestId"
    requestBody:
      required: true
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/AssetRegisterRequest"
    responses:
      "200":
        description: Asset registered.
        content:
          application/json:
            schema:
              allOf:
                - $ref: "#/components/schemas/ApiSuccess"
                - type: object
                  required: [data]
                  properties:
                    data:
                      $ref: "#/components/schemas/AssetResponse"
      "400":
        $ref: "#/components/responses/BadRequest"
      "401":
        $ref: "#/components/responses/Unauthorized"
      "403":
        $ref: "#/components/responses/Forbidden"
      "500":
        $ref: "#/components/responses/InternalError"
```

`AssetRegisterRequest`/`AssetResponse` didefinisikan sekali di
`components.schemas` fragment modul ini (atau di
`openapi/awcms-mini-public-api.src.yaml` bila genuinely dipakai 2+ modul),
sama seperti skema modul aktif lain. Jalankan `bun run openapi:bundle` lalu
`bun run api:spec:check` setelah menambah path — pemeriksaan ini gagal bila
`info.version` bukan SemVer, path/schema tidak konsisten (ADR-0008), bundle
basi relatif terhadap fragment sumber, `operationId` duplikat, path
parameter tidak cocok, response error bukan `ApiError`, atau security
metadata tidak eksplisit (Issue #695).

## Snippet AsyncAPI (bila mutation menghasilkan event domain)

Tambahkan channel baru ke `asyncapi/awcms-mini-domain-events.asyncapi.yaml`
hanya bila mutation ini perlu disinkronkan lintas node (outbox) atau
dikonsumsi async oleh sistem lain — bukan wajib untuk setiap endpoint:

```yaml
channels:
  awcms-mini.asset-register.asset.registered:
    address: awcms-mini.asset-register.asset.registered
    messages:
      DomainEvent:
        $ref: "#/components/messages/DomainEvent"
    description: Emitted when a new asset is registered for a tenant.
operations:
  publishAssetRegistered:
    action: send
    channel:
      $ref: "#/channels/awcms-mini.asset-register.asset.registered"
    messages:
      - $ref: "#/channels/awcms-mini.asset-register.asset.registered/messages/DomainEvent"
```

Konsisten dengan pola base: dokumentasi kontrak ini tidak mensyaratkan
dispatcher pub/sub konkret — payload event yang sama bisa dikirim lewat
sync outbox yang sudah ada (`awcms_mini_sync_outbox`, Issue 6.1) bila
aplikasi turunan butuh sinkronisasi offline-first.

## Checklist layar UI/admin

- [ ] Token desain base dipakai (bukan warna/spacing hardcode) — doc 14.
- [ ] 4-state pattern: loading, empty, error, ready.
- [ ] Aksesibilitas WCAG 2.1 AA (label, fokus, kontras) — skill `awcms-mini-ux-review` untuk audit setelah layar jadi.
- [ ] Semua string lewat katalog `.po` (skill `awcms-mini-i18n`), bukan hardcode Bahasa Indonesia/Inggris langsung di komponen.
- [ ] Aksi high-risk (mis. retire asset) menampilkan konfirmasi eksplisit sebelum submit.

## Checklist test

- [ ] **Unit** — `domain/asset-validation.ts` diuji tanpa DB (kasus valid/invalid, boundary format `asset_code`).
- [ ] **Integration** — endpoint `POST /api/v1/assets` diuji terhadap PostgreSQL nyata (bukan mock): tenant isolation, ABAC allow/deny, response shape.
- [ ] **Keamanan** — uji RLS benar-benar `FORCE` (query lintas tenant harus 0 baris, bukan hanya "terlihat benar" di path bahagia); uji ABAC default-deny (permission belum diseed → akses ditolak).
- [ ] **Kontrak** — `bun run api:spec:check` hijau setelah path/schema baru ditambahkan.

## Checklist keamanan sebelum dianggap siap produksi

Turunan langsung dari `derived-application-guide.md` §Checklist keamanan
& kepatuhan praktis, diterapkan ke domain contoh ini:

- [ ] Tenant context lewat `withTenant()`/`resolveTenantContext` — tidak ada `WHERE tenant_id` manual dari input klien.
- [ ] ABAC default-deny — permission `asset_register.asset.write`/`.read` diseed eksplisit, tidak ada grant implisit.
- [ ] RLS `ENABLE`+`FORCE` di migration yang sama, policy isolasi tenant, index berprefiks `(tenant_id, …)`.
- [ ] Audit — `asset.registered` (dan aksi high-risk domain lain, mis. retire) menghasilkan baris `awcms_mini_audit_events` via `recordAuditEvent`.
- [ ] Idempotency — bila endpoint dianggap high-risk/retry-sensitive, terima `Idempotency-Key`.
- [ ] Redaksi — bila entitas domain Anda punya identifier sensitif (NIK, nomor rekam medis, dst.), terapkan redaksi/masking yang sama seperti pola NPWP/NIK/email di base sebelum simpan/tampil/log.
- [ ] `bun run api:spec:check` hijau.
- [ ] `bun run production:preflight` hijau sebelum go-live.

## Lihat juga

- [`derived-application-guide.md`](../derived-application-guide.md) — alur
  9 langkah lengkap, tabel base-reusable vs domain-specific, dan lima
  contoh aplikasi turunan ilustratif.
- `.claude/skills/README.md` — katalog skill (`awcms-mini-new-module`,
  `awcms-mini-new-migration`, `awcms-mini-new-endpoint`,
  `awcms-mini-new-event`, `awcms-mini-abac-guard`, `awcms-mini-idempotency`,
  `awcms-mini-audit-log`, `awcms-mini-testing`, `awcms-mini-security-review`).
- `src/modules/tenant-admin/`, `src/modules/workflow-approval/` — contoh
  modul aktif nyata yang mengikuti struktur folder yang sama.
