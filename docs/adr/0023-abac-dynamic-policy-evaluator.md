# ADR-0023 — Dynamic ABAC policy evaluator (DSL, precedence, cache)

- **Status:** Accepted
- **Tanggal:** 2026-07-19
- **Terkait:** ADR-0004 (RBAC + ABAC default-deny), ADR-0003 (PostgreSQL RLS), Issue #179, `src/modules/identity-access/domain/abac-policy.ts`, `abac-evaluator.ts`, `docs/awcms-mini/20_threat_model_security_architecture.md`

## Konteks

ADR-0004 menetapkan RBAC + ABAC default-deny, tetapi sampai Issue #179 `evaluateAccess()` belum pernah **mengonsumsi** baris `awcms_mini_abac_policies` yang tersimpan — otorisasi hanya bergantung pada permission peran dan guard bawaan (tenant isolation, self-approval, force-decision, business-scope, SoD). Untuk ERP, kebijakan perlu mengevaluasi atribut subject, resource, action, environment, kepemilikan, status transaksi, unit organisasi, dan batas nilai secara konsisten di satu chokepoint — tanpa membuka pintu bagi ekspresi arbitrer (`eval`, SQL bertemplat) yang berbahaya.

## Keputusan

### 1. DSL kondisi: AST jsonb yang terbatas, deterministik, versioned

Kondisi kebijakan disimpan sebagai AST jsonb (`conditions`) dengan `dsl_version` (mulai 1). Sebuah **node** adalah salah satu dari:

- `{ "allOf": [node, ...] }` — semua benar (kosong = vacuously true)
- `{ "anyOf": [node, ...] }` — salah satu benar (kosong = vacuously false)
- `{ "not": node }`
- **Leaf:** `{ "attr": "<ns.attr>", "op": "<op>", "value": <literal> }` **atau** `{ "attr": "<ns.attr>", "op": "<op>", "valueAttr": "<ns.attr>" }` (attr-ke-attr untuk cek kepemilikan, mis. `resource.ownerTenantUserId eq subject.tenantUserId`)

**Attribute allow-list** (di-resolve SERVER-SIDE — daftar tetap, di luar daftar = invalid/deny):

- `subject.*` (`tenantUserId`, `identityId`, `roles`, `defaultOfficeId`) — dari `TenantContext` terautentikasi, **tidak pernah** dari body request.
- `resource.*` (`tenantId`, `ownerTenantUserId`, `businessScopeId`, `status`, `resourceType`, `amount`) — dari `request.resourceAttributes` yang **wajib** diisi endpoint dari resource yang sudah diverifikasi/dipersist (kepemilikan dicek terhadap baris nyata, bukan klaim klien).
- `action` — action request.
- `env.*` (`now`, `dayOfWeek`, `ipTrusted`) — **hanya** server-derived; `ipTrusted` default `false` (fail-closed) sampai deployment memasang resolver jaringan tepercaya.

**Operator:** `eq`, `ne`, `in`, `nin`, `lt`, `lte`, `gt`, `gte`, `exists`. `lt/lte/gt/gte` hanya untuk atribut numeric/date. Tidak ada regex, fungsi, atau ekspresi arbitrer. Nilai hanya literal (string/number/boolean/ISO-date, atau array untuk `in/nin`). Evaluator adalah **interpreter murni** atas AST — tanpa `eval`, `new Function`, dynamic import, atau SQL bertemplat.

Parser/validator (`abac-policy.ts`) fail-closed: attribute tak dikenal, operator tak dikenal, tipe nilai salah, arity operand salah, versi DSL lebih baru dari yang didukung, atau cacat struktural apa pun → kebijakan **invalid** saat authoring (ditolak endpoint CRUD) sehingga tak pernah bisa diaktifkan.

### 2. Precedence: fail-closed, deny-overrides, allow-as-constraint, RBAC tetap wajib

Setelah semua guard bawaan (tenant isolation, self-approval, force-decision, business-scope) yang tetap berjalan lebih dulu dan tak dilemahkan, atas himpunan kebijakan **aktif** yang **applicability**-nya cocok (`module_key`/`activity_code`/`action`/`resource_type`, masing-masing nullable = wildcard):

