---
name: awcms-mini-service-catalog
description: Kerjakan bagian mana pun dari modul service_catalog AWCMS-Mini (Issue #870, epic #868 SaaS control plane Wave 1, ADR-0022) — modul control-plane PERTAMA. Gunakan saat menambah/mengubah endpoint di src/modules/service-catalog, saat modul lain mengontribusikan feature/meter key lewat ModuleDescriptor.serviceCatalog, saat menyentuh lifecycle offer (draft/validate/publish/retire), saat mengubah projection published/immutability, atau saat menyentuh mekanisme default-disabled (defaultTenantState). Merangkum batas control-plane vs tenant-plane, RLS-free published-only (Medium-1), immutability offer, dan fail-closed key registry.
---

# AWCMS-Mini — Service Catalog Module

`service_catalog` (`src/modules/service-catalog`, Issue #870, epic #868 SaaS
control plane Wave 1, **ADR-0022**) adalah **modul control-plane PERTAMA** —
Official Optional Business Foundation, **opt-in per tenant, default-disabled**.
Katalog plan/offer SaaS berversi provider-neutral. **Bukan** ERP item/product
master (ADR-0013 §3). Baca `src/modules/service-catalog/README.md` +
`docs/adr/0022-*.md` sebelum mengubah.

## Invariant yang WAJIB dijaga (dari ADR-0022 — dipakai #871-#877)

1. **Default-disabled = MEKANISME + GATE, bukan prosa (§7/Medium-3).** Modul ini
   memperkenalkan `ModuleDescriptor.defaultTenantState` +
   `isModuleTenantEnabledByDefault` (`_shared/module-contract.ts`), dibaca di
   EMPAT titik resolusi: `resolveModuleEnabled` (auth-context, gate API/route),
   SSR permission gate (`lib/auth/ssr-session.ts`), nav registry, tenant-module
   matrix. Tanpa baris `awcms_mini_tenant_modules` eksplisit, ketujuh key
   control-plane resolve **disabled**. Gate:
   `tests/unit/module-governance-default-disabled.test.ts` — GAGAL bila salah
   satu control-plane key resolve enabled tanpa baris. Modul control-plane baru
   WAJIB set `defaultTenantState: "disabled"` + masuk daftar gate.

2. **Boundary control-plane ↔ tenant-plane (ADR Consequences).**
   `tests/unit/module-boundary.test.ts` menegakkan: (a) tak ada modul lain
   meng-import `service-catalog/application|domain` (tenant-plane baca lewat
   port `service_catalog_read` saja, di-wire di composition-root-nya sendiri);
   (b) no-shared-table-write — hanya modul service_catalog menulis
   `awcms_mini_service_catalog_*`; (c) port file = neutral ground. Pola ini
   registry-wide; modul control-plane #871+ tinggal tambah key/prefix-tabelnya.

3. **RLS-free HANYA baris published + effective-dated (§3/Medium-1).** SEMUA
   tabel katalog GLOBAL (no tenant_id, terdaftar di `RLS_FREE_TABLES` +
   `ALLOWED_GLOBAL_TABLE_GRANTS` di `scripts/security-readiness.ts`). TAPI:
   Tier A (authoring: plans/versions/features/quotas/prices — termasuk draft &
   harga `internal`) operator-only + default-deny; Tier B
   (`awcms_mini_service_catalog_published_offers`) tenant-readable, **secara
   fisik tak bisa** memuat draft/harga-internal (hanya published + subset harga
   `public`). `service_catalog_read` HANYA baca Tier B. Least-privilege: DELETE
   di-revoke pada `..._plans` + `..._published_offers`.

4. **Offer published IMMUTABLE (§3).** Ditegakkan 2 lapis: application
   (`plan-directory.ts` tolak edit versi non-draft) + DB `BEFORE` trigger
   (sql/079: `guard_version_immutability` + `guard_child_immutability`).
   Koreksi = versi BARU (`createDraftVersion` → edit → publish), bukan edit
   in-place. Mutation-guard test membuktikan gate nyata.

5. **Fail-closed key registry (§security).** `domain/key-registry.ts`: module
   key = `listModules()` keys; feature/meter key = union
   `ModuleDescriptor.serviceCatalog.contributes{Feature,Meter}Keys`. Key tak
   dikenal → DITOLAK (bukan diterima diam) di draft-edit/validate/publish.
   Kontribusi aplikasi turunan lewat `application-registry.ts` — jangan edit
   base registry. #874 menambah conformance gate di atas seam ini.

6. **Uang EXACT minor-unit.** `amount_minor bigint`, `limit_value bigint` — NO
   float/double. Validasi `Number.isInteger` + bound. Harga per komponen wajib
   currency == currency versi.

7. **Idempotency + audit + event.** create/versions/publish/retire wajib
   `Idempotency-Key` (hash BER-resource-id: planKey[+version]). publish/retire
   emit `awcms-mini.service-catalog.offer.{published,retired}` (v1.0) via
   `appendDomainEvent` dalam tx yang sama + `recordAuditEvent`. Event terdaftar
   di `domain-event-runtime/domain/event-type-registry.ts` + AsyncAPI channel +
   operation + `module.ts` events.publishes (parity di-gate).

## Pola concurrency SERAGAM (template Wave-1, dipakai #871-#877)

SETIAP operator write path di `application/plan-directory.ts` wajib pola SAMA —
tak ada satu pun check-then-write tanpa lock:

1. **Row-lock SEBELUM check-then-write.** `SELECT ... FOR UPDATE` pada row yang
   akan ditransisikan DULU: publish/retire lock row **version**
   (`loadVersionByPlanKeyForUpdate`); updatePlanDraft lock **draft version**
   (`loadDraftVersionForUpdate`) SEBELUM sentuh plan header (Codex-D: cegah
   projeksi published simpan plan_name/type LAMA saat header di-PATCH konkuren);
   createDraftVersion lock row **plan** (`loadPlanIdForUpdate`) sebelum cek
   `draft_exists` (Codex-E: cegah 2 draft konkuren → unique violation 500).
2. **UPDATE ter-predikat status.** `UPDATE ... WHERE id=? AND status=<expected>`;
   0-row = konflik idempoten bersih → caller kembalikan **409 deterministik**,
   TANPA event/audit kedua.
3. **INSERT-ber-uniqueness → `ON CONFLICT DO NOTHING RETURNING`.** Bila belum ada
   row utk di-lock (createPlan): concurrent same-key → 0-row → `duplicate_key`
   (409) bersih, bukan raw 23505 (500).

Deteksi unique violation manual (jika perlu catch): `String(error.errno) ===
"23505"` (pola repo, `profile-identity/application/identifier-directory.ts`).
Tiap path punya test konkurensi (1 pemenang + 1 409 bersih; publish/retire tepat
1 event + 1 audit) di `service-catalog.integration.test.ts`.

## PELAJARAN KUNCI keamanan/integritas (template #871-#877)

Dari audit adversarial 5-lensa (10 defect di PR #885). Terapkan ke SEMUA modul control-plane:

1. **Fingerprint/hash tenant-facing = HANYA atas bentuk projeksi tenant-visible.**
   `offerHash` disimpan di projeksi + dikembalikan `service_catalog_read` → JANGAN hash
   data operator-only (harga internal) lalu ekspos = ORACLE brute-force. Hash atas
   publicPrices+features+quotas+metadata saja. Properti: hash berubah IFF offer
   tenant-visible berubah.
2. **DB immutability trigger COVER SEMUA tabel+kolom+reparent+identity-key, bukan hanya konten.**
   Grant REVOKE DELETE TAK cukup (publish/retire perlu UPDATE) → pakai BEFORE trigger.
   Bekukan: plan_versions (status backward + konten + provenance published__/retired__),
   child (frozen non-draft + LARANG reparent `version_id` change + cek KEDUA parent OLD&NEW),
   plan_key (immutable), published_offers (semua kolom kecuali retired_at).
   Child trigger pakai `COALESCE(NEW,OLD)` bug: `WHERE id=COALESCE(NEW.version_id,OLD.version_id)`
   pada UPDATE selalu resolve NEW → OLD parent (published) tak dicek → reparent bypass.
3. **Idempotency replay HARUS menang atas business-conflict pada race same-key.**
   DB row-lock/ON CONFLICT selesaikan race SEBELUM saveIdempotencyRecord → framework
   `IdempotencyRaceLostError.replay` tak terpicu → loser dapat 409 padahal operasi SUKSES
   (oleh winner same-key). FIX: di cabang business-conflict, panggil
   `replayConcurrentIdempotentWinner` (re-query findIdempotencyRecord) SEBELUM 409 → replay
   200 winner bila hash cocok. Wire di SEMUA route mutasi. Helper di `_shared/idempotency.ts`.
4. **Fail-closed present-but-invalid utk SEMUA field, bukan sebagian.**
   `asBool(x, true)` kembalikan true utk non-boolean → feature yang dimaksud OFF tersimpan ON.
   `x || default` coerce empty-string → default. FIX: default HANYA saat ABSENT (`"key" in record`);
   nilai HADIR diteruskan verbatim → validator domain tolak (typeof boolean / enum includes).
   Terapkan enabled/trialEnabled/isUnlimited (boolean) + interval/resetPolicy/planType/visibility/
   featureKind (enum). Pakai strict `=== true` di logika (truthy string jangan lolos).
5. **Partial-column UPDATE utk PATCH header** (lost-update): dua PATCH field beda, yang kedua
   merge dari read pra-lock STALE → menimpa. FIX: `SET col = CASE WHEN <provided> THEN <new>
ELSE col END` — tulis hanya kolom yang disediakan (ELSE baca nilai live di bawah row-lock UPDATE).
6. **Audit action DISKRIMINATIF:** createDraftVersion action='create' (bukan 'update' identik
   updatePlanDraft) → bisa dibedakan di trail (resource_type+action = diskriminator).

## Lifecycle offer

`draft → (validate) → published → retired → (archived)`. Satu draft per plan
(partial unique index `...one_draft_idx`). Publish: validasi → freeze status +
`offer_hash` + `published_at` → INSERT snapshot ke projection (public price
saja). Retire: status + `retired_at` + projection `retired_at` (baris tetap
readable — "existing published versions remain readable").

## Verifikasi (JANGAN skip DB)

`bun run check` PENUH dengan PostgreSQL nyata (DB terisolasi, lihat memory
`scratch-db-verify-when-shared-db-poisoned` + `local-postgres-connection-details`).
Jangan lupa regen: `openapi:bundle`, `api:docs:generate`, `i18n:extract`,
`repo:inventory`. Doc 01/13/21 + `module-doc-reconciliation` + `module-skill-
coverage` di-gate saat menambah modul/migration.