1. **DENY eksplisit menang.** Bila ada kebijakan `deny` applicable yang kondisinya terpenuhi → **DENY** (mengalahkan RBAC allow dan kebijakan allow). Kebijakan aktif yang **invalid** (gagal compile / `dsl_version` terlalu baru) atau **error evaluasi apa pun** (attribute/operator tak dikenal) → **DENY** (fail-closed). Bagian ini dievaluasi **sebelum** cek RBAC.
2. **Permission RBAC tetap wajib.** Bila subject tak memiliki permission `module.activity.action` → **DENY** (`default_deny`). Kebijakan `allow` **tidak pernah** menciptakan permission yang tidak dimiliki subject.
3. **Kebijakan `allow` sebagai CONSTRAINT.** Bila ada kebijakan `allow` applicable, minimal satu kondisinya harus terpenuhi, jika tidak → **DENY** (`abac_allow_unsatisfied`). Bila tak ada kebijakan applicable sama sekali → ABAC no-op, RBAC yang memutuskan.

Model ini membuat kebijakan `allow` hanya bisa **mempersempit** akses yang sudah diberikan RBAC (mis. "hanya resource milik sendiri"), tak pernah memperluas — memenuhi acceptance "policy tidak dapat menciptakan permission yang tidak dimiliki subject". Atribut yang **sah-tapi-absen** pada suatu request (mis. request tanpa `resource.amount`) membuat leaf-nya `false` secara deterministik — itu **bukan** error dan bukan fail-closed-deny; fail-closed hanya untuk attribute/operator tak dikenal dan error evaluasi.

RLS (ADR-0003) tetap wajib sebagai pertahanan berlapis; ABAC tidak menggantikannya.

### 3. Cache per-tenant dengan invalidasi deterministik

Kebijakan aktif dikompilasi sekali per tenant dan disimpan di cache in-process yang **tenant-keyed** (`application/policy-cache.ts`). Setiap mutasi kebijakan (create/update/enable/disable) memanggil `invalidatePolicyCache(tenantId)` yang menaikkan versi per-tenant dan menghapus entry; endpoint memanggilnya **setelah** transaksi commit sehingga request berikutnya tak pernah men-cache snapshot pra-commit. Load selalu di dalam `withTenant` (RLS + peran `awcms_mini_app` non-superuser), sehingga tak pernah membaca lintas tenant. Tanpa restart. **Batasan:** invalidasi bersifat per-PROSES; deployment yang di-scale horizontal butuh sinyal lintas-instance tambahan (LISTEN/NOTIFY atau TTL pendek) — dicatat sebagai batasan, bukan diasumsikan hilang.

### 4. Decision log

Setiap keputusan mencatat `decision`, `reason`, `matched_policy` (kode), dan `matched_policy_version` ke `awcms_mini_abac_decision_logs` — tanpa PII/identifier sensitif mentah (hanya kode kebijakan, versi, dan reason statis). Endpoint simulasi read-only diaudit lewat `awcms_mini_audit_events` (bukan decision log) karena keputusannya hipotetis.

## Konsekuensi

- **Positif:** kebijakan beratribut (kepemilikan, batas nilai, status, environment) dinyatakan sebagai data tersimpan, auditable, dan berlaku di satu chokepoint tanpa deploy ulang; permukaan serang minimal (interpreter murni, allow-list tertutup, fail-closed).
- **Trade-off:** setiap request terguard membaca kebijakan aktif (di-cache); authoring menambah permukaan admin (`identity_access.abac_policies.*`).
- **Netral:** base tidak menyertakan kebijakan domain apa pun — lima contoh ERP hidup di `fixtures/abac-example-policies.json`, di-author aplikasi turunan lewat API.

## Alternatif yang dipertimbangkan

- **Ekspresi arbitrer / CEL / mini-language dengan fungsi** — ditolak: permukaan serang dan non-determinisme; AST terbatas cukup untuk kebutuhan ERP.
- **Allow-policy sebagai pemberi permission (ABAC-primary)** — ditolak: melanggar "permission peran tetap wajib"; dipilih model allow-as-constraint + deny-overrides.
- **Tanpa cache (baca tiap request)** — ditolak: biaya per-request; cache tenant-keyed dengan invalidasi deterministik memberi konsistensi tanpa restart.
