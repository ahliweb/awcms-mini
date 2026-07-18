# Changelog

## 0.25.0

### Minor Changes

- ca15e33: Close the account-enumeration oracles on `POST /api/v1/auth/login` (Issue #840).

  An unauthenticated caller could confirm that a given `loginIdentifier` exists
  without ever guessing its password, strengthening credential stuffing and
  targeted phishing (OWASP ASVS V2.2.1 / WSTG-IDNT-04). Two oracles existed, and
  the larger one was not the reported one.

  **Response body.** `locked` and `password_login_disabled` are reachable only
  once the identity has resolved (`login-policy.ts` guards both with
  `input.identity`), so their distinct responses disclosed existence. Both now
  answer with the same `401 AUTH_INVALID_CREDENTIALS` and the same
  `"Invalid login identifier or password."` message as an unknown identifier.
  For `locked` this is a message-only change — it already returned
  `401 AUTH_INVALID_CREDENTIALS`, and only the human-readable
  `"Account is temporarily locked."` gave it away — and it was the practical
  oracle: reachable in ~6 requests on a **default** deployment by tripping
  `AUTH_LOGIN_MAX_ATTEMPTS` and reading the message back.

  **Timing (the bigger one, and not in the issue).** `login.ts` skipped
  `verifyPassword` entirely for an unknown identifier
  (`identityRow ? await verifyPassword(...) : false`). Measured on the repo's own
  integration harness, an unknown identifier answered in a median of **4.13 ms**
  against **80.13 ms** for a known one — a ~19x gap that enumerates accounts in a
  **single request**, with no lockout to trip, on default configuration. Fixing
  only the bodies would have left it wide open. `verifyPasswordOrDummy`
  (`src/lib/auth/password.ts`) now always spends an equivalent argon2id verify,
  against a lazily-memoized dummy hash produced by `hashPassword` itself so its
  parameters always match real hashes. Measured after: **90.46 ms** vs
  **90.29 ms** (ratio 1.002). This equalizes the dominant cost, not every
  instruction, and is not claimed as a constant-time proof.

  **Behavior changes callers may notice.**

  - `403 PASSWORD_LOGIN_DISABLED` is no longer returned by this endpoint. A
    tenant with `password_login_enabled=false` (Issue #591) now denies
    non-break-glass identities with `401 AUTH_INVALID_CREDENTIALS`. Enforcement
    is unchanged (no session is issued) and break-glass identities still sign in
    normally. Beyond leaking existence, the old `403` fingerprinted exactly which
    identities are **break-glass** — the accounts that retain password access,
    i.e. the highest-value targets in that configuration.
  - A locked account no longer says so in the response.

  The real deny reason is unchanged server-side and still recorded on every
  attempt as `login_failed`'s `reason` attribute (`locked`,
  `password_login_disabled`, `invalid_credentials`), so operators lose nothing.
  `403 ACCESS_DENIED` for an inactive tenant stays distinct: it is decided from
  the tenant header before any identity is looked at and is returned identically
  for every identifier, so it cannot enumerate.

  **Accepted cost.** A genuinely locked user, and a user at an SSO-required
  tenant, now get a generic message with no hint about why. Those hints belong on
  channels that cannot be probed anonymously — a verified-email notification, and
  tenant-wide SSO discovery on the login page. Neither exists yet; the login page
  has no provider-discovery endpoint to surface "sign in with SSO" today, which
  is the natural follow-up.

### Patch Changes

- ca15e33: Tambah snapshot memory agent ke docs supaya konteks pengembangan bisa dimuat
  ulang di device berbeda. Memory Claude Code hidup di
  `~/.claude/projects/<slug-cwd>/memory/` — **di luar repo**, sehingga tidak ikut
  `git clone` dan hilang saat berpindah device.

  `scripts/sync-agent-memory.ts` menyinkronkan dua arah antara memory aktif dan
  `docs/awcms-mini/agent-memory.md`: `memory:docs:sync` (memory → docs, dijalankan
  tiap kali memory berubah), `memory:docs:restore` (docs → memory, untuk device
  atau checkout baru), dan `memory:docs:check` (gagal bila docs melenceng dari
  memory; **skip dengan exit 0** bila direktori memory tidak ada, sehingga CI dan
  checkout segar tidak dipaksa memilikinya). Slug diturunkan dari cwd dengan setiap
  karakter non-alfanumerik menjadi `-` — jadi device dengan path checkout berbeda
  tetap menulis ke direktori memory-nya sendiri yang benar.

  Karena repo ini publik, snapshot disanitasi: `originSessionId` dibuang, home
  directory diganti `~` (hanya `os.homedir()` sungguhan — pola `/home/<user>`
  generik akan merusak path proyek bersama yang bermakna seperti
  `/home/data/dev_bun/awpos`), dan placeholder berbentuk-password diredaksi agar
  tidak memicu secret scanner. Memory device-specific yang tidak berguna di device
  lain dikecualikan lewat daftar `EXCLUDE` yang wajib menyertakan alasan, dan
  alasan itu dirender ke dokumen supaya pengecualiannya tidak senyap.

  `docs/awcms-mini/agent-memory.md` masuk `.prettierignore`: Prettier memformat
  ulang header dokumen generated sehingga `memory:docs:check` selalu gagal setelah
  `lint`, dan memformat ulang isi memory berarti kehilangan fidelitas round-trip
  `restore`. Round-trip diverifikasi utuh untuk seluruh file memory.

  Aturan pemakaiannya ditegakkan sebagai AGENTS.md aturan #16, berpasangan dengan
  aturan #15 (dokumen audit `AUDIT_STANDAR_PENGEMBANGAN_<tanggal>.md` adalah
  dokumen hidup yang di-rename mengikuti tanggal perubahan, bukan file baru).

- ca15e33: Buat `ANALYZE` di suite query-plan benar-benar berjalan dan gagal keras kalau
  tidak (Issue #849, epic #818). PostgreSQL **diam-diam melewati** `ANALYZE` atas
  tabel yang tidak dimiliki peran pemanggil — hanya WARNING, bukan error, exit
  status sukses. Karena query-plan check menjalankan `ANALYZE` lewat peran
  least-privilege `awcms_mini_app` (yang tidak memiliki tabel), statistik planner
  tidak pernah disegarkan; budget lolos/gagal karena kebetulan timing autovacuum,
  bukan pengukuran nyata (`admin_list` sempat merah palsu karena `Sort`;
  `blog-posts-fulltext-search` sempat merah palsu ~874 di jalur script ber-bloat).

  Perbaikan: modul baru `src/lib/performance/analyze-fixtures.ts`
  (`analyzeQueryPlanFixtures`) menyegarkan statistik lewat koneksi **privileged**
  (pemilik tabel) lalu **membuktikan** itu berjalan dengan memeriksa
  `pg_stat_user_tables.analyze_count` benar-benar naik untuk setiap tabel — kalau
  tidak, ia melempar (test: `beforeAll` gagal; script: exit 1 dengan pesan yang
  bisa ditindaklanjuti). Integration harness memakai `getAdminSql()`; script
  `performance:query-plan:check` memakai `PERF_ANALYZE_DATABASE_URL` (URL
  owner/superuser), fallback ke `DATABASE_URL`. CI menyetel
  `PERF_ANALYZE_DATABASE_URL` ke peran migration-owner. EXPLAIN tetap berjalan
  RLS-enforced sebagai peran least-privilege — ANALYZE dipisah sebagai operasi
  maintenance milik owner.

  Tidak ada perubahan threshold budget: dengan statistik akurat semua budget lolos
  dengan margin sehat (fts 472–667/800, reporting 562–1132/1300, admin-list
  57–71/200). Klaim lama "fts latently red 939.5 vs 800" **tidak tereproduksi** —
  biaya statistik-akurat tak pernah melewati ~667. Proof `DROP INDEX` kini
  menegakkan biaya sekaligus bentuk plan (dropped ~316–472 vs budget 200), dan
  gate pure-unit baru memastikan setiap tabel penggerak budget ada di daftar
  ANALYZE.

- ca15e33: Batch tulisan telemetri pengunjung per tenant supaya beban pool tidak lagi naik
  linear terhadap traffic publik (Issue #846, epic #818).

  **Premis isu meleset, dan koreksinya yang menentukan bentuk perbaikan.** Isu
  meminta "batch INSERT `visit_event` per-event". Diukur — lewat TCP proxy yang
  menghitung round trip di kabel, ke Postgres nyata — satu kunjungan publik
  sebenarnya berharga **5,2 round trip**: BEGIN, SET LOCAL, SELECT session, INSERT
  event, COMMIT, plus 0,2 UPDATE session yang teramortisasi throttle 30 detik.
  INSERT yang disebut judul isu hanya **~19%** dari biaya itu, dan tidak mungkin
  di-batch sendirian: ia butuh `visitor_session_id` yang dihasilkan SELECT di
  transaksi yang sama. Biaya dominannya adalah **scaffolding transaksi per-event
  (~58%)**. Maka yang di-batch adalah **transaksinya**, bukan INSERT-nya: N event
  satu tenant kini berharga ~5-7 round trip total, bukan 5,2 **masing-masing**.

  Hasil (metode identik untuk baseline dan sesudahnya, angka setup diassert —
  jumlah row tertulis dan jumlah transaksi penulis diverifikasi, bukan diasumsikan):

  | skenario                            | sebelum | sesudah           |
  | ----------------------------------- | ------- | ----------------- |
  | round trip / event                  | 5,2     | **0,18** (~29x)   |
  | per event, latensi 2ms/hop disuntik | 28,89ms | **1,38ms** (~21x) |
  | per event, loopback                 | 1,43ms  | 0,28ms            |

  Selisih loopback vs 2ms/hop (1,43ms → 28,89ms pada baseline yang sama)
  menunjukkan kenapa angka ini tidak boleh diklaim dari loopback: **loopback
  menyembunyikan biaya round-trip**, yaitu persis biaya yang dihapus batching.

  **Trade yang dipilih sadar.** Record hidup di memori sampai batch-nya flush,
  jadi crash KERAS (SIGKILL/OOM/panic) bisa kehilangan ≤ `BATCH_LINGER_MS` (200ms)
  traffic per tenant atau `MAX_BATCH_SIZE` (50) event — jendela yang memang lebih
  lebar dari sebelumnya. SIGTERM/SIGINT normal **tidak kehilangan apa pun**:
  flush menulis batch **PARSIAL**, tidak pernah menunggu batch penuh atau linger
  timer. Trade ini diterima khusus untuk visitor analytics — data agregat yang
  sudah lossy by design (queue bounded drop, flush timeout, collector fail-open) —
  dan **tidak berlaku untuk tulisan ledger/audit/transaksi posted**. Bounded
  (`MAX_PENDING_EVENTS`) dan drop-nya nyaring lewat counter baru
  `visitor_analytics_batch_dropped_total` + gauge `visitor_analytics_batch_pending`
  (terpisah dari counter tahap 1 supaya operator tahu tahap MANA yang jenuh).

  Jaminan #832 utuh: `enqueueVisitorTelemetry` tetap mengembalikan `void`,
  antrean tetap bounded/fail-open, dan hook shutdown tetap hanya dipasang dari
  `src/middleware.ts` — bukan dari panggilan data-plane.

  `occurred_at` kini di-capture di jalur respons dan di-INSERT eksplisit. Tanpa
  ini, penundaan batch akan menggeser timestamp setiap event ke waktu flush-nya
  dan merusak analytics secara diam-diam.

  **Dua trap terverifikasi empiris.** Bentuk bulk yang paling alami —
  `unnest(..., tx.array(rows.map(r => JSON.stringify(r.geo)), "jsonb"))` —
  memunculkan kembali bug Issue #623: byte-nya identik, tapi setiap SELECT
  mengembalikan `string`, bukan objek. Karena itu insert batch memakai row helper
  `tx(rows)` dengan objek polos. Mutation test juga menemukan dua celah di test
  buatan sendiri: bulk UPDATE session (unnest 13 array) semula tidak dijalankan
  test mana pun — dan karena berada di dalam `catch` fail-open, syntax error di
  situ akan ditelan diam-diam selamanya; keduanya kini tertutup.

- ca15e33: Kunci index blog admin list dari Issue #830 dengan query-plan budget (Issue
  #838, epic #818). #830 menambahkan `(tenant_id, updated_at DESC)` untuk
  `awcms_mini_blog_posts`/`awcms_mini_blog_pages` dengan bukti EXPLAIN kuat, tapi
  tidak ada budget yang mencegahnya regresi — index bisa terhapus dan CI tetap
  hijau.

  **Sinyal budget-nya `Sort`, bukan `Seq Scan` — ini terukur, bukan asumsi.**
  Menyalin bentuk lima budget sebelumnya (`forbiddenNodeTypes: ["Seq Scan"]`)
  akan menghasilkan **gate vakum**. Dengan index di-`DROP` sungguhan pada skala
  fixture `safe`, planner **tidak** jatuh ke Seq Scan: RLS selalu menyuntikkan
  `tenant_id = current_setting(...)` dan tabelnya masih punya
  `..._tenant_deleted_idx`, jadi planner memakai index itu lalu menambah `Sort`:

  | Blog admin post list | Plan                                                     | Cost   |
  | -------------------- | -------------------------------------------------------- | ------ |
  | index ada            | `Limit -> Index Scan`                                    | 62,06  |
  | index di-`DROP`      | `Limit -> Sort -> Bitmap Heap Scan -> Bitmap Index Scan` | 939,88 |

  Budget "Seq Scan saja" LULUS pada plan kedua. Karena itu kategori baru
  `admin_list` melarang `Sort`/`Incremental Sort` (invarian sesungguhnya:
  `ORDER BY` dilayani urutan index, jadi plan tidak menyortir apa pun),
  dengan `maxTotalCost` sebagai lapis pertahanan kedua yang independen.

  Perubahan:

  - Dua budget baru — `blog-posts-admin-list` dan `blog-pages-admin-list` —
    di `query-plan-budgets.ts`, SQL pasangannya (bentuk asli
    `listBlogPostsForAdmin`/`listBlogPagesForAdmin`, termasuk filter opsional
    yang di-bind NULL seperti tampilan default) di `query-plan-runner.ts`.
  - `awcms_mini_blog_pages` kini di-seed (`scale-profiles.ts` field `blogPages`,
    `generateBlogPages`, `insertBlogPages`, plus DELETE di
    `resetPerformanceFixtureRows`). Tanpa ini budget page mustahil: **budget di
    atas tabel kosong = gate vakum**, Postgres Seq Scan tabel 0 baris apa pun
    index-nya.
  - `updated_at` kini benar-benar dihasilkan generator untuk post dan page.
    Sebelumnya tidak pernah di-insert sehingga jatuh ke `DEFAULT now()` — satu
    nilai per transaksi seeding (terukur: 5 nilai distinct untuk 3000 baris).
    Budget `ORDER BY updated_at DESC` di atas kolom konstan bukan proxy yang
    bermakna; kini tersebar realistis (selalu >= `created_at`).
  - Proof adversarial: unit test menjalankan budget terhadap plan terukur di
    atas **termasuk assertion bahwa varian naif TIDAK menangkap regresinya**,
    dan integration test benar-benar `DROP INDEX` (dikembalikan di `finally`,
    drop diassert ke `pg_indexes` lebih dulu) lalu memastikan gate MERAH —
    persis DoD Issue #838.

  Terdokumentasi juga di `performance-suite.md`: statistik planner di suite ini
  sering basi karena peran `awcms_mini_app` bukan owner tabel, sehingga `ANALYZE`
  **di-skip diam-diam dengan WARNING, bukan error** — assertion bentuk plan
  bertahan pada regime statistik buruk, assertion cost tidak. Itulah alasan
  budget `admin_list` memimpin dengan bentuk plan.

  Konsekuensi lanjutan yang juga terukur: `CREATE INDEX` memperbarui
  `pg_class.reltuples`/`relpages` sebagai efek samping (`-1/0` → `2000/334`),
  sehingga planner tahu jumlah baris sebenarnya tapi **tetap nol statistik
  kolom** — satu-satunya kondisi di mana index budget ini justru kalah tipis:

  | kondisi `pg_class`                | plan                                    | cost  |
  | --------------------------------- | --------------------------------------- | ----- |
  | `reltuples=-1` (belum di-analyze) | `Index Scan(..._tenant_updated_idx)`    | 8,3   |
  | `reltuples` nyata, nol stat kolom | `Sort` + `Scan(..._tenant_deleted_idx)` | 8,19  |
  | ter-`ANALYZE` penuh (DB nyata)    | `Index Scan(..._tenant_updated_idx)`    | 57,17 |

  Dua plan itu **seri dalam ~1%**, jadi planner ambil yang sedikit lebih murah —
  lemparan koin, bukan penilaian. Baris tengah tidak pernah terjadi di deployment
  nyata (autovacuum menghasilkan baris ketiga). Karena itu proof `DROP INDEX`
  meng-assert pemulihan index lewat `pg_indexes.indexdef` (round-trip terhadap
  definisi yang ditangkap sebelum drop), **bukan** dengan menjalankan `EXPLAIN`
  ulang: memulihkan index itu fakta schema, jadi di-assert sebagai fakta schema.
  Assertion inti (before hijau, regressed merah) tidak berubah dan tetap
  terbukti merah lewat mutation test.

- ca15e33: fix(blog-content): clamp `?page=` at both ends on public blog/news routes (Issue #819)

  `boundedPage` clamped only the lower bound and did not guard `NaN`, on routes
  that are public and unauthenticated. `?page=1e8` reached `OFFSET 1e9` (a
  deep-offset scan holding a pool connection for one credential-less GET) and
  `?page=abc` reached `OFFSET NaN` → 500.

  Page-number bounds now live in a shared helper
  (`src/modules/_shared/offset-pagination.ts`): `boundedPageNumber` clamps to
  `[1, 10_000]`, truncates fractions, and returns page 1 for `NaN`/`±Infinity`;
  `parsePageParam` is used by the six public `/blog/{tenantCode}` and `/news`
  routes so the clamped value is also what renders into pagination nav links.
  The admin blog post/page lists use the same helper (they shared the
  copy-pasted pattern).

  Behaviour change: a non-numeric or out-of-range `?page=` now renders page 1
  (or an empty page 10,000) instead of a 500.

- ca15e33: Fix `scripts/changeset-policy-check.ts` crashing with `ENOENT` on any
  release-consumption PR (Issue #810). `git diff --name-only` doesn't
  distinguish added vs. deleted paths, so the changed-`.changeset/*.md`-file
  detection included paths deleted by the PR (e.g. consumed changesets removed
  by `bun run changeset:version`), then tried to read their content for
  frontmatter validation and crashed.

  The first fix attempt (skip frontmatter validation for deleted paths) had a
  security side effect a review pass caught before merge: it made the
  pre-existing "any touched `.changeset/*.md` path counts as satisfied" logic
  silently PASS a PR that _deletes_ an existing pending changeset instead of
  adding a new one, converting an accidental crash (fail-closed) into a
  silent bypass (fail-open) of the "changeset required" gate. Replaced with a
  narrow, content-verified release-consumption carve-out: the requirement is
  waived only when a `.changeset/*.md` file was genuinely deleted, the ONLY
  non-exempt file touched is `package.json`, and that file's diff changes
  nothing but its `version` field (verified via `git show` on both sides,
  failing closed on any ambiguity). Added a CLI-level regression suite that
  spawns the real script against disposable git repos to exercise this
  wiring directly, including a reproduction of the exploit confirmed blocked.

- ca15e33: Tutup celah "CI diam-diam menjalankan subset `bun run check`" untuk keempat
  kalinya (Issue #823, epic #818). Lima langkah ada di komposit `check` tetapi tak
  pernah dicerminkan ke `.github/workflows/ci.yml`: `api:docs:check`,
  `repo:inventory:check`, `i18n:pot:check`, `config:docs:check`, dan
  `logging:lint:check`. Kelimanya lolos saat dipasang, jadi ini risiko laten
  (regresi inventory/API-docs/i18n/config-docs/logging bisa merge hijau), bukan
  drift aktif.

  Menambal lima langkah itu saja tidak cukup — daftar di `ci.yml` adalah cermin
  manual dari `check`, dan cermin itu sudah melenceng empat kali
  (#685/#740/#745/#746/#750) meski `ci.yml` memuat komentar peringatan panjang di
  tiap langkah. Karena itu ditambahkan gate sesungguhnya:
  `tests/unit/ci-check-parity.test.ts` mengurai komposit `check` dari
  `package.json` lalu memastikan setiap langkahnya benar-benar dijalankan
  `ci.yml`, sehingga menambah langkah `check` tanpa memasangnya di CI langsung
  merah. Pemeriksaannya sengaja satu arah (`check` ⊆ `ci.yml`) karena CI memang
  menjalankan lebih banyak (`db:migrate`, performance suite, DR drill); langkah
  yang CI jalankan dengan bentuk perintah berbeda (`bun test`, `build`)
  didaftarkan eksplisit di `RUN_DIFFERENTLY`, dan entri usang di daftar itu ikut
  gagal supaya pengecualian tidak bertahan diam-diam setelah alasannya hilang.

  Gate-nya diverifikasi benar-benar menangkap drift: menyisipkan langkah palsu ke
  `check` membuat test merah dengan pesan yang menyebut langkah itu, dan hijau
  kembali setelah dipulihkan.

  Branch protection `main` (bagian kedua Issue #823) tetap butuh aksi owner dan
  tidak termasuk perubahan ini.

- ca15e33: fix(data-exchange): tutup empat cacat raw-value guard pada preview import (#820) dan klamp `offset` (#831)

  `GET /api/v1/data-exchange/imports/{id}/preview` mengembalikan nilai staged mentah hanya bila descriptor pemiliknya menyatakannya, dan hanya kepada pemegang izin yang **descriptor itu sendiri** sebutkan. Empat cacat yang saling menguat (laten — belum ada modul yang mendaftarkan descriptor sensitif; ini perangkap untuk turunan pertama):

  - **Default-allow dibalik jadi default-deny**: `sensitiveFields` kini **wajib** (registry gate menolak descriptor tanpanya — nyatakan `{ fieldNames: [] }` bila memang tak ada yang sensitif). Descriptor tanpa policy kini di-mask seluruhnya dan tak ada izin yang membukanya; sebelumnya lalai mendeklarasikan justru **membuka** semua nilai tanpa cek izin sama sekali.
  - **`sensitiveFields.rawValuePermission` kini benar-benar ditegakkan**: sebelumnya divalidasi saat registrasi tapi nol enforcement site — route memakai konstanta hardcoded `data_exchange.preview_errors.read` yang jauh lebih luas, sehingga deklarasi izin sempit descriptor (mis. `profile_identity.identifiers.reveal_raw`) diabaikan diam-diam.
  - **Descriptor tak terselesaikan kini fail-closed**: `authorizeExchangeDescriptorPermission` tidak lagi menerima `null` (fail-open yang bertentangan dengan komentarnya sendiri). Batch yang modul pemiliknya di-disable setelah staging kini ditolak `409 INVALID_STATE` pada preview/commit/retry/download — sebelumnya batch justru menjadi **lebih terbuka** setelah modulnya dimatikan.
  - **`naturalKey` ikut di-mask** bila `sensitiveFields.naturalKeyField` menyebut field yang sensitif — kunci dedup import profil lazimnya justru email/NIK.

  Perubahan perilaku untuk aplikasi turunan: `ExchangeDescriptor.sensitiveFields` wajib; `ExchangeSensitiveFieldPolicy` menerima `naturalKeyField` opsional; `authorizeExchangeDescriptorPermission` menerima `ExchangeDescriptor` non-nullable.

  `offset` preview kini diklamp atas ke `PREVIEW_OFFSET_MAX` (= `MAX_EXCHANGE_ROW_COUNT`, sehingga tak menyembunyikan baris yang bisa dijangkau) — sebelumnya hanya dicek `>= 0` sementara `limit` tepat di baris berikutnya sudah diklamp, jadi `?offset=5000000` diteruskan apa adanya ke Postgres.

- ca15e33: Hilangkan baseline 16 undeclared module-dependency edge yang dibekukan #826; gate `module-declared-dependencies` kini memvalidasi graph import lintas-modul yang LENGKAP (Issue #845, epic #818).

  #826 merilis gate dengan baseline 16 edge tak-terdeklarasi di 10 modul (mendeklarasikan semuanya sekaligus di luar scope #826). #845 menuntaskannya ke nol:

  - 15 edge adalah import layering-valid nyata dan kini dideklarasikan di `dependencies` masing-masing `module.ts` (blog-content, document-infrastructure, form-drafts, identity-access, module-management, news-portal, organization-structure, profile-identity, reference-data, social-publishing — mayoritas `-> logging`).
  - Edge ke-16, `profile_identity -> domain_event_runtime`, adalah cycle nyata (`domain_event_runtime -> identity_access -> profile_identity`). Diputus dengan menyuntikkan producer outbox sebagai `DomainEventAppendPort` (`_shared/ports/domain-event-append-port.ts`, hanya TYPE, tanpa import implementasi) di composition root (route `POST /api/v1/profile-merge-requests/{id}/execute`) alih-alih meng-import langsung — pola inversi ADR-0011 yang sama dengan pasangan port blog_content/news_portal.

  Dengan baseline hilang, setiap import lintas-modul baru yang tak dideklarasikan gagal seketika — persis yang akan menangkap #826 saat authoring. Tanpa perubahan skema/runtime perilaku; murni deklarasi graph + inversi dependensi.

- ca15e33: Turunkan (derive) domain-event **publish root** dari registry, bukan menamainya
  tangan (Issue #848, epic #818). Perubahan hanya di gate test dan dokumentasi —
  tak ada perubahan perilaku runtime.

  **Masalah.** #826 membalik registrasi consumer (modul mendaftarkan consumer-nya
  sendiri; runtime tak mengimpor kode consumer) — memutus cycle tapi menukar
  jaminan compile-time dengan runtime yang gagalnya **senyap**. `appendDomainEvent`
  membuat delivery row **dari registry saat publish**, jadi publisher yang belum
  mengimpor registrasi consumer yang men-subscribe event-nya menghasilkan **NOL
  row** untuk event yang benar-benar terjadi — permanen, tanpa error/dead-letter.
  PR #847 menambal ini dengan daftar `PUBLISH_ROOTS` **manual**: asumsi tak teruji
  bahwa consumer lintas-modul BARU yang event-nya di-publish modul lain akan lolos
  diam-diam sampai ada yang ingat menambah entri.

  **Perbaikan.** `tests/unit/domain-event-consumer-registration-wiring.test.ts` kini
  **menurunkan** publish root dari kode: untuk tiap consumer terdaftar yang bukan
  milik runtime (`BASE_DOMAIN_EVENT_CONSUMERS`), ambil `eventTypes`-nya, resolusi
  tiap pemanggil `appendDomainEvent` yang mem-publish-nya (**resolusi identifier ES
  import nyata**, mengikuti operand ternary — bukan grep literal), dan wajibkan tiap
  publisher **se-modul** mengimpor registrasi consumer itu. `PUBLISH_ROOTS` manual
  dihapus.

  **Tanpa edge lintas-modul baru.** Bila publisher berada di modul LAIN dari
  registrasi consumer, gate **menandainya sebagai sinyal arsitektural** (registrasi
  harus pindah ke composition root proses, ditambahkan ke `COMPOSITION_ROOTS`),
  bukan memaksa import lintas-batas yang akan membuat ulang cycle yang #826 hapus.
  Nol kasus lintas-modul hari ini; masing-masing yang muncul kelak akan MERAH.

  **Gate dibuktikan bisa MERAH.** Cocok terhadap **statement `import`** (resolve +
  bandingkan path), bukan `source.includes(specifier)` — melepas import registrasi
  dari `integration-hub/application/inbound-webhook-intake.ts` membuat gate gagal
  **meski komentar tepat di atasnya menyebut path yang sama** (cacat "prosa
  memuaskan gate" yang sama seperti yang #847 perbaiki).

  **Guard derivasi.** Gate juga gagal bila (a) ada consumer non-base yang tak
  ter-map ke file registrasi (mis. registrasi tanpa export definisi), atau (b) ada
  operand `eventType` yang tak bisa diresolusi (blind spot) — keduanya membuat
  derivasi buta terhadap publish site, jadi difail-kan lantang.

  **Premis issue terkonfirmasi.** Dua consumer non-base:
  `integration_hub.outbound_subscription_fanout` (event
  `integration-hub.inbound-message.normalized`, di-publish hanya oleh
  `inbound-webhook-intake.ts` di modul yang **sama** → satu-satunya publish root,
  tanpa edge baru) dan `reporting.event_activity_projector` (event
  `sample.recorded`, **tak di-publish kode produksi mana pun** → nol publish root).
  Derivasi memroses kedua operand ternary di `workflow-approval` tanpa blind spot.

- ca15e33: Backfill dedicated high-risk integration coverage untuk Issue #827 (epic #818):
  workflow-approval decision endpoint dan integration-hub outbound SSRF guard.
  Perubahan tests-only (plus regenerasi `docs/awcms-mini/repo-inventory.md`), tidak
  mengubah perilaku runtime.

  - `tests/integration/workflow-approval-decision-hardening.integration.test.ts`:
    idempotent replay (respons tersimpan verbatim, tak re-decide, tak dobel-audit),
    isolasi idempotency lintas-resource (bug berulang #750/#795 — hash memuat
    taskId), dan probe konkurensi `test.failing` yang mendokumentasikan quorum-'all'
    bypass NYATA (dilaporkan sebagai #851).
  - `tests/integration/integration-hub-ssrf.integration.test.ts`: penolakan SSRF di
    write-time (subscription create ke alamat privat/link-local ditolak 400, tak
    disimpan) dan pertahanan berlapis di dispatch-time (target privat yang lolos
    write-time diblokir sebelum ada HTTP keluar; delivery dead-letter non-retryable).

  Tiap assertion penting diverifikasi MERAH via mutation ke kode produksi lalu
  dikembalikan. data-exchange tidak disentuh: file 40-blok yang ada sudah menutup
  ketiga butir DoD #827 (masking preview #820, formula injection, error impor
  parsial), diverifikasi hijau terhadap Postgres nyata.

- ca15e33: Gate integration test suites on `DATABASE_URL` dan cegah regresi bare
  `describe(...)`.

  `tests/integration/reference-data.integration.test.ts` punya satu blok
  top-level yang memakai bare `describe(...)` alih-alih helper gate
  `suite = integrationEnabled ? describe : describe.skip`, sehingga sepuluh
  test DB-touching berjalan tanpa syarat dan menggagalkan
  `bun run check`/`bun test` saat `DATABASE_URL` kosong. CI tidak
  menangkapnya karena job Quality selalu menyetel `DATABASE_URL`.

  Blok tersebut diperbaiki ke `suite(...)`, dan gate unit murni baru
  `tests/unit/integration-suite-gating.test.ts` (jalan justru tanpa DB)
  memindai semua `tests/integration/*.integration.test.ts` memakai
  allow-list default-deny: setiap `describe...` top-level (kolom-0) gagal
  dengan pesan actionable KECUALI dua bentuk terdokumentasi —
  `describe.skip(` dan `describe.skipIf(!integrationEnabled)(` (kondisi
  persis ini). Jadi `describe(`, `describe.only(`, `describe.each(`,
  `describe.todo(`, serta `describe.skipIf(...)` berkondisi lain (terbalik
  atau `process.env.CI`) semuanya tertangkap.

- ca15e33: Tambahkan gate validasi response-vs-schema OpenAPI (Issue #844, epic #818).

  Sebelumnya tidak ada apa pun di repo yang membandingkan body response nyata
  (atau data pembentuk response) terhadap kontrak OpenAPI yang dipublikasikan —
  `api:spec:check`/`api:docs:check` hanya menjaga konsistensi antar artefak
  (bundle segar relatif sumber), bukan kesetiaan kontrak terhadap kode. Akibatnya
  endpoint yang body-nya diturunkan dari struktur TypeScript hand-maintained bisa
  melanggar kontraknya sendiri secara senyap — persis yang terjadi pada
  `sensitiveFields.naturalKeyField` (Issue #820, tertangkap manual di review PR
  \#839).

  **Mekanisme.** `scripts/lib/openapi-response-validator.ts`: validator subset
  JSON-Schema tanpa dependency baru (Bun-only, AGENTS.md rule 14; `ajv` ditolak
  karena memaksa permukaan Node dan membaca `allOf`+`additionalProperties: false`
  secara ketat per-branch, padahal envelope `ApiSuccess` di kontrak ini memakai
  pembacaan MERGE). Mendukung `$ref`, `allOf` (merge), `oneOf`/`anyOf`, `type`,
  `enum`, `const`, `required`, `additionalProperties: false`, `properties`,
  `items`, `nullable`. Memvalidasi objek nyata terhadap schema ter-parse — bukan
  grep teks sumber.

  **Gate.** `tests/unit/response-contract-validation.test.ts` memvalidasi response
  nyata `GET /api/v1/data-exchange/descriptors` (envelope + descriptor registry
  verbatim) terhadap bundle terpublikasi `awcms-mini-public-api.openapi.yaml`.
  Harness data-driven — menambah endpoint = satu entri. Melebur test parity sempit
  `data-exchange-descriptor-contract-parity.test.ts` (assertion naturalKeyField &
  load-bearing dipertahankan).

  Drift `data_exchange` yang jadi bukti issue **sudah** diperbaiki PR #839; gate
  ini membuktikannya tetap benar dan menutup kelas cacat "gate hijau di atas
  drift response nyata" secara umum untuk endpoint registry/descriptor.

- ca15e33: Samakan pengecekan trust media URL LinkedIn (`isTrustedR2MediaUrl`) dengan pola
  Meta (`isAcceptableProviderMediaUrl`) — defense-in-depth hardening (Issue #862,
  epic #818). Sebelumnya adapter LinkedIn memakai prefix check string
  `url.startsWith(publicBaseUrl)` yang bisa di-bypass (trailing-dot FQDN,
  `@`-userinfo `media.example.com@evil.com`, dan prefix-collision
  `media.example.com.evil.com`) dan tidak menolak downgrade `http:`.

  Kedua jalur provider kini memakai SATU helper bersama
  `isMediaUrlFromTrustedBase` (`src/modules/social-publishing/domain/provider-media-trust.ts`)
  yang parse `new URL()`, mewajibkan `protocol === "https:"`, lalu membandingkan
  `URL.host` secara persis — kelas pengecekan lemah yang pelajaran trailing-dot
  FQDN Issue #635 sudah hindari untuk Meta. Helper murni tanpa I/O, di-`domain/`
  sehingga bisa di-import oleh jalur Meta (`domain/`) dan adapter LinkedIn
  (`infrastructure/`) tanpa memicu import cycle.

  Ini murni hardening last-mile: `content.imageUrl` sudah selalu dibangun
  server-side dari objek media R2 terverifikasi, jadi tidak ada jalur input yang
  saat ini terjangkau — tidak mengubah perilaku publish yang sah.

- ca15e33: Perbaiki regresi yang diperkenalkan Issue #821: audit `login_failed` /
  `mfa_challenge_failed` ditulis dengan `tenant_id` dari header **sebelum**
  memastikan tenant itu ada. `awcms_mini_audit_events.tenant_id` adalah
  `NOT NULL REFERENCES awcms_mini_tenants (id)`, sehingga header tenant yang
  berbentuk UUID valid tetapi tidak terdaftar membuat INSERT audit melanggar
  foreign key, membatalkan transaksi, dan mengubah 403/401 yang dimaksud menjadi
  **500** — dapat dipicu siapa pun tanpa autentikasi, jadi cara murah untuk
  memaksa 500 beruntun.

  Sekarang audit tenant-scoped hanya ditulis bila tenant-nya benar-benar ada;
  selain itu percobaannya tetap terlihat lewat structured log (yang memang tidak
  tenant-scoped). Secara definisi tidak ada jejak tenant-scoped yang bisa ditulis
  untuk tenant yang tidak ada. Recorder out-of-band memeriksa ulang keberadaan
  tenant sendiri, karena ia berjalan setelah transaksi login gagal dan tidak
  boleh memercayai apa pun yang dihitung transaksi itu.

  Ditemukan oleh review bot pada PR #839 — reviewer maupun security-auditor
  melewatkannya. Test regresinya diverifikasi menangkap cacat aslinya (merah saat
  guard dicabut, hijau setelah dipulihkan).

- ca15e33: perf(middleware): analytics tidak lagi memblokir response + cache host→tenant (Issue #832)

  **Akar masalah.** `src/middleware.ts` meng-`await collectRequestAnalytics(...)`
  sebelum mengembalikan response, pada **setiap** request publik. Di dalamnya:
  resolusi host→tenant (1-2 query, tanpa cache padahal mapping domain→tenant
  berubah dalam hitungan hari) lalu satu transaksi `withTenant` (SELECT session,
  UPDATE/INSERT session, INSERT visit_event). Totalnya 4-6 round trip DB masuk
  langsung ke TTFB tiap halaman publik — jalur yang justru paling sensitif TTFB
  di repo dengan tenant domain routing. Docblock fungsi itu sendiri mengklaim
  "never delays the response beyond its own `await`"; `await` itulah masalahnya.

  **Perubahan.**

  - Resolusi host→tenant kini di-cache in-process dengan TTL
    `PUBLIC_TENANT_CACHE_TTL_MS` (default 60s, `0` = nonaktif), termasuk hasil
    negatif, dengan single-flight (N request dingin untuk host yang sama =
    1 query, bukan N) dan batas `MAX_ENTRIES` agar flood `Host` header tidak
    bisa menumbuhkan memori tanpa batas. Kunci cache adalah hostname
    ter-normalisasi **utuh** — bukan suffix/label — dan hanya memoize fungsi
    yang murni bergantung pada host, sehingga tidak ada jalan bagi tenant A
    melihat tenant B.
  - Analytics tidak lagi memblokir response: bagian yang menyentuh `context`
    (cookie visitor, config, IP/geo/UA dari header) tetap sinkron dan inline
    (tanpa DB), sedangkan lookup tenant + write dipindah ke antrean in-memory
    terbatas. **Bukan** `void collectRequestAnalytics(...)` seperti saran
    minimal issue: itu akan membuat `context.cookies.set(...)` hilang (Astro
    sudah men-serialize cookie begitu middleware return), sehingga tiap request
    mencetak visitor key baru dan memecah semua session.
  - Tidak ada kehilangan event pada shutdown normal: antrean di-flush pada
    SIGTERM/SIGINT/`beforeExit` (adapter `@astrojs/node` standalone tidak
    memasang handler sinyal apa pun, jadi tanpa ini event pending hilang).
    Handler itu dipasang **hanya dari `src/middleware.ts`** (satu-satunya jalur
    yang membuktikan proses ini benar-benar HTTP server), tidak pernah otomatis
    dari `enqueueVisitorTelemetry`: memasang signal handler adalah keputusan
    lifecycle proses milik application entry, bukan efek samping panggilan
    data-plane. Versi pertama memasangnya lazily saat enqueue, sehingga setiap
    proses yang pernah mengantre satu event telemetri — termasuk `bun test` —
    ikut mewarisi handler SIGTERM; `tests/unit/job-runner.test.ts` yang sah
    memanggil `process.emit("SIGTERM")` untuk menguji cancellation-nya lalu
    memicu handler itu, yang me-`process.kill` seluruh test runner (~1 detik,
    nol hasil test, terlihat seperti suite menggantung).
  - Invalidasi cache dipasang di endpoint tenant-domain (create/update/verify/
    delete) **setelah** transaksi commit, bukan di dalamnya.

  **Angka TTFB (diukur, bukan asumsi).** Server hasil `bun run build`, Postgres
  nyata, mapping host→tenant aktif, 200 sample `/news` setelah warmup:

  | Skenario                       | p50 sebelum | p50 sesudah | mean sebelum | mean sesudah |
  | ------------------------------ | ----------- | ----------- | ------------ | ------------ |
  | DB loopback (best case DB)     | 3.94 ms     | 2.65 ms     | 4.11 ms      | 3.07 ms      |
  | Write analytics lambat (+50ms) | 55.65 ms    | 2.10 ms     | 55.70 ms     | 2.44 ms      |

  Baris pertama (−33% p50) memang kecil dalam angka absolut karena Postgres ada
  di loopback (RTT sub-milidetik) — itu **best case** yang tidak mewakili
  deployment nyata. Baris kedua mengisolasi hal yang sebenarnya diperbaiki:
  dengan latensi 50ms disuntikkan ke write analytics, TTFB lama ikut naik penuh
  ke 55.65 ms sementara TTFB baru tidak bergerak sama sekali (2.10 ms). Artinya
  biaya analytics kini **nol** di jalur kritis, bukan sekadar lebih kecil — dan
  penghematan sesungguhnya di produksi berskala dengan RTT/kontensi DB, bukan
  dengan angka loopback di baris pertama.

  Bukti tidak ada telemetri yang hilang (kondisi identik, write 50ms, SIGTERM
  saat antrean masih terisi): tanpa flush hook 22/40 event tersimpan; dengan
  flush hook 40/40.

- ca15e33: docs(epic-818): rekonsiliasi doc 01/02/13/21 dengan 23 modul nyata + gate anti-drift (Issue #828)

  Dokumen perencanaan tertinggal jauh dari registry. Doc 01 §"Modul utama
  (base)" memuat 11 baris untuk registry 23 modul dan menegaskan _"modul
  domain ... bukan bagian base ini"_ padahal `src/modules/index.ts`
  mendaftarkan `blog_content`/`news_portal`/`social_publishing` sebagai base;
  doc 13 memuat tabel traceability yang menunjuk tabel/endpoint/ID issue yang
  tak pernah ada; doc 21 §8 berjudul "Peta 23 modul" tapi memuat 22 baris.

  Yang diperbaiki:

  - **Doc 01**: tabel modul ditulis ulang ke 23 modul nyata (kolom `key` +
    kategori doc 21), klaim "modul domain bukan bagian base" **dicabut**, dan
    4 kapabilitas base non-modul (Localization UI, UI Experience, Database
    Connectivity, Production Security) dinyatakan eksplisit — mereka hidup di
    `src/lib/`+`i18n/`+`scripts/`, tak terlihat oleh `modules:dag:check`.
  - **Doc 13**: dua tabel traceability utama ditulis ulang terhadap tabel/
    endpoint/issue yang **diverifikasi ke sumbernya**; matrix migration
    diperluas `055` → `077` (+7 modul yang hilang); versi hardcoded dihapus
    (sumber kebenaran `package.json`/`CHANGELOG.md`).
  - **Doc 13**: keputusan eksplisit — production security readiness
    **script-only & ephemeral**; janji `awcms_mini_security_*` +
    `/security/go-live-gates/evaluate` (nol hit di `sql/`+`src/`) dicabut,
    bukan diimplementasikan.
  - **Doc 02**: ditambah PRD Management Reporting (modul base nyata,
    `key: reporting`) dan Localization UI (ditandai kapabilitas non-modul).
  - **Doc 21 §8** + **AUDIT_STANDAR_PENGEMBANGAN_2026-07-17.md**: baris
    `idn_admin_regions` yang hilang ditambahkan; klaim audit "24 modul (22
    `active`, 2 `experimental`)" dikoreksi ke **23 modul (22 `active`, 1
    `experimental`)** — 24 adalah jumlah **direktori** `src/modules/*/` yang
    ikut menghitung `_shared` (bukan modul terdaftar).

  Perubahan berperilaku: **gate CI baru**
  `tests/unit/module-doc-reconciliation.test.ts` mem-parse baris tabel doc
  01/13/21 dan menegakkannya terhadap `listBaseModules()` + isi `sql/` —
  dua arah (baris hilang **dan** modul/migration fiktif), termasuk setiap
  migration wajib terpetakan tepat satu kali. Sengaja mem-parse **baris
  tabel**, bukan `source.includes(key)`, sehingga prosa yang menyebut sebuah
  modul tidak bisa memuaskan gate. Ini drift ke-6 kelas yang sama;
  perbaikan doc tanpa pagar akan kambuh ke-7.

- ca15e33: docs(skills): skill untuk 5 modul aktif yang belum punya + gate anti-drift modul↔skill (Issue #829)

  Menulis skill proyek untuk lima modul aktif yang sebelumnya **tidak punya
  panduan konvensi tertulis sama sekali**, padahal 18 modul lain punya:
  `awcms-mini-data-exchange`, `awcms-mini-reference-data`,
  `awcms-mini-domain-event-runtime`, `awcms-mini-organization-structure`, dan
  `awcms-mini-reporting`. Kelimanya disambungkan ke dua katalog discoverability
  (`AGENTS.md` + `.claude/skills/README.md`), dan jumlah skill di doc 13
  dikoreksi (39 → 50; sudah salah sejak beberapa epic lalu).

  **Akar drift-nya, dan kenapa menambal 5 skill saja tidak cukup.** Ini
  kemunculan **keenam** dari kelas skill/doc drift (lih. #805 dan
  pendahulunya). Penyebabnya bukan "lima kali lupa": tidak ada satu pun gate
  yang membandingkan registry modul dengan direktori skill. Registry tahu ada
  23 modul; tidak ada yang mengecek angka itu terhadap `.claude/skills/`.
  Konvensi "skill baru wajib disambungkan ke katalog" pun hanya konvensi tertulis,
  tanpa penegakan — persis celah yang membuat 4 skill baru di PR #806 lolos tanpa
  satu pun baris katalog. Empat dari lima modul tanpa skill justru muncul sebagai
  SUMBER temuan di audit #818 (#820, #822, #826, #786) — kebetulan yang bukan
  kebetulan: modul tanpa konvensi tertulis adalah modul yang konvensinya melenceng.

  Karena itu inti perubahan ini adalah **gate**-nya, bukan kelima file skill:
  `tests/unit/module-skill-coverage.test.ts` (jalan lewat `bun test`, sudah bagian
  `bun run check`) mewajibkan setiap modul di base registry (`listBaseModules()`)
  tercatat EKSPLISIT di tepat satu dari dua map — punya skill dedikasi, atau
  masuk **allow-list eksplisit** yang menyebut skill lintas-potong yang menanggung
  panduannya plus alasannya (dan skill itu wajib benar-benar ada, supaya alasannya
  tidak bisa diam-diam jadi bohong). Modul yang tidak ada di keduanya gagal
  keras dengan instruksi remediasi. Gate ini juga menegakkan bahwa setiap skill
  dedikasi benar-benar ada di disk, nama frontmatter-nya cocok dengan direktorinya,
  dan **tersambung di KEDUA katalog** — file SKILL.md yang tidak ditunjuk apa pun
  tidak dianggap selesai.

  Gate-nya langsung membuktikan diri pada run pertama: menemukan bahwa key modul
  yang terdaftar sebenarnya `workflow`, bukan `workflow_approval` seperti yang
  tertulis di direktori dan seluruh dokumentasinya (dicatat inline; rename key
  di luar scope karena memindahkan seluruh namespace permission `workflow.*`).

- ca15e33: Inversi `resolveNewsMediaR2Config` lewat `NewsMediaPort` sehingga `news_portal`
  kembali benar-benar opsional bagi `social_publishing` (Issue #859, epic #818).

  Adapter LinkedIn `social_publishing` dulu mengimpor
  `news-portal/domain/news-media-r2-config.ts`'s `resolveNewsMediaR2Config`
  secara statis (untuk R2 public base URL pada cek kepercayaan gambar
  `isTrustedR2MediaUrl`). Import lintas-modul itu adalah SATU-SATUNYA penyebab
  `social_publishing` harus mendeklarasikan `news_portal` sebagai dependency HARD
  di `module.ts` — bertentangan langsung dengan `capabilities.consumes` modul ini
  sendiri (`news_media`, `optional: true`) dan membuat tenant tidak bisa disable
  `news_portal` selama `social_publishing` aktif.

  Sekarang kapabilitas resolusi config itu di-rutekan lewat method baru
  `NewsMediaPort.resolveMediaPublicBaseUrl(env)` — pola inversi ADR-0011 yang
  sama dengan `NewsMediaPort.resolveMediaReferences` yang sudah ada. Composition
  root publish nyata (`scripts/social-publish-dispatch.ts`) menyuntikkan
  implementasi konkret `newsMediaPortAdapter` dari `news_portal`; proses SSR
  verify (yang tak pernah `publish`) sengaja tidak menyuntikkannya. Bila port tak
  di-inject atau `NEWS_MEDIA_R2_PUBLIC_BASE_URL` kosong, `publicBaseUrl` menjadi
  string kosong → semua gambar dianggap tak terpercaya → degradasi aman ke
  link-share (perilaku fallback yang sama seperti sebelumnya).

  Dampak: edge `social_publishing -> news_portal` dihapus dari `dependencies`
  (perubahan lifecycle — tenant kini boleh disable `news_portal` selagi
  `social_publishing` aktif tanpa blok reverse-dependency). Kepercayaan/upload
  gambar tetap DEPLOYMENT-WIDE (bucket R2 + `NEWS_MEDIA_R2_PUBLIC_BASE_URL` level
  deployment, port di-inject process-wide di dispatcher) — identik dengan
  perilaku pra-#859; degradasi ke link-share terjadi hanya bila port tak
  di-inject atau R2 base URL kosong, BUKAN karena tenant mematikan `news_portal`.
  Versi kontrak kapabilitas `news_media` di `capability-contract-versions.ts`
  dinaikkan `1.0.0` → `1.1.0` (penambahan method additive
  `resolveMediaPublicBaseUrl` pada port; MINOR/backward-compatible) agar app
  turunan bisa mendeklarasikan `requires news_media 1.1.0`.
  `social_publishing -> blog_content` TETAP dependency HARD (tidak diubah).
  `isTrustedR2MediaUrl` kini fungsi murni `(url, publicBaseUrl)` (signature
  berubah, hanya dipakai internal + unit test). Gate declared-dependency #826/#845
  tetap hijau karena tak ada lagi import lintas-modul `social_publishing ->
news_portal` yang tak dideklarasikan.

- ca15e33: Audit successful and failed password sign-ins (Issue #821).

  `POST /api/v1/auth/login` imported `recordAuditEvent` but only ever called it
  for `mfa_challenge_issued`, so neither a successful nor a failed password login
  left any trace — no audit trail existed for brute-force or credential-stuffing
  against the endpoint, and doc 01's base-ready requirement "Audit log high-risk
  tersedia" was unmet in code.

  The endpoint now writes exactly one `login_succeeded` or `login_failed` audit
  row per attempt, carrying the tenant, identity, method, source fingerprint,
  user agent, correlation ID, and — on failure — the deny reason
  (`invalid_credentials` / `locked` / `tenant_inactive` /
  `password_login_disabled`). `POST /api/v1/auth/mfa/totp/verify` gained the
  matching `mfa_challenge_failed` row, the one auth outcome in that route that
  was still untraced.

  Notes:

  - Failed logins stay on the record even when the login transaction is rolled
    back: an exception unwinding it is re-recorded out of band as
    `login_failed` / `internal_error`, and the original error is rethrown
    untouched.
  - Audit content cannot be used to enumerate accounts: the attacker-supplied
    `loginIdentifier` is never persisted, and an unknown account produces the
    same `invalid_credentials` reason as a real account with a wrong password.
  - Source IPs are persisted as a keyed `ipHash`, never in the clear — rows stay
    groupable by source without the audit trail becoming an address log.
  - No request or response shape changed; no migration.

- ca15e33: perf(db): add missing indexes for blog admin lists, the scheduled-publish job, and four unindexed FK columns (Issue #830)

  Migration `077_awcms_mini_performance_missing_indexes.sql` — pure DDL, no
  application code change.

  - `awcms_mini_blog_posts (tenant_id, updated_at DESC) WHERE deleted_at IS NULL`
    and the same on `awcms_mini_blog_pages`. Both admin list screens end in
    `ORDER BY updated_at DESC` but migration 026 created no `updated_at` index at
    all, so every page load was a Seq Scan of the tenant's whole post/page set
    plus a top-N heapsort. Measured on a 60k-row seed: root plan cost 3835 -> 2.9,
    execution 19.9ms -> 0.07ms, buffers 1655 -> 23.
  - `awcms_mini_blog_posts (tenant_id, scheduled_at) WHERE status = 'scheduled' AND deleted_at IS NULL`
    for the periodic scheduled-publish job. The existing
    `(tenant_id, status, published_at DESC)` index was already being used, but it
    cannot apply the `scheduled_at <= now()` bound, so the job read the heap for
    every scheduled post and discarded the not-yet-due ones; work grew with the
    future-scheduled backlog rather than with the number of due posts.
  - Indexes on four FK columns that had no covering index at all, so a parent
    DELETE forced a full child seq scan: `awcms_mini_abac_decision_logs.tenant_user_id`,
    `awcms_mini_visitor_sessions.identity_id`, `awcms_mini_sync_outbox.node_id`
    (its sibling `sync_inbox` already had the equivalent), and
    `awcms_mini_blog_ads.tenant_id` (also read-path: every `ads-directory.ts`
    query and the RLS policy filter on it, on a table with no index beyond its PK).

- ca15e33: Putuskan import cycle `domain_event_runtime ⇄ integration_hub` dan tutup akar penyebab kenapa dua gate bisa hijau di atasnya (Issue #826).

  **Akar masalahnya bukan cycle-nya, tapi dua gate yang tidak bisa melihatnya:**

  1. `tests/unit/module-boundary-cycles.test.ts` hanya memindai `application/` + `domain/`. Sisi keluar cycle ini ada di `infrastructure/`, jadi `aImportsB` terbaca false dan 258 pasang modul lolos hijau di atas cycle yang benar-benar hidup. Sekarang memindai `infrastructure/` + `api/` juga (plus bentuk bare side-effect import `import "…"`, yang kini load-bearing).

  2. `bun run modules:dag:check` adalah cycle detector yang benar, tapi hanya bisa menemukan cycle di antara edge yang **diberikan** kepadanya — dan edge itu berasal dari deklarasi `dependencies` di `module.ts` yang tidak pernah diperiksa terhadap kode. `domain-event-runtime/module.ts` mendeklarasikan `["tenant_admin", "identity_access", "logging"]` sementara `consumer-registry.ts` nyata-nyata mengimpor `integration_hub` dan `reporting`. Cycle detector yang disuapi graf tanpa edge cycle-nya sendiri **tidak mungkin gagal**. Gate baru `tests/unit/module-declared-dependencies.test.ts` membuat deklarasi bertanggung jawab pada kode — dengan baseline beku 16 edge pre-existing yang hanya boleh mengecil, supaya bisa rilis sekarang tanpa mengubah graf lifecycle 10 modul sekaligus.

  **Cycle-nya sendiri:** port di `_shared/ports/` tidak bisa memperbaikinya. Port hanya menghapus ketergantungan TIPE dari plugin ke runtime, padahal `integration_hub → domain_event_runtime` adalah value import yang sah dan permanen (`appendDomainEvent`, `event-type-registry` — modul ini memang PLUGIN dari runtime tsb). Satu-satunya arah yang bisa dihapus adalah arah runtime → plugin. Jadi registrasi consumer dibalik: modul pemilik consumer mendaftarkan dirinya lewat `registerDomainEventConsumer` dari `<modul>/infrastructure/domain-event-consumer-registration.ts`, dan runtime tidak mengimpor kode modul consumer sama sekali. Ini memperbaiki pelanggaran layering yang mendasari cycle-nya: modul `system` foundation tidak boleh bergantung pada feature module yang menancap padanya (ADR-0013 §1).

  `reporting` ikut dibalik. Edge `domain_event_runtime → reporting` bukan import cycle, tapi berlawanan langsung dengan `reporting/module.ts` yang sengaja mendeklarasikan `domain_event_runtime` sebagai "genuine lifecycle-ordering dependency" — kontradiksi yang baru terlihat begitu deklarasi dipaksa cocok dengan import, dan yang membuat `modules:dag:check` gagal dengan cycle `reporting -> domain_event_runtime -> reporting` yang nyata.

  **Risiko yang dibawa inversi ini, dan gate-nya:** registrasi lewat side-effect import bisa tidak lengkap di suatu proses, dan gagalnya **senyap** — `dispatch-domain-events.ts` mengiterasi consumer yang TERDAFTAR, jadi delivery milik consumer yang tidak terdaftar tidak pernah di-claim sama sekali (tidak ada error, tidak ada dead-letter, hanya `pending` selamanya). `tests/unit/domain-event-consumer-registration-wiring.test.ts` menemukan file registrasi lewat konvensi lalu memaksa setiap composition root mengimpornya.

  Tanpa perubahan perilaku untuk deployment yang sudah jalan: consumer yang sama tetap terdaftar dengan nama, event type, versi, dan handler yang identik.

- ca15e33: Collapse the module health fan-out from O(modules) to O(1) (Issue #824).

  `fetchModuleMatrix` and `admin/modules.astro` resolved health by calling
  `fetchModuleHealthReport` once per registered module, and each call ran its own
  registry lookup, migration scan, permission-catalog query and settings lookup —
  94 queries to render one admin screen at 23 modules, growing with every module
  added. Those four inputs are now prefetched once per render
  (`prepareModuleHealthContext`) and shared across modules, and multi-module
  callers use the new `fetchModuleHealthReports` batch entry point.

  Separately, `readYamlCached` populated its cache only after awaiting, so the 22
  modules declaring the same ~1 MB `openapi.yaml` each read and parsed that file
  concurrently on a cold render. It now caches the in-flight promise, so
  concurrent callers join one parse; `listMigrationFileNames` is cached the same
  way (it was re-`readdir`-ing on every signal).

  Measured per render at 23 modules: 94 → 6 queries, ~3.8s → ~0.36s cold, ~10ms →
  ~6ms warm. No behaviour change — the same signals, order, statuses and generic
  (never raw) error details. `includeHealth: false` still runs zero health work.

- ca15e33: Selaraskan kontrak OpenAPI PATCH `organization_structure` dan `reference-data`
  value-sets dengan semantik partial-PATCH yang benar (Issue #837, epic #818).
  Runtime sudah diperbaiki di PR #852 (absent = pertahankan, `null` = kosongkan),
  tetapi skema OpenAPI masih "berbohong": PATCH legal-entities/locations memakai
  ulang skema Create (`required: [name]`), PATCH unit-types/units/value-sets masih
  `required: [name]` — semuanya melegitimasi reset yang justru dihapus di runtime.

  Perubahan: PATCH kini memakai skema Update khusus yang all-optional
  (`OrganizationStructureUpdateLegalEntityRequest`,
  `OrganizationStructureUpdateUnitTypeRequest`,
  `OrganizationStructureUpdateLocationRequest`), `OrganizationStructureUpdateUnitRequest`
  dan `ReferenceDataUpdateValueSetRequest` tak lagi `required: [name]`. Skema Create
  tetap menuntut `name` (memang wajib saat pembuatan). `name`/`effectiveFrom` tetap
  non-nullable pada PATCH karena runtime menolak `null` (NOT NULL) dengan 400.

- ca15e33: Perbaiki dua beban performa di jalur hierarki `organization_structure` (Issue
  #834). Keduanya murni optimasi — verdict, kontrak, dan hasil setiap fungsi tidak
  berubah sedikit pun.

  **1. `resolveLegalEntityScope`: walk descendant O(S x depth), worst O(U²) → O(U + E).**
  Adapter memanggil `computeDescendants` sekali per unit yang mendeklarasikan legal
  entity, dan tiap panggilan mengalokasi `visited` set **baru** — nol sharing,
  sehingga setiap subtree yang dipakai bersama di-walk ulang sekali untuk tiap seed
  di atasnya. `computeDescendantClosure` yang baru mengerjakan hal yang sama
  sebagai **satu traversal multi-source di atas satu `visited` set bersama**: tiap
  node dikunjungi tepat sekali.

  **2. `readEdgeMap` full-tenant di dalam critical section advisory lock → recursive CTE ancestor chain.**
  `reparentUnit` memuat **seluruh** edge map tenant di dalam
  `pg_advisory_xact_lock` tenant-wide, jadi throughput reparent per tenant turun
  linear terhadap **ukuran tenant** — padahal cycle check hanya bergantung pada
  **kedalaman** hierarki. `validateReparent` hanya pernah berjalan **ke atas** dari
  `candidateParentId`, jadi `readAncestorChainEdgeMap` (recursive CTE) memuat cukup
  rantai ancestor saja: verdict identik, O(depth) bukan O(tenant).
  `candidateParentId === null` kini melewati query sepenuhnya (tak mungkin bikin
  cycle).

  **Advisory lock TIDAK diubah dan TIDAK dilemahkan.** Map tetap dibaca **setelah**
  lock diambil — urutan itulah perbaikan race-nya, dan alternatif "ambil map
  sebelum lock lalu revalidasi" justru membuka kembali race yang lock ini tutup.
  Yang mengecil hanya **jumlah kerja di dalam** lock. Test konkurensi reparent yang
  ada tetap hijau, ditambah test baru untuk cycle dalam (8 hop) lewat endpoint
  nyata.

  **Benchmark, tenant 10.000 unit (Postgres 18, seluruh unit mendeklarasikan legal
  entity yang sama — worst case untuk walk per-seed):**

  | Shape            | Baca di dalam lock (SQL) | Walk `resolveLegalEntityScope` |
  | ---------------- | ------------------------ | ------------------------------ |
  | Wide (spine 50)  | 5,67 ms → 0,40 ms (14x)  | 28,62 ms → 1,02 ms (28x)       |
  | Deep (chain 10k) | 4,97 ms → 1,58 ms (3,1x) | 4383,55 ms → 0,83 ms (5304x)   |

  Shape deep mengonfirmasi ledakan kuadratik yang diprediksi issue secara empiris.
  Hasil kedua shape identik dengan sebelum perubahan (10.000 scope).

  **Tanpa migration.** Recursive step-nya lookup `(tenant_id,
organization_unit_id)` per level; `EXPLAIN ANALYZE` mengonfirmasi Nested Loop +
  Index Scan di tiap level (`shared hit=6`, tanpa seq scan) memakai index yang
  sudah ada dari `sql/063`.

  **Koreksi premis issue.** DoD meminta `resolveLegalEntityScope` "filter root
  beneran di SQL", dengan alasan walk-nya redundan. Itu keliru dua kali:
  `awcms_mini_organization_units` **tidak punya kolom `parent_id`** (hierarki hidup
  di tabel `awcms_mini_organization_unit_hierarchies` yang terpisah dan
  effective-dated), jadi predikat `parent_id IS NULL` tak bisa ditulis; dan
  walk-nya **load-bearing**, bukan redundan — descendant rutin **tidak**
  mendeklarasikan entity-nya sendiri (mereka mewarisi secara struktural), jadi
  closure-nya benar-benar lebih besar dari seed set. Memfilter seed ke root akan
  **diam-diam mempersempit scope otorisasi**: unit yang mendeklarasikan entity di
  bawah parent yang tidak mendeklarasikannya akan hilang bersama seluruh
  subtree-nya. Yang cacat adalah **bentuk** walk-nya, bukan keberadaannya. Test
  regresi baru mengunci kontrak ini agar "perbaikan" root-filter itu tidak
  diterapkan nanti.

  Ini recursive CTE **pertama** di repo. Pola "satu bulk query muat seluruh
  adjacency tenant, walk in-memory" tetap benar di semua read path lain (di sana
  map penuh memang jawabannya); ia salah **khusus di sini** karena baca ini duduk
  di dalam lock tenant-wide dan hanya butuh satu jalur ke akar.

- ca15e33: Perbaiki semantik PATCH reference-data & organization-structure (Issue #843 &
  #837, epic #818).

  **#843** — Keputusan no-op `PATCH {}` untuk reference code (global & tenant)
  kini hidup DI DALAM `updateReferenceCode`/`updateTenantReferenceCode`, bukan di
  short-circuit call site. Helper menerima patch mentah (`ReferenceCodePatchInput`)
  lalu memutuskan refusal (`managed_by_descriptor` / deprecated), no-op, dan merge
  di satu tempat — sehingga jawaban endpoint tak lagi bergantung pada berapa field
  yang kebetulan dikirim. Menambah test paritas untuk sumbu `managed_by_descriptor`
  yang sebelumnya nol coverage.

  **#837** — PATCH parsial pada `organization-structure` (units, legal-entities,
  locations, unit-types) dan `reference-data/value-sets/{key}` tidak lagi mereset
  field yang dihilangkan. Semantik benar: **absent = pertahankan**, **`null` =
  kosongkan** field nullable, `null` pada field `NOT NULL` (name/effectiveFrom) = 400. Sebelumnya PATCH satu field diam-diam memotong riwayat effective-dating
  (`effectiveFrom` → now, `effectiveTo` → null) dan menghapus name/description.
  Menambah helper parse/merge reusable di `_shared/partial-patch.ts` plus test
  partial-PATCH (sebelumnya nol coverage untuk PATCH organization-structure).

- ca15e33: Perbaiki tiga temuan security-auditor pada PR #839 (epic #818).

  **Gate `requiredPermission` deskriptor kini ditegakkan di halaman admin
  (HIGH).** `src/pages/admin/data-exchange/imports/[id].astro` tidak melewati
  route API mana pun — ia melakukan query dan proyeksi staged row sendiri — dan
  mereplikasi gate raw-value dengan benar tapi **tidak pernah** memutuskan
  `ExchangeDescriptor.requiredPermission`, izin milik modul pemilik yang
  ditegakkan keenam route API. Deskriptor dengan `requiredPermission:
"hr.payroll.read"` karenanya ditegakkan di seluruh permukaan API dan nol di
  UI: pemegang `data_exchange.imports.read` generik bisa membaca konten staged
  modul lain (natural key, validation error, laporan rekonsiliasi) langsung dari
  halaman. Halaman kini memanggil `isDescriptorPermissionGranted` — keputusan
  yang sama dengan route, dibagi dari satu tempat — dan deskriptor yang tidak
  lagi resolve (modul pemilik dinonaktifkan setelah staging) kini **deny**, bukan
  sekadar `maskAllFields`.

  **`AUTH_JWT_SECRET` tidak lagi deprecated, dan tidak lagi merosot senyap
  (HIGH).** Sejak Issue #821 variabel ini adalah kunci HMAC nyata untuk pseudonim
  IP (`ipHash`) di audit log, tapi registry menandainya `deprecated` dengan
  `removalVersion: "1.0.0"` ("terverifikasi mati / nol konsumen") sementara
  `client-fingerprint.ts` mem-fallback ke `?? ""`. Saat variabel itu benar-benar
  dihapus sesuai jadwal, `hashClientIp` akan merosot jadi SHA-256 tanpa garam —
  ruang IPv4 hanya 2^32, jadi **setiap `ipHash` di audit trail menjadi
  reversibel**, tanpa satu pun error. Dipilih **Opsi A** (mencabut deprecation)
  di atas Opsi B (var baru `AUTH_IP_HASH_KEY`): key separation di sini tidak
  membeli apa pun karena `AUTH_JWT_SECRET` terverifikasi tidak menandatangani
  apa pun (sesi = token opaque; `jwt-verify.ts` RS256 lewat JWKS penyedia), jadi
  tidak ada risiko cross-protocol — sementara var wajib baru memaksa perubahan
  pada setiap deployment yang sudah berjalan tanpa keuntungan keamanan. Fallback
  `?? ""` dihapus (lempar, jangan merosot senyap), dan `validate-env` kini
  menolak placeholder `.env.example` lewat `checkAuthJwtSecretNotDefault`
  (memakai ulang pola `checkSyncHmacSecretNotDefault`; `checkRequiredVars` hanya
  mengecek non-kosong, dan placeholder itu non-kosong).

  **Teks bebas tidak lagi meloloskan nilai yang di-mask (MEDIUM).**
  `maskSensitiveFields` mempertahankan `validationWarnings` utuh, padahal
  `maskAllFields` membuangnya dengan alasan eksplisit "warning adalah teks bebas
  yang mungkin diinterpolasi adapter dengan nilai mentah" — alasan yang berlaku
  identik di kedua jalur. Sebuah warning `"email x@y.com sudah terdaftar"`
  mengembalikan nilai yang baru saja di-mask dari `fields.email`. `commitError`
  (= `outcome.reason` adapter) dipertahankan utuh di **kedua** jalur termasuk
  default-deny. Keduanya kini dibuang/di-mask di kedua jalur; `commitStatus`
  tetap, jadi baris masih melaporkan BAHWA ia gagal, hanya bukan dengan nilai
  apa.

  Selain itu: komentar `login.ts` yang mengklaim respons login "byte-identical
  regardless of whether the identity exists" diperbaiki — klaim itu salah
  (`locked` dan `password_login_disabled` dapat dibedakan dan hanya tercapai bila
  identity ada). Oracle enumerasinya sendiri pre-existing dan dilacak di Issue
  #840; perilakunya sengaja tidak diubah di sini.

- ca15e33: Perbaiki tiga temuan review PR #839.

  **`prepareModuleHealthContext` menjalankan 4 query lewat `Promise.all` di atas
  satu `tx`.** Satu koneksi Postgres melayani satu query pada satu waktu, dan pola
  persis ini pernah menyebabkan hang nyata di repo ini (lihat catatan di
  `reporting/application/projection-reconciliation.ts` — koneksi yang tersangkut
  lalu merusak `resetDatabase()` setiap test sesudahnya). Regresi dari perbaikan
  Issue #824; kemenangannya memang bukan konkurensi melainkan meruntuhkan fan-out
  per-modul menjadi empat query total, dan itu tetap utuh dengan await berurutan.

  **`readJsonBody(...) ?? {}` mengubah body yang absen/rusak/bukan-objek menjadi
  patch kosong yang sah** pada kedua route PATCH reference-data, sehingga body
  sampah lolos otorisasi + idempotency dan mendarat sebagai write sungguhan.
  Ditambahkan `readJsonObjectBody` + `invalidJsonObjectBodyResponse` di
  `lib/security/request-body-limit.ts`: `{}` tetap `ok` (objek kosong itu body
  sungguhan), sedangkan absen/malformed/`null`/array/skalar ditolak `400`.

  **`PATCH {}` — no-op yang terdokumentasi — tetap menjalankan `update*` tanpa
  syarat**, membuat `updated_at` naik, menulis ulang baris translation, memancarkan
  audit event dan domain event untuk request yang tidak mengubah apa pun. Kini
  di-short-circuit dan mengembalikan representasi saat ini. Refusal
  `managed_by_descriptor` (Issue #750) tetap diperiksa di jalur no-op agar jawaban
  endpoint tidak bergantung pada berapa field yang kebetulan dikirim pemanggil.

- ca15e33: Perbaiki dua temuan review PR #839 ronde 4.

  **`sensitiveFields.naturalKeyField` tidak dideklarasikan di schema OpenAPI.**
  Descriptor default `data_exchange.reference_items` menyetelnya, sementara
  `DataExchangeDescriptor.sensitiveFields` adalah `additionalProperties: false`
  yang hanya memuat `fieldNames`/`rawValuePermission` — jadi
  `GET /api/v1/data-exchange/descriptors` melanggar kontraknya sendiri dan client
  ter-generate akan menolaknya. Ditambahkan gate
  `tests/unit/data-exchange-descriptor-contract-parity.test.ts` yang memvalidasi
  descriptor registry nyata terhadap schema nyata; validasi response-vs-schema
  umum difilekan sebagai #844.

  **Placeholder `AUTH_JWT_SECRET` diterima saat runtime.**
  `checkAuthJwtSecretNotDefault` benar dan tersambung, tetapi tidak ada yang
  memaksanya berjalan: `bun run dev`/`bun run start` memanggil server langsung,
  tidak pernah `config:validate`. Deployment hasil salin `.env.example` boot
  dengan tenang memakai nilai yang dipublikasikan di repo publik sebagai kunci
  HMAC `ipHash` — membuat setiap `ipHash` tersimpan bisa dibalik (ruang IPv4 2^32),
  yaitu satu-satunya properti yang jadi alasan pseudonym ini ada. Placeholder kini
  ditolak di titik pakai, sehingga tidak ada jalur boot yang bisa melewatinya.
  Nilainya dibaca dari `default` milik entri registry, bukan diketik ulang, agar
  tidak melenceng dari `.env.example`.

- ca15e33: Perbaiki temuan review PR #839 ronde 5: replay idempotent pada
  `imports/{id}/commit` dan `imports/{id}/retry` tertahan gate descriptor.

  Branch fail-closed dari #820 Cacat 3 berjalan **sebelum**
  `findIdempotencyRecord`, sehingga client yang mencoba ulang commit dengan
  `Idempotency-Key` + request hash yang sama **setelah modulnya di-disable**
  mendapat `409` baru alih-alih response yang sudah tersimpan. Itu melanggar
  kontrak yang dinyatakan `_shared/idempotency.ts` secara eksplisit ("same key +
  same request hash -> replay the stored response").

  Replay **tidak menjalankan adapter sama sekali** — ia mengembalikan hasil yang
  sudah tercatat untuk key+hash itu, di bawah gate lengkap sebagaimana berlaku
  saat itu. Gate descriptor ada untuk menjaga **write**, jadi menggerbangi replay
  dengannya tidak mencegah apa pun sambil membuat satu key+hash menjawab berbeda
  seiring waktu. Replay kini berjalan lebih dulu di kedua route; gate fail-closed
  tetap utuh untuk key baru.

- ca15e33: Perbaiki tiga temuan review PR #839 ronde 6.

  **Gate paritas CI (#823) sendiri bisa dibohongi prosa.** Ia memindai seluruh
  teks `ci.yml`, sehingga penyebutan `bun test` di komentar — atau bahkan di
  `name:` sebuah langkah — sudah memuaskannya walau step `run: bun test` aslinya
  dihapus. Gate itu hijau persis di skenario drift yang jadi alasan ia ada, yaitu
  kegagalan "gate hijau di atas cacat nyata" yang justru hendak ia akhiri. Kini
  YAML-nya diurai dan hanya badan `run:` yang diperiksa, ditambah meta-test yang
  memaku properti itu.

  **Field PATCH tak dikenal di-no-op-kan, bukan ditolak.** Kedua schema PATCH
  adalah `additionalProperties: false`, tetapi parser membaca kunci yang dikenalnya
  dan mengabaikan sisanya — typo klien (`validUntil` alih-alih `validTo`) terurai
  jadi patch kosong. Digabung dengan cabang no-op, typo itu menjawab `200` sambil
  tidak mengubah apa pun: request tampak diterima padahal tidak melakukan apa-apa.
  Kunci tak dikenal kini ditolak `400`. Parser ini sebelumnya tidak punya unit test
  sama sekali; kini ada.

  **`sensitiveFields` wajib di TypeScript tapi tidak di schema OpenAPI.** Registry
  menolak descriptor yang menghilangkannya (#820 Cacat 1), namun
  `DataExchangeDescriptor.required` tidak memuatnya — client ter-generate tetap
  menganggap policy masking opsional.

- ca15e33: Sertakan state module-enabled dalam keputusan gate SSR data-exchange (temuan
  review bot pada PR #839).

  Gate SSR yang ditambahkan PR #839 hanya melakukan `permissions.has(key)`.
  Jalur API tidak begitu: `authorizeInTransaction` memanggil `resolveModuleEnabled`
  dan menolak `403 MODULE_DISABLED` **sebelum** RBAC dievaluasi, sementara
  `fetchGrantedPermissionKeys` — yang membangun permission set SSR — **tidak**
  memfilter modul yang disabled. Subject karenanya tetap memegang setiap
  permission key milik modul yang sudah dimatikan tenant, jadi
  `/admin/data-exchange/imports/[id]` **tetap merender staged row** sementara
  route preview/commit menjawab 403. SSR lebih longgar daripada API: kelas
  paritas yang sama dengan temuan `requiredPermission` asli, kambuh di sumbu
  berbeda.

  Cek module-enabled kini berada **di dalam** `isDescriptorPermissionGranted`
  (bukan di call site) sehingga tak ada pemanggil yang bisa melupakannya, dengan
  urutan yang sama seperti route: modul dulu, baru RBAC. Berlaku untuk
  `requiredPermission` **dan** `rawValuePermission` — jalur raw-value route
  adalah `authorizeDescriptorPermissionKey`, yang juga meresolusi state modul,
  jadi `permissions.has()` telanjang di halaman akan membuka nilai yang di-mask
  route begitu modul pendeklarasinya disabled. Halaman juga kini memeriksa
  `data_exchange` sendiri: konstanta `CAN_*`-nya semua tetap true untuk tenant
  yang mematikan modul itu.

  Test paritas SSR-vs-route diperluas ke sumbu ini — **terbukti merah** tanpa
  perbaikan (route menolak 403, SSR mengizinkan), hijau dengan. Test paritas
  sebelumnya lolos padahal celahnya ada karena ia hanya membandingkan satu sumbu
  (apakah caller memegang key), bukan setiap sumbu yang benar-benar dikonsultasi
  guard route.

  Celah yang sama ada di **54 halaman admin lain** (survei menyeluruh: 1 dari 55
  halaman pemuat data yang memeriksa module-enabled; middleware dan AdminLayout
  tidak memitigasi — filter nav layout hanya kosmetik dan bisa dilewati dengan
  mengetik URL). Di luar scope PR ini, dilacak di Issue #841 beserta opsi
  struktural, karena menambal 54 halaman satu per satu akan hanyut lagi.

- ca15e33: Perbaiki tiga temuan review PR #847.

  **Invalidasi cache dikalahkan load yang sedang in-flight.** `invalidate()` hanya
  bisa menghapus yang sudah tersimpan, sementara loader yang mulai SEBELUM commit
  masih memegang snapshot pra-commit dan menyeatnya kembali sesudahnya dengan TTL
  penuh — eviction-nya dibatalkan oleh pembacaan yang sudah terlanjur di udara.
  Kedua reviewer menemukannya dari arah berlawanan: domain yang dicabut tetap
  dilayani 60s, dan domain yang baru diverifikasi tetap 404 selama 60s dari entri
  NEGATIF — persis kasus yang `tenant/domains/[id]/verify.ts` dokumentasikan
  sebagai alasan ia melakukan invalidasi. Ditambahkan generation counter per key +
  `inFlight.delete()` saat invalidate.

  **Perubahan Settings tidak menginvalidasi cache publik.** Nilai yang di-cache
  memuat `tenant_status, tenant_code, tenant_name, default_locale` dari
  `awcms_mini_tenants` — tabel yang dimutasi modul `tenant_admin` dan tak pernah
  disentuh modul `tenant_domain`. Cache-nya murni fungsi host pada KUNCI-nya, bukan
  pada NILAI-nya. Ganti nama tenant → halaman publik & RSS menyajikan nilai lama
  hingga TTL, padahal sebelum cache ada mereka benar di request berikutnya.

  **Gate wiring #826 tidak memeriksa sisi PUBLISH.** `appendDomainEvent` membuat
  delivery row dari registry saat publish, jadi publisher tanpa import registrasi
  menghasilkan nol row — kehilangan permanen, tak seperti dispatch root yang
  terlewat (row `pending` masih bisa dipulihkan). Ditambahkan `PUBLISH_ROOTS`
  terpisah, karena aturan "tiap root impor SETIAP registrasi" benar untuk root
  peresolusi handler tapi akan membuat ulang edge lintas modul yang #826 hapus.
  Kedua gate kini mencocokkan **statement import**, bukan sembarang kemunculan
  path — versi pertamanya lolos padahal import-nya dihapus karena ada komentar
  menyebut path yang sama.

- ca15e33: Hapus seluruh kelas `Promise.all` di atas satu transaction handle (`tx`), lalu
  pasang gate statis supaya tidak kambuh untuk kelima kalinya (Issue #842, epic
  #818).

  Satu koneksi Postgres melayani **satu query pada satu waktu**. `tx` terikat ke
  tepat satu koneksi, jadi `Promise.all([q1(tx), q2(tx)])` bukan sekadar
  kehilangan paralelisme — ia **menghang sungguhan** di repo ini, dan koneksi yang
  tersangkut lalu merusak `resetDatabase()` **setiap test sesudahnya**, sehingga
  gejalanya muncul jauh dari penyebabnya. Catatan kanoniknya ada di
  `src/modules/reporting/application/projection-reconciliation.ts:89-94`.

  Sapuan kelas penuh menemukan **11 site**, bukan dua seperti dugaan awal isu —
  seluruhnya pre-existing (2026-07-07 s.d. 2026-07-15), tidak ada yang regresi PR
  manapun:

  - `module-management/application/module-matrix.ts` (2 site: fan-out katalog, dan
    loop per-modul yang aman **hanya** selama `healthContext` yang sudah
    di-prefetch ikut dioper — satu argumen hilang dan tiap iterasi jadi 4 query
    konkuren di atas satu `tx`; kini loop sekuensial sehingga keamanannya
    struktural, bukan bergantung pada argumen yang tak diwajibkan siapa pun)
  - `reference-data/application/reference-resolution-query.ts` (2 site)
  - `visitor-analytics/application/rollup.ts` dan `analytics-queries.ts` (4 query
    masing-masing)
  - `admin/blog/index.astro`, `admin/blog/posts/[id].astro`,
    `admin/modules/[moduleKey].astro` (yang terlebar: `fetchModuleHealthReport`
    dipanggil tanpa context ter-prefetch, sendirian menambah 4 query — sampai
    delapan balapan di satu koneksi)
  - `api/v1/blog/menus/index.ts` (fan-out **tak terbatas**: satu query konkuren per
    menu milik tenant)
  - `api/v1/data-exchange/imports/[id]/preview.ts`, `api/v1/analytics/devices.ts`

  Semua gating permission dipertahankan persis: read yang ditolak tetap tidak
  mengeluarkan query apa pun dan tetap memakai fallback-nya. Tidak ada performa
  yang hilang — yang mahal adalah **jumlah** query, bukan serialisasinya (kemenangan
  Issue #824 adalah meruntuhkan ≈92 query per render jadi 4, dan await berurutan
  mempertahankannya utuh). Komentar usang di `admin/modules.astro` yang masih
  mengklaim health dihitung paralel lewat `Promise.all` ikut dikoreksi.

  Gate baru `bun run tx:lint:check`
  (`scripts/tx-concurrency-lint-check.ts`, dipasang di `check` dan `ci.yml`)
  menandai `Promise.all`/`allSettled` yang menyentuh transaction handle. Kelas ini
  sudah kambuh 4x dan **test suite lolos setiap kali** — sifatnya load-dependent,
  jadi test fungsional memang bukan gate untuk kelas ini. Konkurensi di atas POOL
  (`sql`) tetap legal dan tak tersentuh: pool memberi koneksi terpisah per query.

  Gate membaca **token, bukan teks mentah**: komentar dan literal string/template
  di-blank lebih dulu lewat state machine. Ini bukan kehati-hatian teoretis —
  setiap perbaikan di atas menaruh komentar berbunyi "Sequential, NOT
  `Promise.all` … over the same `tx`" tepat di atas kode yang diperbaiki, jadi gate
  berbasis substring akan menandai justru kode yang sudah benar; dan gate saudaranya
  `ci-check-parity.test.ts` shipped dengan cacat "prosa memuaskan gate" yang persis
  sama (diperbaiki di PR #839).

- ca15e33: Perbaiki bug keamanan quorum-`all` bypass pada `POST /api/v1/workflows/tasks/{id}/decisions` (Issue #851, spin-off epic #818).

  Satu approver yang di-assign ke task ber-quorum `all` bisa memenuhi quorum SENDIRIAN dengan mengirim dua approve konkuren ber-`Idempotency-Key` berbeda (READ COMMITTED TOCTOU): `findEligibleAssignment` membaca assignment tanpa row lock, `recordWorkflowTaskDecision` meng-`UPDATE` assignment ke `decided` tanpa predikat `status = 'pending'`, dan tabel `awcms_mini_workflow_decisions` tidak punya unique constraint per decider. Dua transaksi konkuren sama-sama melihat `pending`, sama-sama mencatat decision, dan instance berpindah ke `approved`.

  Perbaikan berlapis:

  - `findEligibleAssignment` kini `SELECT ... ORDER BY id FOR UPDATE` pada baris assignment task (blocking wait, urutan lock deterministik anti-deadlock) — request kedua menunggu request pertama commit, membaca ulang status `decided`, lalu dilaporkan tidak eligible (403).
  - `UPDATE ... SET status = 'decided'` kini bersyarat `AND status = 'pending'` (menolak transisi ganda).
  - Migration `078` menambah partial UNIQUE index `awcms_mini_workflow_decisions (tenant_id, workflow_task_id, decided_by_tenant_user_id) WHERE is_administrative_override = false` — satu suara ordinari per decider per task (administrative override sengaja dikecualikan). Juga menutup varian sekuensial di mana satu user adalah assignee langsung sekaligus delegate assignee lain pada task yang sama.
  - Duplikat konkuren/sekuensial dipetakan ke `409 IDEMPOTENCY_CONFLICT` via `WorkflowTaskDecisionConflictError`, bukan `500`. Replay `Idempotency-Key` yang sama tetap bekerja seperti sebelumnya.

- ca15e33: fix(reference-data): `PATCH` on reference codes is now genuinely partial instead of behaving like `PUT`

  `PATCH /api/v1/reference-data/tenant-codes/{id}` and
  `PATCH /api/v1/reference-data/value-sets/{key}/codes/{code}` parsed their request
  body with per-field defaults, so any field omitted from the body was silently
  reset instead of preserved: `sortOrder` -> `0`, `metadata` -> `{}` (permanent
  data loss), `validFrom` -> `now()` (truncating a code's validity history), and
  `validTo` -> `null`. A client sending the normative partial `PATCH` — e.g. only
  `labels` to rename a code — lost the other four fields and received a `200` with
  no warning. Since reference data is load-bearing for downstream documents and
  transactions, a silently rewritten `validFrom`/`validTo` window is a correctness
  hazard, not just a cosmetic one.

  Both endpoints now merge the parsed patch onto the stored record, with an
  explicit and documented null-vs-absent contract:

  - **absent** field — the stored value is kept untouched;
  - **explicit `null`** — the field is cleared/reset (`sortOrder` -> `0`,
    `metadata` -> `{}`, `validTo` -> `null`);
  - `labels` and `validFrom` reject `null` with a `400 VALIDATION_ERROR` (at least
    one label is always required, and `valid_from` is `NOT NULL`) rather than being
    silently defaulted;
  - `labels` still replaces all stored labels wholesale, and `metadata` still
    replaces rather than deep-merges, when present.

  `labels` is no longer a required property of either request body — an empty
  `{}` body is a valid no-op. OpenAPI documents the semantics per field.

- ca15e33: fix(release): reconcile release pipeline to the tag/changelog format Changesets actually emits (#825)

  The first real release attempt surfaced that the automated release path
  had never worked end-to-end, for reasons the original #825/#854 diagnosis
  got backwards:

  - **Tag format.** `bun run changeset:tag` emits `vX.Y.Z` for this
    single-package repo (Changesets uses `v<version>` for a single root
    package, not `<name>@<version>`). The legacy `awcms-mini@0.0.x` tags were
    hand-made, not changeset output, and misled the audit. #854 had switched
    `release.yml`'s trigger to `awcms-mini@*` — which `changeset:tag` never
    produces here — so this reverts the trigger (and the cosign
    identity-regexp doc) back to `v*.*.*`, matching the generator.
  - **Changelog header format.** `changeset:version` writes `## X.Y.Z`, but
    both `scripts/release-verify.ts` and `release.yml`'s RELEASE_NOTES `awk`
    only recognized the legacy `## [X.Y.Z]` bracket form — so `release:verify`
    failed and release notes came out empty for every changeset-generated
    release. Both now accept `## X.Y.Z` and the legacy `## [X.Y.Z]`.

  No runtime/product behavior changes; release tooling + docs only. The
  build/SBOM/cosign/attest/publish mechanics themselves were already proven
  (rehearsal run 29640049800, SLSA provenance attestation verified).

- ca15e33: Percepat deteksi konflik SoD (`detectSoDConflicts`) dengan meng-hoist index
  sekali per request, dan gabungkan lookup exception yang tadinya N+1 menjadi satu
  query — keduanya berjalan di dalam transaksi DB pada jalur POST business-scope
  assignment yang ditunggu admin (Issue #833, bagian dari #818).

  **Kompleksitas: O(P×R×K×F×S) → O(P × matchingRules)** (P = permission dari role
  yang di-assign, R = rule terdaftar, K = key per rule, F = fakta subjek, S = scope
  hierarki terkait). `createSoDConflictEvaluator` membangun tiga index sekali —
  rule per trigger key, fakta per permission key, `relatedScopes` sebagai `Set` —
  menggantikan `subjectFacts.filter(...)` yang men-scan ulang penuh per rule per
  key dan `relatedScopes.some(...)` yang bersarang di dalam `holdingFacts.some(...)`.
  `findValidSoDConflictException` (satu query DB **per match**, di dalam loop, di
  dalam transaksi) kini dibatch lewat `findValidSoDConflictExceptionsByRuleKeys`
  dengan satu `rule_key = ANY(...)`; jalur single-key ikut mendelegasi ke statement
  yang sama supaya tidak ada dua salinan aturan validitas yang bisa melenceng.

  Angka benchmark nyata (bun, 200 repetisi per skenario, satu POST assignment):

  | Skenario                                                   | Sebelum                           | Sesudah  | Speedup |
  | ---------------------------------------------------------- | --------------------------------- | -------- | ------- |
  | Registry apa adanya hari ini (3 rule, P=150, F=1000, S=20) | 0.067 ms (7.203 kunjungan elemen) | 0.056 ms | 1,2x    |
  | Registry bertumbuh (50 rule, P=200, F=1000, S=20)          | 1,458 ms (332.391 kunjungan)      | 0,166 ms | 8,8x    |
  | Tenant besar (50 rule, P=200, F=5000, S=200)               | 9,564 ms (2.173.191 kunjungan)    | 0,393 ms | 24,4x   |

  Catatan kejujuran soal angka: premis "~6 juta kunjungan elemen untuk satu POST"
  di Issue #833 **tidak berlaku untuk registry saat ini**. `O(P×R×K×F×S)` adalah
  batas worst-case yang mengandaikan setiap permission memicu setiap rule; nyatanya
  hanya ada 3 rule (K=2) dan short-circuit `conflictingPermissionKeys.includes(...)`
  membuat `subjectFacts` cuma di-scan untuk permission yang benar-benar memicu rule
  — terukur 7.203 kunjungan (~67 mikrodetik), bukan jutaan/"detik-detikan CPU".
  Perbaikan ini tetap dikerjakan karena murah dan menghilangkan skala buruk sebelum
  registry tumbuh (kolom kedua/ketiga tabel), bukan karena ada krisis latensi hari
  ini.

  Perilaku deteksi **identik** sebelum/sesudah — ini jalur keamanan, jadi perubahan
  di sini murni struktur data: urutan match, penanganan `indeterminate`, wildcard
  fakta null-scope (grant RBAC biasa), dan pencocokan hierarki `same_scope_only`
  (#794) semuanya dipertahankan persis. Dijamin oleh test diferensial baru yang
  membandingkan implementasi baru dengan transkripsi harfiah implementasi pra-#833
  pada ~4.000 input acak (seeded) plus pin regresi hierarki; seluruh test SoD yang
  sudah ada tetap hijau tanpa diubah.

  Ikut diperbaiki di blok yang sama: `Promise.all([...])` atas satu `tx` (dua query
  pada satu koneksi transaksi = risiko hang nyata, lihat
  `reporting/application/projection-reconciliation.ts:89-94`) diganti await
  berurutan.

- ca15e33: Tutup celah keamanan #841 (halaman admin SSR merender data modul yang di-disable)
  dan batch sejumlah N+1 lintas modul #835 (epic #818).

  **#841 — gate module-enabled untuk seluruh 54 halaman admin SSR, di satu tempat.**
  Jalur API sudah menolak `403 MODULE_DISABLED` (`resolveModuleEnabled` di
  `authorizeInTransaction`) SEBELUM RBAC, tetapi ke-54 halaman admin yang memuat
  data hanya menggerbang lewat `context.permissions.has(permissionKey(...))`, dan
  `context.permissions` tidak pernah membuang key milik modul yang disabled. Akibat:
  men-disable modul membuat route-nya 403 tapi halaman admin-nya tetap merender
  baris data tenant. Perbaikan ditaruh **di dalam helper bersama** — `resolveSsrContext`
  (`src/lib/auth/ssr-session.ts`) kini membuang setiap permission key yang modulnya
  `awcms_mini_tenant_modules.enabled = false`, jadi ke-54 halaman ikut tergerbang
  tanpa menyentuh satu pun call site. `fetchGrantedPermissionKeys` yang dipakai jalur
  API **tidak** diubah (beberapa endpoint sengaja mengandalkannya untuk TIDAK
  memfilter modul disabled). Role tidak ikut difilter (identitas subject tetap;
  hanya kapabilitas modul yang disabled yang hilang dari SSR).

  **#835 §7 — `resolveSsrContext` 5 query serial → 2.** Lookup sesi tetap satu query
  (menghasilkan `identity_id`), lalu SATU query gabungan menyelesaikan tenant-user +
  `default_locale` + roles + permission (sudah tergerbang modul). `LEFT JOIN`
  mempertahankan role tanpa permission dan tenant tanpa baris `tenants`, persis
  perilaku query terpisah sebelumnya. Query `roles` TIDAK digabung ke query
  permission (menggabungnya akan menghilangkan role tanpa permission).

  **#835 §1 — `resolveMediaReferences` batch nyata.** Signature sudah batch-shaped
  tapi implementasinya query per-id; kini satu `id = ANY(...)` untuk seluruh batch
  (`fetchNewsMediaObjectsByIds`), tanpa mengubah satu pun caller.

  **#835 §2 — `contribution-sync` bulk read + diff translasi.** Kode yang sudah ada
  dibaca sekali (`code = ANY(...)`) alih-alih satu SELECT per code, dan translasi
  di-rekonsiliasi lewat DIFF (tulis hanya perubahan nyata; hapus locale yang tak
  lagi dideklarasikan) menggantikan delete-all-lalu-reinsert yang menulis ulang
  setiap baris tiap sync. Keputusan konflik per-code (baris manual tidak pernah
  ditimpa, dilaporkan sebagai conflict) dipertahankan utuh.

  **#835 §6 — job `scheduled-publish` tidak lagi mengunci semua baris.** Query
  pemilihan due-post kini `ORDER BY scheduled_at ASC LIMIT n FOR UPDATE SKIP LOCKED`
  (bukan `FOR UPDATE` tanpa LIMIT atas semua baris yang match), sehingga runner
  paralel mengambil batch disjoint alih-alih memblokir, dan backlog besar dibatasi
  per run (`result.partial`, sisa diproses run berikutnya — job periodik & idempoten).

- ca15e33: Perbaiki test base-registry domain-event yang membaca array yang salah.

  `registerDomainEventConsumer` mengappend ke `DOMAIN_EVENT_CONSUMERS` — itu live
  binding dan memang desainnya (#826). Test "the runtime's own **base** registry
  contains no consumer owned by another module" justru mengiterasi binding
  ter-merge itu, sehingga ia lolos sendirian namun gagal begitu file test lain
  mengimpor file registrasi sebuah modul secara transitif. Invariant-nya tidak
  pernah rusak; test-nya yang membaca array keliru.

  `BASE_DOMAIN_EVENT_CONSUMERS` kini di-export dan diassert langsung, jadi
  pemeriksaannya independen terhadap urutan file. Ditambah test isolasi yang
  membuktikan registrasi plugin terlihat di binding ter-merge tapi **tidak pernah**
  menyentuh array base — tanpa itu, assertion pertama bisa lolos semata karena
  belum ada yang mendaftar, yang persis cara versi lamanya menyembunyikan cacatnya
  sendiri.

## 0.24.0

### Minor Changes

- 924e0a6: Publish a generated, versioned API and event reference document (Issue
  #700, epic #679 platform-hardening) — `docs/awcms-mini/api-reference.md`,
  built by a new `bun run api:docs:generate` (`scripts/api-docs-generate.ts`)
  from the CANONICAL bundled contracts
  (`openapi/awcms-mini-public-api.openapi.yaml`, produced by
  `bun run openapi:bundle`, Issue #695, and
  `asyncapi/awcms-mini-domain-events.asyncapi.yaml`) — never from the OpenAPI
  source fragments directly.

  The generated doc covers: authentication model, tenant context, keyset
  pagination, idempotency, correlation/request IDs, the standard success/
  error envelope and error codes, request body size limits, a conditional
  feature-gates section (derived by scanning the contract for tenant-mode
  gated behavior), every REST operation grouped by module with parameters/
  request/response schemas, a schema appendix with synthetic example
  payloads, every AsyncAPI domain event channel, and a compatibility/
  deprecation policy section (ADR-0008) that auto-lists any
  `deprecated: true` operation/schema/channel.

  All example values are synthesized from JSON Schema shape alone (nil UUID,
  fixed placeholder dates, `example.com` hostnames only) — never copied from
  real config/logs/fixtures, so no secret or production hostname can enter
  the document. Generation is fully deterministic and offline (no network
  access, no external CLI, no SaaS).

  A new read-only `bun run api:docs:check` (`scripts/api-docs-check.ts`),
  wired into `bun run check`, regenerates the doc in memory and fails the
  build if the committed file is stale relative to the bundled contracts —
  the same `checkBundleFreshness` pattern the OpenAPI bundle itself uses.

  The generated Markdown file requires no server or internet connection to
  read — open it with any text editor, `less`, or a local Markdown
  previewer, satisfying offline/LAN operator access.

- 1b8fc78: Add Google OIDC login for full-online deployments (Issue #590, epic
  #587-#593) — the third concrete feature built on top of the #587
  full-online security gate, following the same pattern as Cloudflare
  Turnstile (#588) and MFA/TOTP (#589).

  New tables (migration 035, tenant-scoped, RLS `ENABLE`+`FORCE`):
  `awcms_mini_identity_provider_accounts` (links an identity to a Google
  account by its stable `sub`, never by email), `awcms_mini_oidc_auth_requests`
  (the ephemeral state/nonce bridge across the OAuth redirect round-trip).
  `isGoogleLoginRequired(env)` combines the shared `isFullOnlineSecurityActive(env)`
  gate (#587) with a new `AUTH_GOOGLE_LOGIN_ENABLED` flag.

  New endpoints: `GET /api/v1/auth/providers/google/start` (unauthenticated,
  redirects to Google; reached from a new conditional "Continue with Google"
  button on `/login`), `GET .../callback` (Google's redirect target —
  validates `state`/nonce (CSRF/replay defense) and cryptographically
  verifies the ID token's RS256 signature, issuer, audience, expiry, and
  nonce before trusting any claim; creates the existing AWCMS-Mini session
  type, or — if Issue #589's MFA gate is active for the identity — returns
  `401 MFA_REQUIRED` exactly like `POST /auth/login`, so Google login never
  bypasses MFA), `POST .../link` (authenticated; starts a link-purpose OAuth
  request for the caller's own identity and returns the authorization URL as
  JSON), `POST .../unlink` (authenticated, high-risk, audited).

  The RS256 signature verification is implemented via the platform's own
  WebCrypto (`crypto.subtle`) rather than a JWT library dependency. Google's
  token exchange and JWKS fetch are timeout-bounded and circuit-breaker
  gated, with the breaker only tripping on genuine transport failures
  (5xx/network/timeout) — a well-formed `400 invalid_grant` for a bad/reused
  authorization code is Google correctly rejecting attacker-controlled
  input, not an outage, and must never trip the breaker (the same class of
  bug found and fixed in Turnstile's PR #596). The OAuth state/nonce
  exchange is single-use and race-safe (`SELECT ... FOR UPDATE` plus
  compare-and-swap, the same fix PR #597 applied to MFA challenges).

  Security review of this PR also found that `GET .../start` inserted a
  row keyed by an unauthenticated, caller-supplied `tenantId` before
  verifying the tenant existed — a nonexistent tenant tripped a
  foreign-key violation that `withTenant`'s catch-all recorded against the
  single, application-wide database circuit breaker (shared by every
  tenant and every endpoint, not just this feature), letting an
  unauthenticated caller take down the entire deployment for 30 seconds at
  a time, repeatedly, with a handful of garbage tenant ids. Fixed by
  checking tenant existence/status via a plain `SELECT` (which never
  throws for a missing row) before ever attempting the insert, plus adding
  source-scoped rate limiting to `start.ts` matching `login.ts`.

  Account linking is by Google's `sub` only. Auto-linking a Google login to
  an existing identity by email is fail-closed: it requires both a verified
  email and the email's domain to be explicitly listed in the new
  `AUTH_GOOGLE_ALLOWED_DOMAINS` env var (default unset — auto-linking never
  happens by default). Without an existing link or an eligible auto-link,
  login is rejected (`GOOGLE_ACCOUNT_NOT_LINKED`), never silently
  provisioning a new account.

  New env vars: `AUTH_GOOGLE_LOGIN_ENABLED` (default `false`),
  `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET`,
  `AUTH_GOOGLE_ALLOWED_DOMAINS` (default unset), `AUTH_GOOGLE_REDIRECT_PATH`
  (default `/api/v1/auth/providers/google/callback`). `AUTH_GOOGLE_LOGIN_ENABLED=true`
  alone (independent of the #587 gate) requires a client id and secret in
  `bun run config:validate` and `security-readiness`.

  New error codes `GOOGLE_LOGIN_DISABLED`/`GOOGLE_OAUTH_STATE_INVALID`/
  `GOOGLE_TOKEN_EXCHANGE_FAILED`/`GOOGLE_ID_TOKEN_INVALID`/
  `GOOGLE_ACCOUNT_NOT_LINKED`/`GOOGLE_ALREADY_LINKED`/`GOOGLE_NOT_LINKED`/
  `GOOGLE_MISCONFIGURED` with i18n strings (`en`/`id`). OpenAPI spec updated
  for all 4 new endpoints.

  Docs updated: `.env.example`, `docs/awcms-mini/18_configuration_env_reference.md`,
  `docs/awcms-mini/deployment-profiles.md`, `src/modules/identity-access/README.md`,
  skill `awcms-mini-auth-online-hardening`.

- e77f120: Add MFA/TOTP login challenge for full-online deployments (Issue #589,
  epic #587-#593) — the second concrete feature built on top of the #587
  full-online security gate, following the same pattern as Cloudflare
  Turnstile (#588).

  New tables (migration 034, tenant-scoped, RLS `ENABLE`+`FORCE`):
  `awcms_mini_identity_mfa_factors`, `awcms_mini_identity_mfa_recovery_codes`,
  `awcms_mini_mfa_challenges`. `isMfaRequired(env)` combines the shared
  `isFullOnlineSecurityActive(env)` gate (#587) with a new `AUTH_MFA_ENABLED`
  flag — active only when both agree, and even then MFA is opt-in per
  identity, not mandatory tenant-wide.

  `POST /api/v1/auth/login`: a password-valid login for an identity with an
  active TOTP factor no longer creates a session — it issues an MFA
  challenge and returns `401 MFA_REQUIRED` with `mfaChallengeToken`. New
  `POST /api/v1/auth/mfa/totp/verify` (authenticated by possession of that
  token, not a session — mirrors `password/reset`'s pattern) completes the
  login and creates the real session. New self-service endpoints:
  `GET /auth/mfa/status`, `POST /auth/mfa/totp/enroll/start`,
  `POST /auth/mfa/totp/enroll/verify` (activates the factor, returns 10
  one-time recovery codes), `POST /auth/mfa/totp/disable`, and
  `POST /auth/mfa/recovery-codes/regenerate` (both high-risk, audited).

  TOTP is a from-scratch, dependency-free RFC 6238-compatible implementation
  (HMAC-SHA1, verified against the RFC's own Appendix B test vectors) —
  Google Authenticator and compatible apps work out of the box. TOTP secrets
  are encrypted at rest with AES-256-GCM (`AUTH_MFA_SECRET_ENCRYPTION_KEY`,
  base64 32-byte key) — the only reversibly-stored secret in this app, since
  verification must recompute the code from the original secret; recovery
  codes and challenge tokens remain hash-only like every other token in this
  codebase. Replay of an already-used TOTP time step is prevented via a
  per-factor `last_used_step` counter, and challenge/recovery-code/replay
  state transitions are all atomic (`SELECT ... FOR UPDATE` on the
  challenge row plus compare-and-swap `UPDATE`s) so concurrent verification
  attempts against the same challenge or code can't bypass the attempt cap
  or the replay guard — found and fixed during PR review, with regression
  tests proving the race. Password reset never disables MFA (verified by
  an explicit integration test).

  New env vars: `AUTH_MFA_ENABLED` (default `false`),
  `AUTH_MFA_SECRET_ENCRYPTION_KEY`, `AUTH_MFA_TOTP_ISSUER` (default
  `AWCMS-Mini`), `AUTH_MFA_TOTP_PERIOD_SEC` (default `30`),
  `AUTH_MFA_TOTP_DIGITS` (default `6`), `AUTH_MFA_CHALLENGE_TTL_SEC` (default
  `300`), `AUTH_MFA_RATE_LIMIT_MAX`/`_WINDOW_SEC` (defaults `5`/`300`).
  `AUTH_MFA_ENABLED=true` alone (independent of the #587 gate) requires a
  valid 32-byte base64 encryption key in `bun run config:validate` and
  `security-readiness`.

  New error codes `MFA_REQUIRED`/`MFA_DISABLED`/`MFA_ALREADY_ACTIVE`/
  `MFA_NOT_ACTIVE`/`MFA_ENROLLMENT_NOT_FOUND`/`MFA_INVALID_CODE`/
  `MFA_CHALLENGE_INVALID`/`MFA_MISCONFIGURED` with i18n strings (`en`/`id`).
  OpenAPI spec updated for `POST /auth/login`'s new 401 branch and all 6 new
  endpoints.

  Docs updated: `.env.example`, `docs/awcms-mini/18_configuration_env_reference.md`,
  `docs/awcms-mini/deployment-profiles.md`, `src/modules/identity-access/README.md`,
  skill `awcms-mini-auth-online-hardening`.

- 0bb7b31: Add the full-online-only auth security feature gate (Issue #587), the
  foundational config gate for the new full-online auth hardening epic
  (#587-#593): Cloudflare Turnstile (#588), MFA/TOTP (#589), Google OIDC
  login (#590), generic tenant OIDC SSO (#591), and an admin policy UI
  (#592) will all depend on this gate before doing anything online/
  provider-related — none of them exist yet in this repo, only the shared
  gate itself.

  Two new env vars, both optional/backward-compatible:
  `AUTH_ONLINE_SECURITY_ENABLED` (default `false`) and
  `AUTH_ONLINE_SECURITY_PROFILE` (default `disabled`, only other valid
  value `full_online`). Left unset — the default for every local/offline/
  LAN deployment — nothing changes and no provider credential is ever
  required. Setting `AUTH_ONLINE_SECURITY_ENABLED=true` requires
  `AUTH_ONLINE_SECURITY_PROFILE=full_online`; any other combination fails
  `bun run config:validate`.

  New `src/lib/auth/online-security-config.ts`: `isOnlineSecurityEnabled`,
  `resolveOnlineSecurityProfile`, and `isFullOnlineSecurityActive` — the
  one function every future full-online-only feature should call rather
  than re-deriving the "both vars must agree" rule itself. Also adds
  `checkOnlineAuthSecurityConfig` to `scripts/validate-env.ts` and
  `checkOnlineAuthSecurityReady` to `scripts/security-readiness.ts`
  (critical severity, but `status: pass` when the gate is simply
  disabled — informational, not a failure, per the issue's own
  acceptance criteria).

  Docs updated: `.env.example`, `docs/awcms-mini/18_configuration_env_reference.md`,
  `docs/awcms-mini/deployment-profiles.md`, `src/modules/identity-access/README.md`.

- 8514fa1: Add admin UI for full-online auth security policy (Issue #592, epic
  #587-#593) — a new `/admin/security` page that surfaces and edits what
  #587-#591 already built, without re-implementing any of their
  enforcement. Consumes the existing admin CRUD API from #591
  (`GET/PATCH /api/v1/identity/sso/policy`,
  `GET/POST/PATCH/DELETE /api/v1/identity/sso/providers[/{id}]`) — no new
  API endpoints were needed for this issue.

  The page has two independent, server-side-enforced gates:

  1. **Deployment gate** (`isFullOnlineSecurityActive(env)`, #587) — on
     every local/offline/LAN deployment (the default), the page renders
     ONLY an informational notice ("Full-online auth hardening is disabled
     for this deployment profile") and nothing else: no status summary, no
     policy form, no provider list/forms. This is checked in the page's own
     SSR frontmatter before any of that markup is even generated, not
     hidden with CSS.
  2. **ABAC permission** (`identity_access.sso_policy.*`/`sso_providers.*`,
     migration 037, already seeded by #591) — when the gate is active but
     the caller holds neither permission, the page renders an
     access-denied notice instead of crashing or exposing a broken form.

  When both are satisfied, the page shows: the shared gate's status plus
  Turnstile/MFA/Google-login/SSO enabled+configured flags (new
  `src/lib/auth/auth-security-status.ts`, a pure env-only aggregator — no
  provider credential value is ever exposed, only `configured: true/false`
  booleans built from each feature's own `*_REQUIRED_WHEN_ENABLED` env var
  list); an editable tenant authentication policy form (password login
  enabled, SSO enabled/required, auto-link-by-verified-email, allowed email
  domains, break-glass local owners); and a tenant SSO provider
  list/create/edit/soft-delete UI. Client secret fields are write-only —
  never pre-filled or round-tripped from the API on edit.

  Break-glass UX: the form always shows the break-glass requirement inline
  next to `sso_required`/"disable password login", blocks an
  obviously-doomed submit client-side (no break-glass identity selected at
  all), and surfaces the server's authoritative `409 BREAK_GLASS_REQUIRED`
  rejection through the same translated error-message banner every other
  mutation on the page uses — the eligibility check itself is never
  re-implemented client-side, only the server's own decision (#591's
  `saveTenantAuthPolicy`) is trusted.

  `StateNotice.astro` gains a third `kind="info"` variant (`role="status"`,
  distinct from the existing `"denied"`/`"error"` kinds) for this
  deployment-profile-disabled state — a neutral fact, not a permission
  problem or a failure. `identity_access`'s module descriptor now declares
  an admin navigation entry (`/admin/security`, gated on
  `identity_access.sso_policy.read`) so the page appears in the admin
  sidebar via the existing module-navigation registry, no `AdminLayout.astro`
  changes needed.

  New tests: `tests/unit/auth-security-status.test.ts` (the status
  aggregator); `tests/integration/admin-security-ui.integration.test.ts`
  (PATCH policy requires `sso_policy.update`, ABAC default-deny; a
  successful policy update and provider create/delete each write their own
  audit event; a break-glass-rejected policy update writes no audit event);
  `tests/e2e/admin-security-disabled.e2e.ts` and
  `tests/e2e/admin-security-enabled.e2e.ts` (Playwright — the two rendering
  states, gate off vs gate on, seeded via a direct-SQL owner/tenant fixture
  since `POST /setup/initialize` is a once-only singleton lock).

  i18n: new `admin.layout.nav_security` and `admin.security.*` strings
  (`en`/`id`) — no new error codes were needed, every code this page's
  mutations can return (`BREAK_GLASS_REQUIRED`, `SSO_PROVIDER_KEY_CONFLICT`,
  `SSO_MISCONFIGURED`, etc.) already had catalog entries from #591.

  Docs updated: `src/modules/identity-access/README.md`, skill
  `awcms-mini-auth-online-hardening`.

- 72ab131: Add generic tenant OIDC SSO provider for full-online deployments (Issue
  #591, epic #587-#593) — generalizes Issue #590's Google-specific login
  into a tenant-configurable OIDC provider model (Okta, Azure AD, Keycloak,
  etc.), without changing Google's own code/tables. `isSsoRequired(env)`
  combines the shared `isFullOnlineSecurityActive(env)` gate (#587) with a
  new `AUTH_SSO_ENABLED` flag, following the same pattern as Turnstile
  (#588), MFA/TOTP (#589), and Google login (#590).

  New tables (migration 036, tenant-scoped, RLS `ENABLE`+`FORCE`):
  `awcms_mini_auth_providers` (per-tenant OIDC provider config — issuer,
  client id, client secret encrypted at rest with a dedicated
  `AUTH_SSO_CREDENTIAL_ENCRYPTION_KEY` or referenced by environment
  variable name, exactly one via a CHECK constraint, never returned
  plaintext by any endpoint; scopes; allowed email domains; enabled flag;
  soft delete) and `awcms_mini_tenant_auth_policies` (one row per tenant —
  `password_login_enabled`, `sso_enabled`, `sso_required`,
  `auto_link_verified_email`, allowed email domains, break-glass identity
  ids, and `mfa_required` reserved for future #589 compatibility). The
  existing `awcms_mini_identity_provider_accounts`/
  `awcms_mini_oidc_auth_requests` tables (migration 035) are reused as-is
  for the generic flow — they were already designed provider-agnostic
  specifically for this.

  New endpoints: `GET /api/v1/auth/sso/{providerKey}/start|callback`,
  `POST /api/v1/auth/sso/{providerKey}/link|unlink` (same shape as Google's
  own endpoints — unauthenticated tenant existence is `SELECT`ed before any
  INSERT, applying PR #598's lesson from day one). Also new — admin CRUD,
  in scope for this issue unlike #590: `/api/v1/identity/sso/providers`
  (`/{id}`) and `/api/v1/identity/sso/policy`, protected by ABAC
  (`identity_access.sso_providers.*`/`sso_policy.*`, migration 037), never
  gated by the runtime SSO flag itself (credentials can be provisioned
  ahead of time, same allowance Turnstile/Google's own config checks
  grant).

  Unlike Google (hardcoded OAuth endpoints), a tenant-configured provider's
  `.well-known/openid-configuration` and JWKS are discovered per provider,
  cached, and bounded by `AUTH_SSO_DISCOVERY_TIMEOUT_MS` — circuit breakers
  are keyed per provider (`sso-oidc-discovery:<key>`/`sso-oidc-jwks:<key>`/
  `sso-oidc-token:<key>`) so one tenant's unhealthy provider never affects
  another tenant or provider, and only trip on genuine transport failures
  (5xx/network/timeout), never a well-formed 4xx from the provider
  correctly rejecting a bad/reused authorization code.

  Break-glass enforcement is the headline security behavior: a tenant
  policy that would set `sso_required=true` or `password_login_enabled=false`
  is rejected (`409 BREAK_GLASS_REQUIRED`) unless at least one configured
  break-glass identity currently resolves to an `active` identity with an
  `active` tenant membership — checked at the point the policy is SAVED
  (against a fresh DB read), not merely at login time, so a provider outage
  can never lock an operator out of their own tenant. `login.ts` enforces
  `password_login_enabled=false` only when `isSsoRequired(env)` is active;
  every deployment that never enables this feature runs zero extra queries
  and has zero behavior change.

  Auto-linking by email is fail-closed on two independent layers: the
  provider's own allowed-domain list (mirrors Google's
  `AUTH_GOOGLE_ALLOWED_DOMAINS`, per tenant/provider) AND the tenant
  policy's `auto_link_verified_email` master switch, which defaults to
  `false`.

  New env vars: `AUTH_SSO_ENABLED` (default `false`),
  `AUTH_SSO_CREDENTIAL_ENCRYPTION_KEY` (base64, 32-byte AES-256 key,
  required and validated when enabled — a separate key from MFA's own),
  `AUTH_SSO_DISCOVERY_TIMEOUT_MS` (default `5000`).

  New error codes `SSO_DISABLED`/`SSO_PROVIDER_NOT_FOUND`/
  `SSO_PROVIDER_DISABLED`/`SSO_PROVIDER_UNAVAILABLE`/
  `SSO_OAUTH_STATE_INVALID`/`SSO_TOKEN_EXCHANGE_FAILED`/
  `SSO_ID_TOKEN_INVALID`/`SSO_ACCOUNT_NOT_LINKED`/`SSO_ALREADY_LINKED`/
  `SSO_NOT_LINKED`/`SSO_MISCONFIGURED`/`SSO_PROVIDER_KEY_CONFLICT`/
  `BREAK_GLASS_REQUIRED`/`PASSWORD_LOGIN_DISABLED` with i18n strings
  (`en`/`id`). OpenAPI spec updated for all 11 new endpoints and their
  schemas.

  Docs updated: `.env.example`, `docs/awcms-mini/18_configuration_env_reference.md`,
  `docs/awcms-mini/deployment-profiles.md`, `src/modules/identity-access/README.md`,
  skill `awcms-mini-auth-online-hardening`.

- 04f2fa4: Add Cloudflare Turnstile bot protection for full-online public auth forms
  (Issue #588, epic #587-#593) — the first concrete feature built on top of
  the #587 full-online security gate.

  New `src/lib/security/turnstile.ts`: `isTurnstileRequired(env)` combines
  the shared `isFullOnlineSecurityActive(env)` gate (#587) with a new
  `TURNSTILE_ENABLED` flag — active only when both agree. Every local/
  offline/LAN deployment (the default) is completely unaffected. The one
  enforcement entrypoint, `enforceTurnstileIfRequired(turnstileToken,
remoteIp, env)`, is now called from `POST /api/v1/auth/login`,
  `/auth/password/forgot`, `/auth/password/reset`, and
  `/setup/initialize`, right after body validation but before any DB
  query or password hashing. Verification is server-side against
  Cloudflare's siteverify endpoint, timeout-bounded and circuit-breaker
  gated (same pattern as `cloudflare-dns-adapter.ts`/
  `mailketing-provider.ts`), and fails closed: misconfiguration is treated
  as an invalid token, not skipped. The circuit breaker only trips on
  genuine provider-transport failures (HTTP 5xx, network error, timeout)
  — a well-formed "token rejected" response never trips it, so an
  unauthenticated caller can't lock out login/password-reset/setup for
  every tenant by submitting a handful of invalid tokens (found and fixed
  during PR review).

  New env vars: `TURNSTILE_ENABLED` (default `false`), `TURNSTILE_SITE_KEY`,
  `TURNSTILE_SECRET_KEY`, `TURNSTILE_VERIFY_TIMEOUT_MS` (default `5000`).
  `TURNSTILE_ENABLED=true` alone (independent of the #587 gate) requires
  both keys in `bun run config:validate` and `security-readiness`.

  The login page (`src/pages/login.astro`) conditionally renders the
  Turnstile widget only when `isTurnstileRequired()` is true. Astro's CSP
  (`astro.config.mjs`) now unconditionally allows
  `https://challenges.cloudflare.com` in `script-src`/`frame-src` (CSP is
  build-time only, while `TURNSTILE_ENABLED` is meant to be runtime-
  toggleable) — the widget itself remains runtime-gated.

  New error codes `TURNSTILE_REQUIRED`/`TURNSTILE_INVALID` with i18n
  strings (`en`/`id`). OpenAPI spec updated for all 4 affected endpoints.

  Docs updated: `.env.example`, `docs/awcms-mini/18_configuration_env_reference.md`,
  `docs/awcms-mini/deployment-profiles.md`, `src/modules/identity-access/README.md`,
  skill `awcms-mini-auth-online-hardening`.

- e0f5fda: Add encrypted backup, checksum-before-restore, off-site copy, and a
  scheduled restore drill (Issue #691, epic #679 platform-hardening).

  `deploy/backup/backup-postgres.sh` now streams `pg_dump` directly into
  `openssl enc -aes-256-cbc -pbkdf2` — the plaintext dump never touches disk
  — and writes a signed manifest (filename, size, sha256, an HMAC-SHA256
  over those fields, timestamp) using the same `HMAC(secret,
"<timestamp>.<body>")` construction as skill `awcms-mini-sync-hmac`. Both
  the encryption key and the (separate) HMAC key are required from a FILE
  (`BACKUP_ENCRYPTION_KEY_FILE`/`BACKUP_HMAC_KEY_FILE`), never a CLI
  argument or an env var holding the key content.

  `deploy/backup/restore-postgres.sh` now verifies, in order, before any
  mutation: the manifest's own HMAC (rejects a tampered/missing manifest),
  the dump file's actual sha256/size against the manifest (rejects a
  tampered/incomplete dump), then decrypts to a private `mktemp` file
  (removed on exit) and runs `pg_restore --list` to validate archive
  structure. `DATABASE_URL` is parsed into `PGHOST`/`PGPORT`/`PGUSER`/
  `PGPASSWORD`/`PGDATABASE` and never passed as a positional argument to
  `pg_dump`/`pg_restore`/`psql`, so it never appears in `ps`/
  `/proc/<pid>/cmdline`. `--target` now validates the database identifier
  (rejects quote/semicolon/whitespace injection) and, in override mode,
  requires `--acknowledge-target=<dbname>` matching `--target` exactly
  (mirroring `scripts/production-preflight.ts`'s `--acknowledge-target`). A
  shared `flock` lock in `BACKUP_DIR` stops concurrent backup/restore jobs.

  New `deploy/backup/offsite-copy.sh` — a generic, provider-agnostic 3-2-1
  off-site copy hook (`OFFSITE_COPY_COMMAND`, no-op if unset, so offline/LAN
  deployments stay fully local). New `deploy/backup/restore-drill.sh` — runs
  backup → restore into a disposable database → verifies the schema
  migrations ledger, tenant isolation (RLS, via the real `awcms_mini_app`
  role when available), and a sample record → writes a timestamped JSON
  report with RTO (drill duration) and RPO (backup age) proxies.

  `deploy/backup/README.md` documents all of the above plus key rotation,
  the lost-key failure mode (no backdoor — losing a key makes backups
  encrypted/signed with it permanently unrecoverable/unverifiable), and
  PITR prerequisites (WAL archiving) as an out-of-scope next step.
  `docs/awcms-mini/production-preflight-runbook.md`,
  `production-readiness.md`, `deployment-profiles.md`, and skill
  `awcms-mini-production-preflight` updated to the new command shapes.

- dba8b10: Add the full admin UI, blog settings API, and final hardening for the
  `blog_content` module (Issue #543, epic #536 — closing the epic). New
  screens under `/admin/blog` (dashboard, posts list/editor with lifecycle
  actions and revision history, pages list/editor, categories, tags,
  settings, and optional templates/widgets/menus/ads managers), all Astro +
  vanilla JS reusing the existing `AdminLayout`/design tokens, with loading/
  empty/error/ready states, double-submit prevention, and confirm-then-
  `Idempotency-Key` on every high-risk action. New `GET`/`PATCH
/api/v1/blog/settings` endpoint activates `awcms_mini_blog_settings`
  (schema present since migration 026, unwired until now), publishing
  `blog-content.settings.updated` — the module's AsyncAPI contract's last
  producer-less channel. RSS feed and sitemap now respect the new
  `rssEnabled`/`sitemapEnabled` settings (404 when disabled, indistinguishable
  from an unknown tenant). `module.ts` now declares its full `permissions`
  (36 entries, matching migrations 027/030) and `navigation` (`/admin/blog`)
  arrays, previously empty despite the permissions already existing in the
  database. No schema changes.
- dcba37e: Add the `blog_content` module foundation (Issue #537, epic #536) — the
  first domain module registered directly in this base repo (see
  `docs/adr/0009-public-tenant-scoped-routes.md`). Adds `src/modules/blog-content`
  (module descriptor, domain validation for content/slug/status/SEO/taxonomy
  rules, read-only application query placeholders) and the core schema
  (migrations `026`/`027`): tenant-scoped, RLS-`FORCE`d tables for posts,
  pages, categories/tags, post-term relations, append-only revisions,
  redirects, and per-tenant settings, plus the 26-entry `blog_content.*`
  permission seed. No admin/public API, OpenAPI/AsyncAPI, or UI yet —
  those land in Issues #538-#543.
- 4da379a: Add automatic internal tag linking for `blog_content` post/news content
  (Issue #641, epic `news_portal`): matching tag names inside a published
  post's rendered body are linked to the tag's canonical archive URL, as a
  pure render-time transform of the already-safe renderer output — the
  stored `content_json`/`content_text` are never mutated.

  The renderer walks the real HTML element tree via Bun's built-in
  `HTMLRewriter` (no new dependency) rather than regexing over a raw HTML
  string — links are never inserted inside an existing anchor, script,
  style, code/pre block, figure caption, embed element (`iframe`/`object`/
  `embed`/`video`/`audio`), or (configurably) heading. Matching supports
  exact and case-insensitive modes with Unicode-aware word boundaries (a
  tag name is never matched as a substring of a larger word sharing the
  same root, e.g. Indonesian "makan" inside "memakan"/"makanan"), longest-
  match-first ordering when one tag name is a prefix of another, and two
  independent caps (`maxPerTag`/`linkFirstOccurrenceOnly` and
  `maxPerPost`).

  Six deployment-wide `BLOG_AUTO_INTERNAL_TAG_LINKS_*` env vars (enabled
  kill switch, max links per post/tag, minimum term length, first-
  occurrence-only, exclude-headings) act as a ceiling; a new dedicated
  per-tenant table (`awcms_mini_blog_internal_tag_link_settings`, its own
  `GET`/`PATCH /api/v1/blog/internal-tag-links/settings` endpoint and
  `blog_content.internal_links.{read,configure}` permissions — deliberately
  NOT folded into `awcms_mini_blog_settings`, see that migration's header)
  lets a tenant disable the feature entirely, enable case-insensitive
  matching, and disable specific tags. A new
  `auto_internal_tag_links_disabled` column on `awcms_mini_blog_posts`
  supports a manual per-post opt-out. A new read-only preview endpoint,
  `GET /api/v1/blog/posts/{id}/internal-links/preview`
  (`blog_content.internal_links.preview`), shows which terms would be
  linked before publishing, reusing the exact same resolution/rendering
  path the public routes use.

  Wired into both public post-detail routes (`/news/{slug}` and
  `/blog/{tenantCode}/{slug}`) — tag candidates are always queried
  tenant-scoped, so a tag can never be linked across tenants. Config
  changes are audit-logged.

- f664063: Require verified Cloudflare R2 media object references for `blog_content`
  news images when full-online R2-only news portal mode is active for the
  tenant (Issue #636, epic `news_portal`).

  `featuredMediaId` and image gallery block items (`content_json`) now
  must reference an existing, same-tenant, `verified`/`attached` media
  object (Issue #633's registry) instead of a raw URL, whenever a tenant
  has both the deployment env configured for the `news_portal_full_online_r2`
  preset AND has genuinely applied that preset itself — tracked via a
  new, dedicated, non-tenant-writable table
  (`awcms_mini_news_portal_tenant_state`, migration `043`) rather than any
  existing shared module-enabled/module-settings mechanism, both of which
  turned out to be unsuitable (one is opt-out-by-default and can't
  distinguish "applied" from "never touched"; the other is directly
  writable by any tenant Owner/Admin through a generic, unrelated
  permission, which would let a tenant silently disable this validation
  for itself). A non-conforming reference is rejected with
  `422 NEWS_MEDIA_REFERENCE_INVALID` at post/page create and update, and
  at revision restore, before anything is written. Cross-tenant
  references, and references to unverified/failed/orphaned/deleted
  objects, are always rejected in this mode. Video gallery items and all
  behavior outside full-online R2-only mode are unaffected.

  The public post detail routes (`/news/{slug}`, `/blog/{tenantCode}/{slug}`)
  now render gallery images and `og:image`/`twitter:image` meta tags from
  resolved, verified R2 media metadata — an unresolved or unsafe reference
  is silently omitted, never rendered.

- a9e7eb3: Add pages, taxonomies, post-term relations, and PostgreSQL full-text
  search to the `blog_content` module (Issue #539, epic #536): tenant-scoped
  page CRUD (`/api/v1/blog/pages`), category/tag CRUD with parent-child
  hierarchy and tag-rejects-parent enforcement (`/api/v1/blog/terms`),
  post-term assignment via `termIds` on the existing blog post API, and
  admin full-text search (`/api/v1/blog/search`, keyset-paginated) across
  posts and pages. `search_vector` on posts/pages is now a
  `GENERATED ALWAYS ... STORED` column (migration 028) instead of an unused
  plain column. Pages reuse the same author-own-unpublished-content ABAC
  override posts introduced in Issue #538, now factored into a shared
  `evaluateContentUpdateAccess`. A public-safe search helper is included for
  Issue #540's public routes to consume — no public route yet in this
  issue.
- 35ce82c: Add the blog post admin API (Issue #538, epic #536): tenant-scoped CRUD
  plus lifecycle actions (submit-review, publish, schedule, archive,
  restore, purge) at `/api/v1/blog/posts`, built on the `blog_content`
  schema/permission foundation from Issue #537. Enforces RBAC/ABAC
  (including an author-may-edit-their-own-unpublished-draft override),
  rejects unsafe HTML/script content, requires `Idempotency-Key` on
  publish/schedule/archive/restore/purge, and writes an audit event for
  every state change. Extends `identity-access`'s `AccessAction` union with
  `publish`/`schedule`/`archive`. OpenAPI updated with the new "Blog Posts"
  paths/schemas.
- 4734c33: Add presentation and monetization extensions to the `blog_content` module
  (Issue #542, epic #536): tenant-scoped admin CRUD for templates
  (whitelisted layout config), hierarchical navigation menus, position-based
  widgets, and advertisements with placement targeting and scheduling
  (`/api/v1/blog/{templates,menus,widgets,ads}`), a per-tenant blog theme
  mode override (`/api/v1/blog/theme`, falling back to the tenant's base
  theme), an optional `translation_group_id` linking locale-variants of a
  post, and a new whitelisted `gallery` `content_json` block type for public
  image/video display. Per the issue's own scope control, none of this
  rebuilds the base media library, tenant system, RBAC/ABAC, audit, or theme
  engine.
- 8881736: Add tenant-scoped `blog_content` settings for public route behavior
  (Issue #564, epic #555): `module.ts`'s descriptor now declares
  `settings.defaults` (`publicRouteMode: "domain_default"`,
  `publicBasePath: "/news"`, `legacyTenantRouteEnabled: true`,
  `publicLabel: "News"`), read/written through Module Management's existing
  generic tenant-settings framework (`GET`/`PATCH
/api/v1/tenant/modules/blog_content/settings`, Issue #516/epic #510) — no
  new endpoint, no new table.

  Deliberately does **not** add `rssEnabled`/`sitemapEnabled` to this new
  store, even though the issue's own example JSON lists them alongside the
  four new keys: those two flags already work end to end via
  `awcms_mini_blog_settings` (Issue #537/#543) and stay there — duplicating
  them into a second, independently-writable store would create two
  disconnected sources of truth for the same concept. A new merge helper,
  `application/public-route-settings.ts`'s `fetchEffectivePublicRouteSettings`,
  reads from both stores for route-handler convenience without owning
  either.

  Behavior added:

  - `/news` route handlers (all seven) now read
    `publicRouteMode`/`publicBasePath`/`publicLabel` from effective settings.
    `publicRouteMode=disabled` collapses every `/news` route to the same
    generic 404 an unresolved tenant already produces (timing-parity
    preserved — `withNewsTenant`'s module-disabled gate and
    `padUnresolvedTenantLatency` now share one `checkBlogContentAndRouteGate`
    function so they can't drift). `publicBasePath` (falling back to the
    `PUBLIC_CANONICAL_BASE_PATH` env var, Issue #556, previously validated
    but unconsumed) now drives self-referential link generation (canonical
    URL, RSS/sitemap links, cross-links) — it does not retarget which Astro
    file route physically serves the request, a documented, deliberate
    limitation (see README §Public route settings).
  - All seven `/blog/{tenantCode}` legacy routes now respect
    `legacyTenantRouteEnabled`; `false` 404s all of them (disable, not
    redirect — documented choice), consistently. Default `true` keeps
    today's behavior unchanged.

  New test: `tests/integration/blog-content-settings.integration.test.ts`
  (14 tests, including a regression test proving `publicLabel`/
  `publicBasePath` — free-form, tenant-admin-writable strings — are
  HTML/XML-escaped everywhere they're rendered into `/news` output, no
  stored-injection). Post-review addition: a fourth round-trip-parity test
  in `blog-content-public-news.integration.test.ts` explicitly compares
  `publicRouteMode=disabled`'s cost against the enabled path, closing a
  gap the security audit flagged (parity held structurally already, now
  also asserted directly rather than only inferred).

- 8fa98c8: Add public (anonymous, no session) blog routes to the `blog_content`
  module (Issue #540, epic #536): blog index, post detail, category/tag
  archives, search, RSS feed, and sitemap, all under
  `/blog/{tenantCode}/...` per ADR-0009's tenant-resolution pattern. Every
  route enforces the public visibility predicate (published, not deleted,
  `published_at` in the past) — listing surfaces additionally require
  `visibility = 'public'` while post detail also allows `unlisted` (direct
  link only, never listed). Post body content renders through a new
  whitelist block renderer (`content_json`'s first concretely defined
  schema: paragraph/heading/list/quote) that only ever emits escaped text,
  never raw HTML. SEO title/description/canonical URL render with documented
  fallbacks and re-validated URL safety. Errors never leak a stack trace —
  every route returns a fixed generic error page/XML on failure. Adds a
  reusable `resolvePublicTenantByCode` helper (`src/lib/tenant/`) and shared
  HTML/XML escaping and error-response helpers (`src/lib/html/`) for future
  public routes to reuse.
- 7a81aef: Add a content quality checklist for news portal publishing (Issue #640,
  epic `news_portal` #631-#642/#649): title/slug/excerpt/meta description
  presence, featured image existence + verified-R2 reference + alt text +
  dimensions + MIME/size metadata, `og:image` trust, rejection of local
  image paths and arbitrary external image URLs in news image blocks,
  gallery image verification, category/taxonomy presence, unsafe
  HTML/script/embed rejection, and scheduled-publish-time validity — 17
  rules across three severities (`blocking`/`warning`/`info`).

  Server-side enforcement, not just a client-side preview: `POST
/api/v1/blog/posts/{id}/publish` and `.../schedule` now run the
  checklist before the state transition and reject with `422
CONTENT_QUALITY_CHECKLIST_BLOCKED` when a blocking rule fails (audited
  via `blog.post.publish_blocked_by_checklist`/`schedule_blocked_by_checklist`).
  The scheduled-publish worker (`publishDueScheduledPosts`) was
  restructured from a single bulk `UPDATE` into a per-post loop so a due
  post that now fails the checklist is left `scheduled` (audited via
  `blog.post.scheduled_publish_blocked`) instead of silently publishing —
  closing the same class of bypass Issue #636's revision-restore fix
  closed for content_json/featuredMediaId writes. Two new read-only
  preview endpoints, `GET /api/v1/blog/posts/{id}/quality-checklist` and
  `GET /api/v1/blog/pages/{id}/quality-checklist`, back a new checklist
  panel in both admin editors.

  Five security rules (unsafe HTML, local image path, external image
  URL, unverified/cross-tenant featured image, unverified gallery image)
  can never be downgraded by tenant policy, in any environment. Seven
  non-security rules are tenant-configurable via a new
  `contentQualityChecklistPolicy` field on `PATCH /api/v1/blog/settings`
  (stored in the existing `awcms_mini_blog_settings.settings` column —
  no new migration).

  The entire checklist is a no-op (`applicable: false`) unless
  full-online R2-only news portal mode (Issue #632/#636) is active for
  the tenant — the vast majority of `blog_content`-only tenants see zero
  behavior change.

- 27118b9: Add revision history and scheduled publishing to the `blog_content` module
  (Issue #541, epic #536): append-only revisions for posts/pages (a
  significant title/contentJson/contentText change on `PATCH` snapshots
  one), revision list/detail/restore at
  `/api/v1/blog/posts/{id}/revisions` (restore requires explicit
  `blog_content.revisions.restore` permission and an `Idempotency-Key`, and
  itself appends a new revision rather than overwriting history), the
  `bun run blog:publish:scheduled` job (idempotent, publishes due
  `status='scheduled'` posts per tenant), and the full AsyncAPI
  domain-event contract for the module's post/term/revision lifecycle
  (documented-contract-only, same structured-logger-producer convention as
  every other module's events).
- c0f2487: Add reusable business-scope assignments and segregation-of-duties (SoD)
  policy hooks to `identity_access` (Issue #746, epic #738
  `platform-evolution` Wave 2, ADR-0013 §2/§4).

  - **Generic business-scope reference**: `awcms_mini_business_scope_assignments`
    (`sql/061`) grants a tenant user a role restricted to one
    `(scope_type, scope_id)` reference — never a foreign key to any
    optional module's table. Supports effective dates, temporary expiry,
    revocation, grantor/approver, and an append-only lifecycle history
    (`awcms_mini_business_scope_assignment_events`).
  - **`BusinessScopeHierarchyPort`** (`src/modules/_shared/ports/
business-scope-hierarchy-port.ts`) — capability port so a future
    optional organization module can resolve scope validity/ancestors/
    descendants without identity-access importing its tables. A default
    flat adapter (`identity-access/application/
business-scope-hierarchy-port-adapter.ts`) resolves `scopeType: "office"`
    against `awcms_mini_offices` today; every other scope type is
    `resolved: false` (safe default, never a crash).
  - **ABAC extension** (`domain/access-control.ts`) — additive optional
    `businessScopeFacts` parameter on `evaluateAccess` and
    `resourceAttributes.requiredScopeType`/`.requiredScopeId` convention on
    `AccessRequest`; every existing call site is unaffected. New
    `AccessAction` values `"revoke"` and `"override"`, both high-risk.
  - **Static SoD rule registry** (`ModuleDescriptor.sodRules`,
    `src/modules/_shared/module-contract.ts`, `MODULE_CONTRACT_VERSION`
    1.0.0 → 1.1.0) — mirrors `data_lifecycle`'s lifecycle-registry
    pattern exactly. `bun run identity-access:sod-registry:check` (wired
    into `bun run check` **and** `.github/workflows/ci.yml`'s `quality`
    job as an explicit step). Three real rule fixtures: two owned by
    `identity_access` itself (exception request/approve maker-checker;
    assignment create/revoke at the same scope) and one contributed by
    `data_lifecycle` (`legal_hold.create`/`.release`, its own pre-existing
    permission pair).
  - **Conflict enforcement wired at the real, shared chokepoint** —
    `access-guard.ts`'s `authorizeInTransaction` (used by the large
    majority of guarded endpoints, though a minority of pre-existing
    routes still call `evaluateAccess` directly and are not yet covered
    — see `high-risk-sod-guard.ts`'s header comment for the current
    scope) now runs SoD conflict evaluation for every high-risk decision
    on that path, reasoning over BOTH ordinary RBAC grants and active
    business-scope assignments. Proven against a real, unmodified
    endpoint (`POST /api/v1/data-lifecycle/legal-holds/{id}/release`) in
    `tests/integration/business-scope-sod-chokepoint.integration.test.ts`,
    not just a unit test of the pure conflict-detection function.
  - **Temporary exception/override flow**
    (`awcms_mini_sod_conflict_exceptions`, `sql/061`) — bounded lifetime
    (no indefinite override), self-approval denied (re-checked from DB),
    automatic expiry via the scheduled job below.
  - **Scheduled expiry job** — `bun run
identity-access:business-scope:expiry` (hourly recommended), built on
    the shared worker runner, least-privilege `awcms_mini_worker` grants
    (`sql/061`), registered in `work-class-registry.ts`.
  - **New API**: `GET`/`POST /api/v1/identity/business-scope/assignments`,
    `POST .../assignments/{id}/revoke`,
    `GET`/`POST /api/v1/identity/business-scope/exceptions`,
    `POST .../exceptions/{id}/{approve,reject,revoke}`,
    `GET /api/v1/identity/business-scope/conflicts` (keyset-paginated,
    safe projection). All mutations require `Idempotency-Key` and are
    audited.
  - **New admin UI** — `/admin/business-scope` (assignments, exceptions,
    conflict history), permission-gated per section.
  - **New metrics** — `business_scope_assignments_active`/`_temporary`,
    `business_scope_expirations_total`,
    `business_scope_cross_tenant_denied_total`,
    `sod_conflicts_detected_total`, `sod_exceptions_granted_total`.

  Migrations `sql/061_awcms_mini_business_scope_assignments_schema.sql`
  (four tenant-scoped, RLS FORCE'd tables) and
  `sql/062_awcms_mini_business_scope_permissions.sql` (nine permissions).
  Docs: `src/modules/identity-access/README.md`, updates to doc 04 (ERD),
  doc 17 (RBAC/ABAC seed), doc 20 (threat model).

- a67a63b: Replace direct `blog_content`/`news_portal` cross-module imports with
  capability ports (Issue #681, epic #679 platform-hardening).

  `blog_content` and `news_portal`'s `application`/`domain` code
  previously imported each other's implementation directly in both
  directions (`blog_content`'s R2-only media validation importing
  `news_portal`'s media registry; `news_portal`'s homepage section
  composer importing `blog_content`'s post/category queries and gallery
  renderer) — a genuine source-level cycle invisible to either module's
  `module.ts` `dependencies` array. Both directions now go through pure,
  neutral port interfaces (`src/modules/_shared/ports/news-media-port.ts`,
  `public-content-port.ts`), implemented by each module's own concrete
  adapter and injected by the caller — the route handler, already this
  repo's established composition-root layer. The shared gallery-block
  renderer (used by both modules) moved to
  `src/modules/_shared/rendering/gallery-block-renderer.ts`.

  `ModuleDescriptor` gains an optional `capabilities` field
  (`provides`/`consumes`) documenting this relationship, separate from
  `dependencies` (which still governs enable/disable lifecycle ordering
  only — unchanged by this issue). A new structural test,
  `tests/unit/module-boundary.test.ts`, fails CI if either module's
  `application`/`domain` tree ever imports the other's implementation
  directly again. See ADR-0011 for the full design rationale.

  No behavior change: all existing `blog_content`/`news_portal`
  integration tests pass unchanged, confirming this is a pure
  architectural refactor.

- 83de1bc: Run API spec, route parity, module graph, and i18n parity gates in CI (Issue #685, epic #679, platform-hardening).

  `.github/workflows/ci.yml`'s `quality` job previously ran only a SUBSET of `bun run check`'s own steps — `api:spec:check` and `modules:dag:check` were missing entirely, so a contract or module-graph regression could merge to `main` with CI green. Both are now explicit named steps, in the same order `bun run check` runs them.

  `scripts/api-spec-check.ts` gains two new checks: `checkRouteParity` cross-references every `src/pages/api/v1/**` route file's exported HTTP methods against the OpenAPI spec's `paths` (both directions — undocumented routes and stale documentation), and `checkPublicOperationAllowlist` fails if any OpenAPI operation becomes publicly documented (`security: []`) without a matching entry in a new reviewed `ALLOWED_PUBLIC_OPERATIONS` constant (currently just the 4 genuinely public endpoints: health x2, setup status/initialize) — or if an allow-list entry is no longer actually public.

  New `tests/unit/module-boundary-cycles.test.ts` generalizes the single hardcoded blog_content/news_portal forbidden-cross-import check (Issue #681) into a registry-wide gate: for every pair of the 14 registered modules, a source-level circular `application`/`domain` import (A imports B's, B imports A's back) now fails, not just that one pair. Deliberately scoped to cycles, not "any cross-module import must be in `dependencies`" — a probe found several legitimate one-directional imports (e.g. `blog-content -> logging`) that a blanket rule would have flagged as unrelated pre-existing findings.

  New `scripts/i18n-parity-check.ts` (`bun run i18n:parity:check`) compares `i18n/en.po`/`id.po`/`messages.pot` key sets using the same `.po` parser the runtime itself loads — a key present in `en.po` but missing from `id.po` was previously a silent, permanent translation gap (falls back to English, never surfaces as a bug). Found and fixed 204 real keys missing from the stale `messages.pot` template as part of wiring this in.

  New `e2e-smoke` CI job runs the Playwright suite against a real app + isolated Postgres — previously E2E was documented as "run manually, no CI orchestration exists yet." Runs in two phases with separate server lifecycles: `admin-security-disabled.e2e.ts` and `admin-security-enabled.e2e.ts` assert opposite renders of the same page gated on a boot-time env var, discovered empirically to be unrunnable against one server instance.

  CI hardening: Bun's install cache is now cached via `actions/cache` (keyed on `bun.lock`, `--frozen-lockfile` still runs every time — this only skips re-downloading, never skips the integrity check); failure diagnostics upload via `actions/upload-artifact` (build output / Playwright traces+logs, no secrets); every `uses:` action reference in `ci.yml`/`codeql.yml` is now pinned to a full commit SHA instead of a floating major-version tag; every job declares explicit least-required `permissions:` instead of inheriting the top-level default. New `docs/awcms-mini/branch-protection.md` documents the exact required-check names for a maintainer to configure branch protection (not yet enabled on `main` — this PR only documents it, doesn't apply it).

- e36a73f: Add the `data_exchange` module (Issue #752, epic `platform-evolution`
  #738 Wave 3, ADR-0017) — a provider-neutral, generic staged CSV/JSON
  import/export framework: module-contributed exchange descriptors,
  checksum/size/row/field-bounded staged intake with formula-injection
  (CSV injection) neutralization, zero-mutation preview, an asynchronous
  idempotent resumable commit via a new `bun run data-exchange:worker`
  job, export jobs with manifest/checksum, and reconciliation. Every
  owning module supplies its own schema/validation/mapping/commit
  adapter through a new capability port (`DataExchangeAdapterPort`/
  `DataExchangeExportSourcePort`); this module never writes to another
  module's tables directly. Ships one self-contained reference fixture
  (`reference_items`) proving create/update/conflict, partial-failure/
  resume, and export/reconciliation end-to-end. Five new tables (RLS
  `FORCE`d, tenant-scoped), 13 new permissions, new REST endpoints under
  `/api/v1/data-exchange/*`, new admin UI screens, and six new domain
  events.
- 8050fb6: Add the `data_lifecycle` System Foundation module (Issue #745, epic #738
  `platform-evolution` Wave 1, ADR-0013 §1) — a module-contributed
  high-volume table registry and safe lifecycle engine for retention,
  partitioning guidance, archival, legal hold, and bounded purge.

  - **Descriptor contract** (`HighVolumeTableDescriptor`,
    `src/modules/_shared/module-contract.ts`): owning modules declare their
    own high-volume tables (owner, tenant/global scope, cursor column,
    retention class + safe bounds, partition eligibility, archive policy,
    deletion behavior, legal-hold applicability/precedence, required
    indexes, batch limit, `"delegated"` vs `"generic"` execution mode) in
    their own `module.ts` — no shared-table writes, per ADR-0013 §6.
  - **Registry validation gate** (`bun run data-lifecycle:registry:check`,
    wired into `bun run check`; also `security:readiness`'s
    `checkDataLifecycleRegistryValid`).
  - **Legal holds** (`awcms_mini_data_lifecycle_legal_holds`) — scope,
    reason, authority reference, approval, audit, default-deny release
    (`legal_hold.create`/`.release` are separate permissions). Overrides
    ordinary retention/purge unconditionally, checked before any
    purge-eligibility branch, and cannot be bypassed by a
    `retentionDaysOverride` or by a descriptor declaring itself
    "not applicable" for holds.
  - **Dry-run lifecycle planning** (`POST /api/v1/data-lifecycle/dry-run`)
    — zero-mutation, deterministic eligible/held/archived/purgeable/blocked
    counts for any registered descriptor.
  - **Bounded archive/purge engine**
    (`bun run data-lifecycle:archive-purge`) built entirely on the shared
    worker runner (PR #713/Issue #697) — advisory lock, tenant-first
    batches, pause/resume cursors, retry classification. `"generic"`
    descriptors are archived (provider-neutral local/offline JSONL/CSV
    adapter, SHA-256 checksummed manifests) then purged;
    `"delegated"` descriptors (registered examples: `logging.audit_events`,
    `visitor_analytics.visit_events`, `form_drafts.form_drafts`) are only
    read for dry-run backlog visibility here — this engine never mutates
    them, real purge stays owned by each module's OWN existing job.
    `data_lifecycle`'s own run-history table
    (`awcms_mini_data_lifecycle_runs`) is the one `"generic"` adopter,
    proving real end-to-end execution without touching another module's
    schema. A legal hold created mid-invocation is re-checked at the start
    of EVERY batch pass (not just once per tenant per invocation), so it
    takes effect on the very next pass.
  - **Legal hold now actually enforced by the 3 registered "delegated"
    adopters' own existing purge functions**
    (`purgeExpiredAuditEvents`/`purgeVisitorAnalyticsData`/
    `purgeExpiredFormDrafts`) — a `LegalHoldGuardPort`
    (`src/modules/_shared/ports/legal-hold-guard-port.ts`) lets each of
    these 3 modules ask "is my registered descriptor currently held?"
    without a forbidden circular cross-module import (Issue #685/ADR-0011);
    a held descriptor's real DELETE is skipped entirely. Without this, a
    hold created via the new API gave false confidence — `dry-run` would
    correctly report `purgeableCount: 0`, but the pre-existing scheduled
    purge jobs (untouched by the original version of this change) would
    still hard-delete the "held" rows on their normal schedule.
  - **New API**: `GET /api/v1/data-lifecycle/registry`,
    `POST /api/v1/data-lifecycle/dry-run`,
    `GET /api/v1/data-lifecycle/runs`,
    `GET`/`POST /api/v1/data-lifecycle/legal-holds`,
    `POST /api/v1/data-lifecycle/legal-holds/{id}/release`. Real
    archive/purge execution stays an internal scheduled job, not exposed
    over HTTP (same posture as `logs:audit:purge`).
  - New `AccessAction` value `"release"` (`identity-access/domain/
access-control.ts`), classified high-risk.
  - New config: `DATA_LIFECYCLE_ARCHIVE_ROOT_PATH` (doc 18).
  - Fixed a real, empirically-confirmed timestamp precision bug found by
    this issue's own large-volume test: a cursor boundary value read back
    from Postgres as a JS `Date` loses microsecond precision, which
    previously made the purge upper bound silently exclude the boundary
    row (one row under-purged every cycle) and made the archive resume
    lower bound re-select the same boundary row on every subsequent pass
    (looping until the safety-bound pass limit). Both are fixed via a 1ms
    boundary safety margin — see `src/modules/data-lifecycle/README.md`
    §Timestamp precision. `dry-run-planner.ts`'s informational
    `archivedCount`/`purgeableCount` query now applies the SAME safety
    margin (shared via `domain/cursor-boundary.ts`), so the dry-run's
    reported counts never disagree with what the real purge pass actually
    deletes at the exact boundary row.
  - CI's `quality` job (`.github/workflows/ci.yml`) now also runs
    `bun run data-lifecycle:registry:check` explicitly (it was already in
    `package.json`'s `check` composite, but not in CI's own hand-maintained
    step list).

  Migrations `sql/057_awcms_mini_data_lifecycle_schema.sql` (four
  tenant-scoped, RLS FORCE'd tables) and
  `sql/058_awcms_mini_data_lifecycle_permissions.sql` (six permissions).
  Docs: new `docs/awcms-mini/data-lifecycle.md` (operational guide +
  UU PDP/PP PSTE/ISO 27001/27002/27005/27701/22301 compliance mapping,
  without asserting one universal legal retention period),
  `src/modules/data-lifecycle/README.md`, updates to doc 04 (ERD), doc 20
  (threat model), `deployment-profiles.md`, `resilience-dr-verification.md`,
  and a new skill (`.claude/skills/awcms-mini-data-lifecycle/`).

- e549beb: Make database pool and work-class budgets deployment-aware, and validate
  horizontal connection capacity before deployment (Issue #743, epic #738
  platform-evolution, Wave 1).

  Adds a typed capacity model (`src/lib/database/capacity-config.ts`) that
  sums `instance_count[class] x pool_max[class] + reserved_headroom` across
  every database-using process class (`app`/`worker`/`setup`) and validates
  it against an approved PgBouncer/PostgreSQL connection budget — the
  concrete "10 instances x pool_max 20 = 200 connections vs. an 80-connection
  approved budget = connection storm" scenario the issue describes. A new,
  read-only `database:capacity` stage in `bun run production:preflight`
  (also runnable standalone via `bun run database:capacity:check`) fails
  before go-live when the configured horizontal ceiling would exceed the
  approved budget, or when the capacity configuration is otherwise unsafe or
  internally inconsistent. PgBouncer transaction-pooling and direct-
  PostgreSQL profiles are validated with separate, correct assumptions.

  Extends existing pooling/backpressure mechanism (Issues #682/#684/#698/
  #699) rather than replacing it:

  - `src/lib/database/client.ts` — pool `max` can now be sized independently
    per process class (`DATABASE_POOL_MAX_WORKER`/`DATABASE_POOL_MAX_SETUP`,
    both optional, falling back to `DATABASE_POOL_MAX` for full backward
    compatibility).
  - `src/lib/database/work-class.ts` — the per-work-class FIFO queue is now
    BOUNDED (`DATABASE_WORK_CLASS_QUEUE_MULTIPLIER`, default 4x a class's own
    concurrency max). Once a class's queue is full, a new caller is rejected
    IMMEDIATELY (`WorkClassQueueFullError`) instead of joining an
    ever-growing queue and eventually timing out — closing a "cascading
    timeout chain" gap in the existing graceful-saturation design.
  - `src/lib/database/tenant-context.ts` — every `503 DATABASE_BUSY`
    `withTenant` can return (circuit-open, work-class timeout, or the new
    bounded-queue rejection) now carries a `Retry-After` header.
  - A new endpoint/operation-to-work-class registry
    (`src/lib/database/work-class-registry.ts` for background jobs,
    auto-generated `docs/awcms-mini/work-class-registry.generated.json` for
    every `withTenant`-calling API route) with a CI drift gate
    (`bun run db:work-class:check`, part of `bun run check`) that fails when
    a new route or worker job is added without an explicit, reviewable
    work-class classification.
  - `GET /api/v1/database/pool/health` additively reports a `capacity`
    summary and each work class's `maxQueueDepth` (OpenAPI updated).
  - New low-cardinality metrics: `db_pool_work_class_rejected_total`,
    `db_pool_work_class_wait_ms`, `db_pool_capacity_configured_connections`,
    `db_pool_capacity_estimated_total_connections`,
    `db_pool_capacity_approved_budget`.

  Every new environment variable is optional with a conservative default
  that reproduces the pre-#743 single-instance offline/LAN topology —
  `bun run database:capacity:check` passes with zero of them set, and no
  existing deployment's `.env` needs to change. Preflight and the capacity
  calculator are strictly read-only and never modify pool/database
  configuration. See `docs/awcms-mini/database-capacity-runbook.md` for the
  full model, a worked sizing example, and the incident-response procedure
  for saturation/connection-storm events.

- 30c5d55: Add Postgres least-privilege role separation for background workers and the
  setup wizard (Issue #683, epic #679, platform-hardening).

  Migration 013's `awcms_mini_app` role has blanket `SELECT/INSERT/UPDATE/
DELETE` on every `awcms_mini_*` table — correct for the ~76 tenant-scoped
  tables (RLS `ENABLE`+`FORCE` is the real isolation boundary there, ADR-0003),
  but it also reaches 9 GLOBAL (non-RLS) tables: the permission catalog, the
  migration ledger, the setup-state lock, the tenant root table, and the
  module registry + 4 dependents. The same role that serves every ordinary
  tenant web request had unrestricted write access to data no ordinary
  request should ever touch.

  New migration `sql/045_awcms_mini_db_role_separation.sql` adds two optional
  roles alongside the migration-owner/`awcms_mini_app` pair:

  - `awcms_mini_worker` (`WORKER_DATABASE_URL`) — the 7 unattended cron-style
    scripts with no HTTP endpoint (`analytics:rollup`, `analytics:purge`,
    `logs:audit:purge`, `sync:objects:dispatch`, `email:dispatch`,
    `blog:publish:scheduled`, `form-drafts:purge`). Zero access to the 9
    global tables except `SELECT` on `awcms_mini_tenants`.
  - `awcms_mini_setup` (`SETUP_DATABASE_URL`) — only
    `POST /api/v1/setup/initialize`. Defense-in-depth on top of the existing
    `awcms_mini_setup_state` singleton lock, not a replacement for it.

  `awcms_mini_app` itself is narrowed on the 9 global tables to exactly what
  ordinary requests legitimately write (module registry sync/health-check
  endpoints keep full DML; the permission catalog, migration ledger, and
  setup-state lock become read-only or lose write entirely; the tenant root
  table keeps `UPDATE` for `PATCH /api/v1/settings` but loses `INSERT`/
  `DELETE`).

  Both new roles are optional — `WORKER_DATABASE_URL`/`SETUP_DATABASE_URL`
  fall back to `DATABASE_URL` (the narrowed `awcms_mini_app` role) when unset,
  so existing deployments keep working with zero config changes and still
  get the narrower `awcms_mini_app` grants.

  New regression guard: `bun run security:readiness`'s
  `checkRuntimeRoleGlobalTableGrants` (critical) reads the real grants from
  `pg_class.relacl` and fails go-live if a future migration accidentally
  grants a runtime role unexpected access to one of the 9 global tables.

  New integration tests
  (`tests/integration/db-role-separation.integration.test.ts`) connect as
  each of the three runtime roles against a real Postgres and assert the
  actual permission-denied/succeeds outcome — this caught a real bug during
  development: `INSERT ... RETURNING id` requires `SELECT` privilege on the
  returned column, not just `INSERT`, so `awcms_mini_setup` needed `SELECT`
  added on every table `bootstrapPlatformTenant` inserts into with
  `RETURNING id`.

- 64c8a12: Harden Docker Compose, PgBouncer, and production image defaults (Issue #682, epic #679, platform-hardening).

  `docker-compose.yml`'s `db` and `pgbouncer` services no longer publish a host port by default — production/offline-LAN topologies never needed direct host access to PostgreSQL, and it was previously always exposed. Local dev access is now opt-in via `docker-compose.override.yml.example` (copy to `docker-compose.override.yml`, auto-loaded, git-ignored), binding both ports to `127.0.0.1` only. Every service (`db`/`migrate`/`app`/`pgbouncer`) now runs `cap_drop: [ALL]` (`db` gets back the 5 capabilities its own entrypoint needs — `CHOWN`/`FOWNER`/`SETUID`/`SETGID`/`DAC_OVERRIDE` — live-verified as the minimum `postgres:18.4` requires) plus `security_opt: no-new-privileges:true`, a starting-point `deploy.resources.limits`, and (for `app`) a Bun-native HTTP healthcheck. `oven/bun:1` and `edoburu/pgbouncer:latest` are now pinned to `oven/bun:1.3.14`/`edoburu/pgbouncer:v1.25.2-p0` instead of floating tags.

  PgBouncer's `deploy/pgbouncer/pgbouncer.ini.example` moves from `auth_type = md5` to `scram-sha-256`, matching PostgreSQL 18's own default password hashing — the header documents the exact `pg_authid.rolpassword` extraction command for generating `userlist.txt`. Live-verified end-to-end: a real SCRAM verifier extracted from a running dev database was accepted by a real PgBouncer container, and a client authenticated against it successfully.

  New `docker-compose.prod.yml` gives the registry-based/immutable-image topology (`Dockerfile.production`, previously only usable via bare `docker build`/`docker run`) its own Compose entry point — standalone, not an override of `docker-compose.yml`. Its `app` service runs `read_only: true` with a `tmpfs` `/tmp` mount, live-verified safe since the built image never writes to its own filesystem at runtime (no bind-mount install/build step, unlike the default compose file). `Dockerfile.production` itself gains the same Bun version pin, a `HEALTHCHECK` instruction, and updated `docker run` guidance for `--cap-drop=ALL`.

  CI now runs `docker compose config -q` against both compose files (and the `pgbouncer` profile) on every PR, catching syntax/env-var errors before they reach a deploy. `docs/awcms-mini/deployment-profiles.md` gains new TLS/trust-boundary and secrets-via-deployment-references sections documenting where TLS terminates in each topology and the options for orchestrators that require file-based (rather than env-var) secrets.

- 59bce6d: Add `document_infrastructure`, a generic, tenant-scoped document metadata infrastructure module (Issue #751, epic `platform-evolution` #738 Wave 3, admission decision `docs/adr/0017-document-infrastructure-module-admission.md`).

  Base gets a new Official Optional Module for reusable document metadata — never a domain document schema — so derived applications stop rebuilding the same structural primitives (versioning, classification, evidence, numbering) for their own letters/invoices/purchase orders/journal batches/medical records/contracts.

  - A classification catalog, the document registry itself (owner module + document type + a primary generic resource reference), and IMMUTABLE append-only versions — `content_reference`/`content_reference_kind` point at an approved managed-object storage contract, never a binary blob column. `document-version-service.ts`'s `createDocumentVersion` is the sole writer of `awcms_mini_document_versions`; no `UPDATE`/`DELETE` statement against that table exists anywhere in the module.
  - Additional typed generic resource relations, written only through a new capability port (`document_resource_relations`, `application/document-resource-relation-port.ts`) — any other module imports and calls `linkDocumentToResource`/`unlinkDocumentFromResource`/`listRelationsForResource`/`listRelationsForDocument` directly (in-process, ADR-0011 pattern) to attach a document to one of its own resources, without this module ever reading/writing that module's tables.
  - Concurrency-safe numbering sequences: effective-dated (SCD Type 2 style) definitions where revising the format never resets or reuses the counter, and atomic reservation/commit/cancel via row-level `SELECT ... FOR UPDATE` on the sequence's current definition row — proven under real parallel load by a genuine concurrency integration test (20 simultaneous reservation requests, 20 distinct numbers, zero duplicates). `UNIQUE (tenant_id, sequence_id, reserved_number)` makes silent number reuse structurally impossible regardless of a reservation's final status.
  - A bounded, hand-written character-scanning format-template grammar (`{SEQ}`/`{SEQ:n}`, `{YYYY}`/`{YY}`/`{MM}`/`{DD}`) — never `eval`/dynamic regex/unbounded template execution.
  - An append-only evidence trail for numbering/version/document lifecycle events, complementing (not replacing) the general audit log.
  - Seven new tenant-scoped tables (`sql/066`), all `ENABLE`+`FORCE ROW LEVEL SECURITY` with tenant-first indexes and least-privilege `awcms_mini_worker` read-only grants; 27 new permissions (`sql/067`).
  - Four new `AccessAction`/`HIGH_RISK_ACTIONS` literals added additively to `identity-access/domain/access-control.ts`: `void`, `reclassify`, `reserve`, `commit` — the pre-existing shared `cancel` literal is deliberately left unclassified to avoid changing blast radius for other modules' `cancel` actions.
  - Idempotency-Key required on every mutation with real double-submit risk (document/version create, void/restore/reclassify, relation link/unlink, sequence define/revise/deactivate/restore, reservation reserve/commit/cancel) — audited via a fresh unit-test sweep of the module's entire mutation surface after a sibling PR in this epic needed a follow-up round for missing exactly this coverage.
  - Admin UI: `/admin/document-infrastructure/{classifications,documents,documents/{id},sequences}`.
  - Domain events (`document.created/voided/restored/reclassified`, `version.created`, `number.reserved/committed/canceled`) wired through `domain_event_runtime`.
  - OpenAPI (`openapi/modules/document-infrastructure.openapi.yaml`), AsyncAPI channels, i18n (en+id), unit + integration tests (including cross-tenant isolation and five neutral fixtures — correspondence evidence, contract attachment, invoice reference, approval evidence, asset-disposal evidence — demonstrating reuse without any domain-specific rule), and module README.

- f504ebb: Add `domain_event_runtime` — a transactional, versioned, generic multi-consumer domain-event outbox and dispatcher (Issue #742, epic `platform-evolution` #738 Wave 1).

  - New module `domain-event-runtime` (`domain_event_runtime`, `type: system`), registered in `src/modules/index.ts`. Migration `056` adds six tenant-scoped RLS tables: `awcms_mini_domain_events` (the outbox), `awcms_mini_domain_event_deliveries` (per-event/per-consumer retry/dead-letter state), `awcms_mini_domain_event_consumer_effects` (reusable event-ID-keyed side-effect idempotency marker), `awcms_mini_domain_event_consumer_state` (pause/resume), `awcms_mini_domain_event_replays` (append-only replay audit trail), and `awcms_mini_domain_event_activity_daily` (reference read-model projection).
  - Producers call `appendDomainEvent(tx, tenantId, input)` inside their own business transaction — the event and its fan-out delivery rows (from a static, reviewed-source-code consumer registry) commit atomically with the source state change; a rolled-back caller transaction produces no dispatchable event.
  - The dispatcher (`bun run domain-events:dispatch`, built on the shared worker runner from PR #713) claims/executes/finalizes due deliveries per tenant/consumer with explicit per-aggregate/order-key ordering (unrelated keys progress independently), exponential backoff, and dead-letter transitions after the retry budget is exhausted or a non-retryable error occurs.
  - Dead-lettered deliveries can be replayed via a permission-gated (`domain_event_runtime.deliveries.replay`), reason-required, idempotent (`Idempotency-Key`), audited admin action that refuses to replay against an event version the registered consumer no longer supports.
  - Two reference consumers exercise the mechanism end-to-end against a self-contained reference event (`awcms-mini.domain-event-runtime.sample.recorded`): a same-process cross-module audit-trail projector, and a reporting/read-model activity-rollup projector. Real producer/consumer wiring for existing modules is intentionally deferred to follow-up issues.
  - New REST API under `/api/v1/domain-events/{events,deliveries,consumers}` (read-mostly; replay and pause/resume are the only mutations) — see `openapi/modules/domain-event-runtime.openapi.yaml`. New AsyncAPI channel `awcms-mini.domain-event-runtime.sample.recorded`.
  - No external broker is required; `infrastructure/broker-adapter-port.ts` defines an optional port for future use. Offline/LAN deployments are unaffected.

- b73edc9: Define provider-neutral ERP extension readiness contracts (Issue #755,
  epic #738 `platform-evolution` Wave 4, ADR-0020) — AWCMS-Mini is a
  technical kernel, never a functional ERP; this issue documents and
  validates the contract package a future ERP extension (built in a
  SEPARATE repository) implements against, without adding any accounting,
  inventory, sales/procurement, AR/AP, payroll, tax, asset, or manufacturing
  domain table/route to this base repository.

  New pure-data/port contracts (`src/modules/_shared/`):
  `business-transaction-contract.ts` (business transaction reference/
  lifecycle status, accounting posting request/result event payload
  shapes), `erp-reference-data-contract.ts` (item/service, currency,
  unit-of-measure, inventory movement, and reconciliation reference
  shapes), and `ports/period-lock-port.ts` (a fail-closed period-lock
  capability port, with a `noPeriodLockAdapterConfigured` default that
  always reports `checked: false` — never silently permits posting). Four
  of eleven contract families deliberately reuse existing Wave 2/3
  mechanisms rather than duplicating them: canonical party
  (`party-directory-port.ts`), tenant/legal-entity/organization scope
  (`business-scope-hierarchy-port.ts`), document numbering
  (`document_infrastructure`), and reporting projection contribution
  (`reporting`'s `ProjectionDescriptor`).

  A new in-repo fixture (`tests/fixtures/derived-application-example/
modules/example-erp-extension/`) demonstrates all of this end to end —
  an idempotent, fail-closed-period-lock, cross-tenant/legal-entity-
  mismatch-rejecting posting engine with reversal-as-a-new-transaction
  semantics, plus a `reporting` projection contribution that independently
  passes `reporting`'s real `validateProjectionRegistry` check — never
  composed into the base's real module registry
  (`src/modules/index.ts` unchanged). New tests:
  `tests/unit/erp-extension-contracts.test.ts` (idempotency, fail-closed
  period lock, cross-tenant/legal-entity rejection, reversal, dependency-
  direction proof that no base `src/modules/**` file imports the example
  extension) and extended `tests/unit/module-composition-fixture.test.ts`
  coverage for the third fixture module.

  New ADR (`docs/adr/0020-erp-extension-readiness-contracts.md`) and
  reference doc (`docs/awcms-mini/erp-extension-contracts.md`, all eleven
  contract families with ownership/versioning/failure-semantics/privacy/
  examples), plus cross-references added to
  `docs/awcms-mini/21_module_admission_governance.md` (a pure contract
  package without a new module still requires a full ADR, not the
  lightweight module-proposal template), `docs/awcms-mini/derived-
application-guide.md`, `docs/awcms-mini/13_final_master_index_
traceability.md`, and `docs/awcms-mini/19_glossary_terminology.md`. New
  skill `.claude/skills/awcms-mini-erp-extension-readiness/SKILL.md` for
  future work consuming or evolving these contracts.

  Explicitly pinned caveat: Issue #750 (`reference_data`) was still open
  with unresolved Critical findings at the time this issue shipped — the
  item/currency/unit-of-measure contracts here deliberately avoid a hard
  dependency on that module's internal schema.

  Two invariants added/hardened after an independent security-auditor pass
  on this PR: (3) posted-state uniqueness keyed by `(tenantId,
transactionType, externalTransactionId)`, independent of `requestId` —
  the original fixture only deduplicated by `requestId`, letting a new
  `requestId` for the same business transaction double-post (Medium); and
  (7) reversal-target resolution scoped to the authenticated tenant/legal
  entity, in the documented `externalTransactionId` ID space — the
  original fixture indexed reversal targets by `requestId` (the wrong ID
  space) with no tenant/legal-entity re-verification at all, letting an
  attacker who observed/guessed another tenant's identifiers reference
  their posted transaction (High). Both are fixed in
  `posting-engine.ts`/`business-transaction-contract.ts` and proven by two
  new adversarial tests in `tests/unit/erp-extension-contracts.test.ts`.

- a807628: Publish a derived-application compatibility manifest schema, reusable
  test kit, and semantic-version gates (Issue #741, epic #738
  `platform-evolution`, Wave 1, ADR-0015) — a new `bun run extension:check`
  (`scripts/extension-check.ts`) validates a derived repository's own
  `extension.manifest.json`/`.yaml` against this release's actual base
  SemVer range, module-contract version (`MODULE_CONTRACT_VERSION`, new
  `src/modules/_shared/module-contract.ts` export), capability contract
  versions (new `src/modules/_shared/capability-contract-versions.ts`
  registry), historical migration checksum immutability/ordering (reusing
  `scripts/db-migrate.ts`'s own checksum primitives), declared deployment
  profile requirements, and OpenAPI/AsyncAPI contract staleness — while
  also always re-running Issue #740's `composeModuleRegistry` against the
  real base + application registry.

  Wired into three real gates so an incompatible manifest actually blocks
  something (not just a standalone report): `package.json`'s `check`
  composite, `.github/workflows/ci.yml`'s `quality` job as an explicit
  named step, and `scripts/production-preflight.ts`'s stage list — the
  same three places Issue #740's `modules:compose:check` was wired, for
  the identical reasoning. Absent a manifest (this base repository's own
  default state), the check passes trivially, so the base build is
  unaffected.

  Ships one compatible fixture
  (`tests/fixtures/derived-application-example/extension.manifest.json`)
  and eight incompatible fixtures
  (`tests/fixtures/extension-contract-incompatible/`), each failing for a
  genuinely distinct reason, proven both at the pure-function level
  (`tests/unit/extension-compatibility.test.ts`) and via a real spawned CLI
  process (`tests/unit/extension-check-fixtures.test.ts`). New dependency-
  free SemVer utility at `src/lib/semver/compare.ts`. Documented in
  `docs/adr/0015-derived-application-compatibility-manifest.md` and
  `docs/awcms-mini/extension-compatibility-policy.md`.

- 89ce306: Add generic server-side form draft persistence: a new
  `awcms_mini_form_drafts` table (tenant-scoped, RLS FORCE'd) and
  `src/modules/form-drafts/` module with `GET/POST /api/v1/form-drafts`,
  `GET/PATCH/DELETE /api/v1/form-drafts/{id}`, and
  `POST /api/v1/form-drafts/{id}/submit` (Idempotency-Key required). Lets a
  multi-step wizard (Issue #479/#480) resume across sessions/devices instead
  of only holding progress in memory. Payload is denylist-validated against
  secret-shaped fields (password/token/secret/credential/apiKey/privateKey)
  and capped at 32KB; a scheduled `bun run form-drafts:purge` expires
  overdue drafts and purges old expired/abandoned ones. Piloted in
  `admin/examples/wizard.astro` — no domain-specific behavior added to the
  base itself. See `src/modules/form-drafts/README.md` and
  `docs/awcms-mini/examples/wizard-form-pattern.md` §Server-side draft
  (Issue #484).
- 9f31eb0: Generate `messages.pot` deterministically from source, and extend the EN/ID/POT parity gate to placeholders (Issue #694, epic #679, platform-hardening).

  `i18n/messages.pot` was maintained BY HAND — no extraction tooling existed at all, which is exactly how it silently drifted 204 keys behind `en.po`/`id.po` before Issue #685 hand-fixed the symptom. This issue fixes the actual cause: new `scripts/i18n-extract.ts` (`bun run i18n:extract`) scans every `.astro`/`.ts`/`.tsx` file under `src/` for `t("...")` call sites and regenerates `messages.pot` from what the code actually references — sorted alphabetically with a `#:` source-location comment per key, so the output is byte-identical across repeated runs regardless of filesystem readdir order.

  A pure literal-string scan misses three real patterns already in this codebase, each handled explicitly to avoid false "obsolete key" positives: `t(entry.labelKey)` nav-menu indirection (resolved from each module's `labelKey: "..."` literal definition), `t(key)` via `error-messages.ts`'s `ERROR_CODE_KEYS` map, and `t(\`admin.blog.status.${status}\`)`-style template-literal interpolation (resolved via a new `DYNAMIC_KEY_FAMILIES`table — same spirit as`src/lib/config/registry.ts`'s `CONFIG_EXEMPTIONS`, Issue #689 — mapping each prefix to its concrete suffix values from that value's actual domain enum). `assertNoDeadDynamicFamilies`fails the real`i18n:extract`/`i18n:pot:check`run if a declared family is no longer referenced, and extraction itself throws on an unrecognized dynamic prefix — the table can't silently drift in either direction. Running the extractor against the current`src/`tree reproduces the exact same 826 keys already in`en.po`/`id.po` — zero missing, zero obsolete.

  New `scripts/i18n-pot-check.ts` (`bun run i18n:pot:check`, added to `bun run check`) is the read-only twin: regenerates the template in memory and fails if it differs from the committed file, so a `t(...)` call added without re-running `i18n:extract` is caught in CI.

  `scripts/i18n-parity-check.ts` (Issue #685) is extended, not replaced: `checkPlaceholderParity` now fails if a shared key's `{name}`-style placeholders differ between `en.po` and `id.po` (previously a translator could drop `{name}` from a translation and `interpolate()` would silently render the literal text `{name}` to end users — no crash, no CI signal). `checkNoPluralForms` is a tripwire, not a mismatch checker: this catalog has never used gettext `msgid_plural`/`msgstr[n]` (verified — zero occurrences in all three files, and `po-parser.ts` doesn't implement plural parsing), so it fails loudly if one is ever introduced rather than silently mis-parsing, documented as a deliberate current-state decision rather than an untested plural-mismatch implementation for a feature with no real usage.

  New tests: `tests/unit/i18n-extract.test.ts` (literal/multi-line/indirect/dynamic-family extraction, determinism, dead-family-entry tripwire, spot-checks against the real repo) and additions to `tests/unit/i18n-parity-check.test.ts` (placeholder-mismatch and plural-forms-tripwire fixtures). `docs/awcms-mini/14_ui_ux_design_system.md` §Internationalization and `.claude/skills/awcms-mini-i18n/SKILL.md` document the new `bun run i18n:extract` contributor workflow.

- b1bd1f2: Scaffold the `idn_admin_regions` module (Issue #655, epic #654 — master
  data wilayah administratif Indonesia dari `cahyadsn/wilayah`, MIT
  License). Registers the `idn_admin_regions` module descriptor (`version
0.1.0`, `status experimental`, `type base`, depends on `identity_access`,
  `logging`, `module_management`) in `src/modules/index.ts`, and seeds five
  new ABAC permissions (`idn_admin_regions.region.read`,
  `idn_admin_regions.dataset.read`, `.dataset.import`, `.dataset.activate`,
  `.dataset.rollback`) via migration `048`. No dataset schema, vendored
  source files, parser, import pipeline, activation/rollback, lookup API,
  or admin UI yet — those land in later issues of the same epic (see
  `.claude/skills/awcms-mini-idn-admin-regions/SKILL.md`).

  Also fixes a false positive in `scripts/db-migrate.ts`'s
  `assertNoTransactionControl` transaction-control guard: a migration
  whose data literally contains the word "rollback" inside a quoted SQL
  string literal (exactly this issue's own permission seed row) was
  previously rejected as if it contained a top-level `ROLLBACK;`
  statement. String literal contents are now stripped before the scan,
  the same way dollar-quoted PL/pgSQL block bodies already were.

- 541d605: Add the versioned PostgreSQL schema for Indonesia administrative region
  datasets (Issue #657, epic #654 — master data wilayah administratif
  Indonesia dari `cahyadsn/wilayah`, following #655's module scaffold and
  #656's vendored source data). Migration `sql/054` adds two GLOBAL
  reference tables (no `tenant_id`, no RLS — identical for every tenant):

  - `awcms_mini_idn_region_datasets` — one row per imported dataset
    version, recording upstream provenance (repository, source path,
    commit SHA, license, file checksum), row count, lifecycle `status`
    (`validated`/`active`/`superseded`/`rejected`), and validation summary.
    "Only one dataset can be active at a time" is enforced with a partial
    unique index on `status` `WHERE status = 'active'`.
  - `awcms_mini_idn_admin_regions` — one row per normalized administrative
    region (province/regency/district/village) belonging to a dataset.
    Unique `(dataset_id, code)`, a `(dataset_id, parent_code)` parent-lookup
    index, and a `(dataset_id, normalized_name)` search index.

  Both tables are added to `RLS_FREE_TABLES`/`ALLOWED_GLOBAL_TABLE_GRANTS`
  in `scripts/security-readiness.ts` and to `RLS_EXEMPT_TABLES` in
  `scripts/repo-inventory-generate.ts`. `awcms_mini_app` is granted ZERO
  access on either table in this migration (no runtime code path reads or
  writes them yet — schema only) — future issues (#660 import, #661
  activate/rollback, #662 lookup API) each add exactly the grant their own
  new code path needs.

  No parser/normalizer (#658), validation gate (#659), import pipeline
  (#660), activation/rollback (#661), lookup API (#662), or admin UI (#663)
  yet — those land in later issues of the same epic (see
  `.claude/skills/awcms-mini-idn-admin-regions/SKILL.md`).

- bbd13fa: Add `integration_hub`, a generic provider-neutral integration boundary — signed inbound webhooks, replay protection, normalized events, outbound event subscriptions, and adapter health (Issue #754, epic `platform-evolution` #738 Wave 3, ADR-0019).

  - New System module `integration_hub`, admitted via `docs/adr/0019-integration-hub-module-admission.md` (depends on `domain_event_runtime` #742 and integrates with `data_lifecycle` #745, both merged). Six tenant-scoped tables (migration `073`/`074`, RLS `ENABLE`+`FORCE`).
  - **Signed inbound webhooks**: `POST /api/v1/integration-hub/inbound/{endpointToken}` — a public, non-tenant-authenticated endpoint (opaque server-generated `endpointToken` + per-endpoint HMAC secret, resolved via a narrow `SECURITY DEFINER` bootstrap lookup, `awcms_mini_resolve_integration_endpoint_lookup`, before any tenant context exists). Timing-safe signature verification (`node:crypto`'s `timingSafeEqual`), two self-contained fixture signature schemes (`fixture_hmac_sha256`, `fixture_shared_secret_nonce`), key rotation with an overlap window, and content-type/body-size gates.
  - **Replay protection is a real database uniqueness constraint** (`UNIQUE (tenant_id, endpoint_id, replay_key)` on `awcms_mini_integration_inbound_deliveries`), not only an in-process check — a duplicate verified delivery is idempotently ignored, never re-normalized.
  - **Normalization**: a verified inbound delivery is translated into this repo's own domain-event shape (`awcms-mini.integration-hub.inbound-message.normalized`) via `domain_event_runtime`'s `appendDomainEvent`, inside the same transaction as the delivery row.
  - **Outbound event subscriptions**: tenant-configured `target_url` + bounded declarative filter, fanned out by a new real `domain_event_runtime` consumer (`integrationHubOutboundFanoutConsumer`, a same-process DB-only handler — never a network call inside a transaction, ADR-0006). The real HTTP delivery runs later, outside any transaction, via `bun run integration-hub:outbound:dispatch` (claim/send/finalize, retry/backoff, dead-letter, operator-safe replay creating a new delivery row rather than mutating history).
  - **SSRF protection**: private/link-local/metadata/reserved destinations rejected at subscription write time, at dispatch time (including every DNS-resolved address), AND on every HTTP redirect hop (`fetch()` uses `redirect: "manual"`; each `Location` is re-validated before being followed, bounded to 2 hops) — with a deployment-wide opt-out (`INTEGRATION_HUB_ALLOW_PRIVATE_TARGETS`, default `false`) for LAN-first deployments. Response body reads are byte-capped and bounded by the same timeout window as the request itself.
  - **Secrets**: never stored/logged/returned as plaintext values — `secretReference` fields are `env:VAR_NAME` pointers only, and the referenced env var name must start with `INTEGRATION_HUB_` (validated at write time), preventing a tenant from referencing an unrelated process-wide secret.
  - Admin API + 3 admin UI screens (`/admin/integration-hub/{endpoints,subscriptions,deliveries}`) for endpoint/subscription CRUD, pause/resume, secret rotation, delivery inspection, and dead-letter replay — all high-risk mutations `Idempotency-Key`-required and audited.
  - The outbound dispatch claim query reclaims a delivery stuck in `sending` whose lease has expired (e.g. after a worker crash), mirroring `sync-storage`'s `object-dispatch.ts` — a delivery is never permanently stranded.
  - The normalized inbound payload gets PII-key redaction (`nik`/`npwp`/`phone`/`whatsapp`/`email`-named fields) in addition to secret-pattern redaction before being persisted/relayed.
  - `awcms_mini_integration_inbound_deliveries` registered with `data_lifecycle` (Issue #745) as a `"generic"` retention descriptor (default 90-day retention, communication-log class); `_outbound_deliveries`/`_delivery_attempts` intentionally not yet registered (documented FK-ordering limitation).
  - `awcms_mini_worker` least-privilege grants scoped exactly to what the outbound dispatch job and fan-out consumer need, proven under the real role via `provisionWorkerRole()` in the integration test suite (not just the admin/superuser connection).

  Security-review fixes applied before merge (independent reviewer + security-auditor pass):

  - **High**: the SSRF guard only ever validated the original `target_url` — `fetch()`'s default redirect-follow behavior let a tenant-controlled target 302/303/307 to `169.254.169.254` (cloud IMDS) or any private IP with 100% reliability (no timing race). Fixed by calling `fetch()` with `redirect: "manual"` and validating every redirect `Location` the same way as the original URL, bounded to 2 hops.
  - **Medium**: the outbound-delivery claim query never reclaimed a delivery stuck in `sending` after its lease expired (e.g. a worker crash mid-`fetch()`), permanently stranding it. Fixed by widening the claim `WHERE` clause, mirroring `object-dispatch.ts`.
  - **Medium**: `secret_reference` accepted any `env:<VAR_NAME>` with no restriction, letting a tenant use repeated signed-webhook attempts as a boolean oracle against an unrelated process-wide secret. Fixed by requiring an `INTEGRATION_HUB_` naming prefix, validated at write time.
  - **Medium-High**: the admin UI's rotate-secret action (described in the PR/README) was not actually wired into `endpoints.astro`. Fixed by adding the rotate-secret button/prompt/fetch call.
  - **Low**: the normalized inbound payload had no PII-key redaction before persistence/relay. Fixed as noted above.

  Second security-auditor pass, fixed before merge:

  - **Critical**: `URL.hostname` returns an IPv6 literal WITH its surrounding brackets (e.g. `[::1]`, not `::1`); `node:net`'s `isIP()` returns `0` (unrecognized) for a bracketed string, so the SSRF guard's private/loopback/link-local/ULA/mapped-IPv4-metadata classification never actually ran for ANY IPv6 literal target, at write time OR dispatch time OR on a redirect hop — a tenant could register `http://[::1]/`, `http://[fc00::1234]/`, `http://[fe80::1]/`, or `http://[::ffff:169.254.169.254]/` and have it accepted. Also found and fixed the same class of gap one layer deeper: the IPv4-mapped-address regex only matched the dotted-decimal form (`::ffff:a.b.c.d`), but the WHATWG URL parser normalizes that literal to the hex-group form (`::ffff:a9fe:a9fe`), which never matched either. Fixed by stripping brackets before every `isIP()` call (`unwrapIpv6Literal`, applied inside `isBlockedIpAddress` itself so every caller is safe by construction) and adding hex-group IPv4-mapped-address detection alongside the existing dotted-decimal one.
  - **Medium**: `raw_body_snippet` (up to 2000 chars of the RAW provider payload, persisted for every signature-valid inbound delivery) only ever got secret-PATTERN redaction, never the PII-key-based masking the normalized JSON body already gets — a payload containing e.g. `"nik":"..."` or a bare email/phone was stored in plaintext at rest (not currently exposed via any API/UI, but genuine unmasked PII at rest). Fixed by not persisting the raw snippet at all once the normalized body already is the real, key-redacted troubleshooting artifact for that delivery (a JSON object payload); still persisted (secret-pattern-redacted, as before) for the non-object/unstructured cases where the normalized body can't help either.

  Third security-auditor pass (adversarial, same root function, different bit-pattern), fixed before merge:

  - **Critical**: the bracket-strip fix above only covered the `::ffff:/96` IPv4-mapped embedding. Four OTHER known IPv6-embedded-IPv4 forms still bypassed the guard entirely (write time, dispatch time, redirect hop, AND the DNS-resolved-address defense-in-depth check): IPv4-translated (`::ffff:0:a.b.c.d`, RFC 8215 — one extra reserved zero group before the IPv4 payload than the mapped form), NAT64 Well-Known (`64:ff9b::/96`, RFC 6052), NAT64 Local-Use (`64:ff9b:1::/48`, RFC 8215), and 6to4 (`2002::/16`, RFC 3056). Rather than adding a 5th one-off regex, generalized to the actual bug class — "an IPv6 address with an embedded IPv4 payload in a known translation prefix": every literal is now expanded to its 16 raw bytes (`parseIPv6ToBytes`), each known prefix's bit-defined embedded-IPv4 payload is extracted (`isBlockedEmbeddedIPv4`), and the EXISTING `isPrivateOrReservedIPv4` check (never reimplemented) runs against it.

  Fourth security-auditor pass (adversarial fuzzing + TCP-level exploit testing) gave a PASS verdict on the generalization above, plus two cheap non-blocking hardening items folded in before closing this file out:

  - **Medium (non-blocking)**: the deprecated RFC 4291 §2.5.5.1 "IPv4-compatible" form (`::a.b.c.d`, no `ffff` marker at all) was the one remaining known embedded-IPv4 encoding `isBlockedEmbeddedIPv4` didn't yet cover — not reachable via this codebase's actual `fetch()`/DNS path today, but the function's own docstring claims to cover "every known embedded-IPv4 form," so this makes that literally true.
  - **Low (non-blocking)**: the loopback (`::1`)/unspecified (`::`) check was a string special-case that a non-canonical fully-expanded literal (e.g. `0:0:0:0:0:0:0:1`) could bypass. Replaced with the same byte-based check the rest of the function already uses.

- d50d0fa: Normalize and redact server-side/worker error logging (Issue #687, epic
  #679 platform-hardening) — narrow remediation on top of the existing
  structured-logger/audit-trail foundation (Issue 10.1/#403/#447), not a
  replacement for it.

  Every admin SSR page (`src/pages/admin/**/*.astro`, 24 files) and CLI
  worker script (`scripts/*.ts`, 19 files including `scripts/api-spec-check.ts`)
  that used to call `console.error(label, error)` raw, or hand-extract
  `error.message` via `error instanceof Error ? error.message : String(error)`
  and print it directly, now goes through two new call-site helpers:
  `logAdminPageError`/`logScriptFailure` (`src/lib/logging/error-log.ts`),
  built on `sanitizeErrorForLog`/`safeErrorDetail`
  (`src/lib/logging/error-sanitizer.ts`). Both redact a caught error's own
  `.message`/`.stack` — including a nested `.cause` chain — via a new
  `redactSecretsInText` (`src/modules/_shared/redaction.ts`), the free-text
  complement to the existing key-based `redactSensitiveAttributes`: it masks
  JWTs, PEM private key blocks, AWS access key ids, `Bearer`/`Basic` auth
  header values, connection-string credentials, and `key=value`-shaped
  secrets embedded in otherwise-unstructured exception text.

  `REDACTION_KEYS` (key-based redaction) gains `"cookie"`. IP-address key
  names (`ip`, `ipAddress`, `client_ip`, `remoteAddr`, `x-forwarded-for`,
  etc.) are redacted via a new exact-match synonym allowlist rather than a
  plain substring check — a substring `"ip"` would also match `description`/
  `shipping`/`recipient`/`equipment`, which must NOT be redacted.

  New gate `bun run logging:lint:check` (`scripts/logging-lint-check.ts`,
  wired into `bun run check`) fails the build if the old raw
  `console.error`/`console.warn` pattern reappears in
  `src/pages/admin/**`, `src/pages/api/v1/**`, or `scripts/*.ts`.

  Public API response shape (`fail()`/`ok()`) is unchanged — verified no
  client-facing response ever included a raw `error.message`/`.stack`.

- ac6503e: Add deterministic build-time module composition (Issue #740, epic #738
  `platform-evolution`, Wave 1, ADR-0014) — a derived/downstream repository
  can now contribute its own application modules to the final, effective
  module registry without ever editing `src/modules/index.ts` or any base
  `module.ts`.

  `src/modules/application-registry.ts` is the single, designated build-time
  extension point: this base repository ships `undefined` there; a derived
  repository replaces that export with its own `ApplicationModuleRegistry`
  (`{ id, modules, migrationNamespace? }`, a new type in
  `src/modules/_shared/module-contract.ts`). Still 100% compile-time
  TypeScript, resolved by `bun run build`/`bun run typecheck` like any other
  import — no runtime discovery, file upload, package scanning, `eval`, or
  untrusted code loading (doc 21 §7 unchanged, not relaxed).

  `src/modules/module-management/domain/module-composition.ts` provides the
  composition API: `mergeModuleRegistries()` (pure concatenation, always
  succeeds — the only thing `src/modules/index.ts` itself calls, so a
  default base build produces the exact same effective registry as before
  this change), and `composeModuleRegistry()`/`validateComposedModuleRegistry()`
  (the rule engine, called explicitly by the new `bun run
modules:compose:check`, never embedded in module load). It composes and
  validates module keys/descriptors, the lifecycle dependency DAG (reusing
  the existing whole-registry validator, Issue #680), capability
  provides/consumes bindings, permission/navigation/job/health inventories,
  a declared migration namespace/range per application registry (base
  reserves `1-899`), and deployment-profile compatibility metadata (a new
  `ModuleCompatibilityContract.deploymentProfiles` field) — failing fast
  with actionable diagnostics on duplicate module keys, missing/cyclic
  dependencies, missing or conflicting capability providers, an invalid
  application module category, an overlapping migration namespace, an
  incompatible deployment-profile claim, a navigation path conflict, or an
  application registry attempting to shadow/replace any base module.

  New CI gates wired into `bun run check`: `bun run modules:compose:check`
  and `bun run modules:composition:inventory:generate`/`:check` (a
  deterministic, machine-readable composed-registry snapshot,
  `docs/awcms-mini/module-composition-inventory.json`, for CI/release
  evidence). `scripts/repo-inventory-generate.ts` now accepts an optional
  module list, proving repository inventory generation works in both
  base-only and composed-fixture modes without touching its default CLI
  behavior.

  A minimal in-repo fixture derived application
  (`tests/fixtures/derived-application-example/`, two modules) proves the
  whole mechanism end to end (`tests/unit/module-composition-fixture.test.ts`)
  without ever being wired into this repository's real
  `application-registry.ts`. `tests/unit/module-composition.test.ts` covers
  composition and every rejection class with synthetic descriptors.

  See `docs/adr/0014-deterministic-build-time-module-composition.md` for the
  full design decision, and `docs/awcms-mini/derived-application-guide.md`
  for the updated derived-application contributor flow.

- da88303: Eliminate the live `tenant_admin`/`profile_identity`/`identity_access`
  module dependency cycle and add a registry-wide DAG validator (Issue
  #680, epic #679).

  `tenant_admin`'s `dependencies` array previously listed
  `profile_identity`/`identity_access`, which — combined with those two
  modules' own (already-correct) dependency arrays — formed a live 3-node
  cycle that `domain/tenant-module-lifecycle.ts`'s existing
  `hasDependencyCycle` would reject if anyone ever tried to enable one of
  these three foundational modules through the normal lifecycle path.
  `tenant_admin.dependencies` is now `[]`: its one-time setup wizard's
  cross-module writes (into `profile_identity`/`identity_access` tables,
  in the same bootstrap transaction) moved from an implicit module
  dependency into `application/platform-bootstrap.ts`'s
  `bootstrapPlatformTenant`, an explicit composition-root function the
  route handler calls directly — behavior-identical, including the
  setup-once idempotency lock.

  A new registry-wide validator,
  `domain/module-dependency-graph.ts`'s `validateModuleDependencyGraph`,
  closes the gap that let this cycle go undetected: it checks the ENTIRE
  registry (not just one module being enabled) for self-dependencies,
  duplicate dependencies, missing dependency keys, and cycles
  (direct/indirect), reporting every distinct issue in one run. Wired
  into a new `bun run modules:dag:check` script (spliced into `bun run
check` right after `api:spec:check`) and into `bun run modules:sync`
  (refuses to sync a broken graph to the database mirror table).

- bfbbe4d: Add a database-backed, tenant-aware Module Management system (epic #510,
  Issues #511-#521): extends the code-only module registry
  (`src/modules/index.ts`) with a synced database registry
  (`awcms_mini_modules`/`_dependencies`/`_navigation`/`_jobs`/`_health_checks`,
  `sql/025`), tenant module lifecycle with server-side dependency
  validation (`POST /api/v1/tenant/modules/{moduleKey}/{enable,disable}`),
  non-secret tenant module settings
  (`GET/PATCH /api/v1/tenant/modules/{moduleKey}/settings`), module
  permission sync/status reporting
  (`GET /api/v1/modules/{moduleKey}/permissions`), an admin navigation
  registry (`module_management.navigation.read`, first real consumer of a
  permission seeded since Issue #512), a documentation-only operational job
  registry (`GET /api/v1/modules/{moduleKey}/jobs`), module health/readiness
  checks (`GET /api/v1/modules/{moduleKey}/health`,
  `POST .../health/check`, an explicit and bounded live provider check for
  `email`), and a full admin UI (`/admin/modules`,
  `/admin/modules/{moduleKey}`) covering every one of the above as a
  permission-gated panel. Also adds `enable`/`disable`/`check` to the ABAC
  action vocabulary, and enforces `403 MODULE_DISABLED` for any request to
  a tenant-disabled module directly in the shared access guard (not just
  the lifecycle endpoint itself). See `src/modules/module-management/README.md`.
- 58df253: Add reusable tenant module presets (Issue #565, epic #555): five named
  sets of modules (`online_website`, `news_portal`, `saas_online`, `pos_lan`,
  `minimal`) matching common deployment profiles, plus
  `applyModulePreset(tx, tenantId, actorTenantUserId, presetName)`
  (`src/modules/module-management/application/module-presets.ts`) — a plain
  callable service, no new API route or UI in this issue (that's #566/a
  future setup wizard step). Applying a preset both enables every listed
  module and disables every currently-enabled module that isn't listed and
  isn't protected, so a tenant actually reaches the target profile instead of
  only ever accumulating modules. "Protected" is computed generically
  (`domain/module-presets.ts`'s `resolveProtectedModuleKeys`) as every
  `isCore: true` module plus its full transitive dependency closure — in
  this registry, `module_management`'s own dependency closure
  (`tenant_admin`, `identity_access`, `profile_identity`). Every enable/disable
  still goes through the real `enableTenantModule`/`disableTenantModule`
  lifecycle validation (dependency graph, reverse-dependency protection,
  core-module protection) — never a direct `awcms_mini_tenant_modules` write.
  Idempotent: a module already in its target state is left untouched (no
  audit event); a module that can't be disabled because a still-enabled
  module transitively depends on it is skipped and reported, never
  force-disabled or silently dropped. One `tenant_module_enabled`/
  `tenant_module_disabled` audit event per module actually changed (never one
  aggregate "preset applied" event), tagged with `presetName`. Corrects the
  issue's own illustrative `workflow_approval` module key to the actually
  registered key, `workflow`. See
  `src/modules/module-management/domain/module-presets.ts`'s header comment
  for the full design rationale and
  `src/modules/module-management/README.md`'s "Tenant module presets"
  section.

  Post-review fix: the disable-planner's "stays enabled" base set previously
  only accounted for modules enabled before the plan ran, not modules the
  same plan is about to newly enable — so a disable candidate blocked only by
  a freshly-enabling dependent could slip through the pre-emptive skip check
  and surface as a spurious rejection from the real `disableTenantModule`
  call instead. Fixed by seeding that base set with the union of both, with
  a new regression test.

- 670c679: Add the R2-only news media object registry (Issue #633, epic
  `news_portal` #631-#642/#649) — `awcms_mini_news_media_objects`
  (migration `041`), tenant-scoped with `ENABLE`+`FORCE ROW LEVEL
SECURITY`, metadata-only (no binary columns), `storage_driver`
  constrained to `cloudflare_r2`. Adds object-key generation/validation
  and trusted public-URL construction
  (`src/modules/news-portal/domain/news-media-object-key.ts`) plus
  create/verify/attach/detach/soft-delete/restore/purge application
  helpers with audit events
  (`src/modules/news-portal/application/news-media-object-directory.ts`).
  No upload endpoint yet (Issue #634) — permission key constants for it
  are prepared (`domain/news-media-permissions.ts`) but not yet wired
  into the module descriptor.
- 3d9d937: Add the direct-to-R2 presigned upload flow for news images (Issue #634,
  epic `news_portal` #631-#642/#649): `POST
/api/v1/media/news-images/upload-sessions` (create — server-generated
  object key, short-lived presigned PUT URL, never a raw R2 credential),
  `POST .../{id}/finalize` (high-risk, `Idempotency-Key` required), and
  `POST .../{id}/cancel`.

  Closes the security-auditor Critical finding on Issue #631: `finalize`
  never promotes a media object to `verified` from a bare `HEAD` check.
  It performs a `HEAD` (existence + real size) followed by a full `GET`,
  sniffs the MIME type from the object's actual magic bytes
  (`domain/news-media-mime-sniffer.ts`, allow-list-only — JPEG/PNG/WebP/
  GIF), and computes a SHA-256 checksum server-side from the bytes
  actually read (`application/news-media-r2-verification.ts`,
  `domain/news-media-finalize-decision.ts`). A client-claimed checksum
  (optional) is compared only as a transport-corruption check, never as
  a substitute for the MIME sniff. Every R2 call (`Bun.S3Client`, no npm
  AWS/S3 SDK) runs strictly outside any DB transaction (ADR-0006), behind
  a dedicated `news-media-r2` circuit breaker + timeout
  (`infrastructure/news-media-r2-client.ts`).

  Adds migration `042` seeding the `news_portal.media.*` permission
  catalog (`create`/`read`/`verify`/`attach`/`detach`/`delete`/
  `restore`/`purge`/`cancel` — reusing Issue #633's `NEWS_MEDIA_PERMISSIONS`
  constants exactly, plus a new `cancel` permission for aborting one's own
  not-yet-uploaded session) and wires them into `news_portal`'s module
  descriptor (`permissions`, `api`) for the first time.

- 7eb1157: Add pending/orphan R2 media lifecycle cleanup and DB-vs-R2 reconciliation
  for the news-portal R2-only media registry (Issue #690, epic #679
  platform-hardening — "runtime/worker hardening" wave, following
  #691/#689/#694/#695/#687/#697).

  `bun run news-media:reconcile` (`scripts/news-media-r2-reconcile.ts`) is a
  new job built directly on the shared worker runner (`src/lib/jobs/
job-runner.ts`, Issue #697) from day one. It is a complete no-op unless
  `NEWS_MEDIA_R2_ENABLED=true`. Every run categorizes each active tenant's
  `awcms_mini_news_media_objects` rows against a real R2 bucket listing into
  five buckets: `healthy`, `orphanInDb` (DB expects an object R2 doesn't
  have — report-only, never auto-mutated), `expiredPending`
  (`pending_upload`/`uploaded`/`failed` rows past `NEWS_MEDIA_R2_PENDING_TTL_MINUTES`
  — R2 object deleted then the row hard-deleted), `staleOrphaned`
  (`status='orphaned'` rows past a new `NEWS_MEDIA_R2_ORPHAN_GRACE_DAYS`
  grace period, default/minimum 30 days — R2 object deleted then the row
  soft-deleted), and `orphanInR2` (an R2 object with no matching DB row at
  all — a real gap left by `purgeNewsMediaObject` never deleting its own R2
  object, closed asynchronously here).

  Every mutation is an atomic, guarded UPDATE/DELETE re-verified at the
  moment of the mutation — critically, `orphanInR2` candidates get an
  additional immediate point-lookup recheck (`objectKeyExistsForTenant`)
  right before deletion, so an object that just got a brand-new DB row
  between this run's snapshot and its delete step is never removed. Reruns
  are idempotent by construction (a cleaned-up row/object no longer matches
  the next run's candidate criteria). A per-tenant R2 listing failure is
  reported and skipped, never crashing the job or blocking another tenant's
  run or unrelated database work.

  `--dry-run` reports every category's counts with zero mutations.
  Migration 046 adds `awcms_mini_news_media_objects.orphaned_at` (tracks
  exactly when a row became orphaned, independent of `updated_at`) and grants
  the least-privilege `awcms_mini_worker` role (Issue #683) the DML this job
  needs. `config:validate` now enforces the new
  `NEWS_MEDIA_R2_ORPHAN_GRACE_DAYS` 30-day minimum
  (`checkNewsMediaR2OrphanGraceLowerBound`).

  No local filesystem fallback and no binary payload in PostgreSQL — this
  job only ever talks to Cloudflare R2 metadata/objects and
  `awcms_mini_news_media_objects` metadata, and never logs signed URLs,
  credentials, or object bytes.

  `docs/awcms-mini/news-portal/r2-backup-lifecycle.md` gains a new Operator
  SOP section; `18_configuration_env_reference.md`,
  `full-online-r2-architecture.md` §4, and `deployment-profiles.md`'s job
  registry/shared worker runner sections are updated to match.

- c92e2f7: Add Cloudflare R2 image delivery readiness checks for the news portal's
  R2-only media mode (Issue #635, epic `news_portal` #631-#642/#649).

  `bun run config:validate` now rejects a `NEWS_MEDIA_R2_ALLOWED_MIME_TYPES`
  allow-list containing any type outside the ones the MIME sniffer can
  actually recognize (JPEG/PNG/WebP/GIF/SVG — an unrecognized entry can
  never pass upload verification, so it is a misconfiguration, not just an
  unsafe default), and rejects a
  `NEWS_MEDIA_R2_PRESIGNED_UPLOAD_TTL_SECONDS` above 3600 seconds (a
  presigned PUT URL is reusable for its whole TTL, so an excessive expiry
  weakens that mitigation).

  `bun run security:readiness` adds two checks: a critical check that,
  when `APP_ENV=production`, rejects a `NEWS_MEDIA_R2_PUBLIC_BASE_URL`
  pointing at Cloudflare's default `*.r2.dev` domain or a loopback host
  (production must use a real custom domain — non-production is
  unaffected, by design); and a warning check that scans all tenants for
  `awcms_mini_news_media_objects` rows stuck in `pending_upload` past
  `NEWS_MEDIA_R2_PENDING_TTL_MINUTES`, surfacing that the automatic
  cleanup job this mode's architecture document describes has not been
  implemented yet.

- 5c905b9: Add R2-only advertisement placement presets for the news portal (Issue
  #638, epic `news_portal`).

  Tenants can now configure ads for twelve predefined placements
  (`header_banner`, `below_headline`, `homepage_middle`,
  `homepage_bottom`, `article_top`/`middle`/`bottom`,
  `sidebar_top`/`middle`/`bottom`, `category_archive_top`,
  `search_result_top`) via `POST/GET /api/v1/news-portal/ad-placements`
  and `PATCH/DELETE .../{id}` (also a new admin UI page,
  `/admin/news-portal/ad-placements`). Every ad's image must reference an
  already-verified Cloudflare R2 media object (Issue #633's registry) —
  there is no free-text image URL field at all, so a local path or
  arbitrary external image can never be configured; a non-conforming or
  cross-tenant reference is rejected with
  `422 AD_PLACEMENT_REFERENCE_INVALID` before anything is written. An
  optional (possibly external) link URL is validated server-side as an
  absolute `http`/`https` URL only — `javascript:`/`data:`/relative
  values are rejected. Inactive, not-yet-started, and expired ads are
  excluded from rendering. Four rotation modes are supported (`latest`,
  `priority`, `random_safe`, `weighted`), each capped to the placement's
  configured maximum item count at render time. Rendering emits only a
  whitelisted `<img>`/`<a>` fragment referencing the media registry's own
  server-generated public URL — never raw script/embed markup.

  This is a new table (`awcms_mini_news_portal_ad_placements`), separate
  from `blog_content`'s existing free-URL `awcms_mini_blog_ads` — the
  existing ads system is unchanged and remains available for tenants not
  using the full-online R2-only news portal mode. See the
  `awcms-mini-news-portal` skill's §638 section for the full reasoning.

- aaa083d: Add the `news_portal_full_online_r2` tenant module preset (Issue #632,
  epic `news_portal` #631-#642/#649) — the first concrete implementation
  step after Issue #631's architecture documentation.

  New module `news_portal` (`src/modules/news-portal/`, minimal descriptor
  only — no permissions/navigation/API/settings yet), a new tenant module
  preset `news_portal_full_online_r2` (bundling `blog_content` +
  `tenant_domain` + `visitor_analytics` + `module_management` +
  `identity_access` + `news_portal`, `module-management/domain/module-presets.ts`),
  and its activation readiness gate: `applyNewsPortalFullOnlineR2Preset`
  (`news-portal/application/apply-news-portal-preset.ts`) is the sanctioned
  entry point, requiring `NEWS_PORTAL_ENABLED=true`,
  `NEWS_PORTAL_PROFILE=full_online_r2`, and complete `NEWS_MEDIA_R2_*`
  config kept separate from `sync-storage`'s own `R2_*` credentials/bucket
  (enforced, not just documented) before delegating to the existing generic
  `applyModulePreset`. Every activation attempt (rejected or applied) is
  audited.

  New env vars (`.env.example`, doc 18 §News portal): `NEWS_PORTAL_ENABLED`,
  `NEWS_PORTAL_PROFILE`, and the `NEWS_MEDIA_R2_*` family
  (`ENABLED`/`ACCOUNT_ID`/`ACCESS_KEY_ID`/`SECRET_ACCESS_KEY`/`BUCKET`/
  `PUBLIC_BASE_URL`/`PRESIGNED_UPLOAD_TTL_SECONDS`/`MAX_UPLOAD_BYTES`/
  `ALLOWED_MIME_TYPES`/`PENDING_TTL_MINUTES`) — deliberately namespaced
  `NEWS_MEDIA_R2_*` rather than reusing `sync-storage`'s `R2_*` names (see
  architecture doc §2/§4 and `.claude/skills/awcms-mini-news-portal/SKILL.md`
  §632 for the full naming-reconciliation rationale). No new
  `DEPLOYMENT_PROFILE`/`BLOG_PUBLIC_ROUTE_MODE`/`BLOG_PUBLIC_BASE_PATH` env
  vars were added — those concepts already exist as other mechanisms
  (per-tenant `blog_content` settings, `PUBLIC_CANONICAL_BASE_PATH`, or
  simply don't exist as a real need in this repo's per-feature-flag
  convention).

  `bun run config:validate` and `bun run security:readiness` both cover the
  new preset's config (shape, conditional-required vars, and hard
  separation from `sync-storage`'s R2 config). No schema/migration changes
  in this issue — no local filesystem upload fallback exists or was added
  (structurally guarded by a new test, not a runtime flag).

- 4b6ccfc: Add an editorial homepage section composer for the `/news` public route
  (Issue #637, epic `news_portal`).

  Tenants can now configure ordered, schedulable homepage sections via
  `POST/GET /api/v1/news-portal/homepage-sections` and
  `PATCH/DELETE .../{id}` (also a new admin UI page,
  `/admin/news-portal/homepage-sections`), of six types: `headline`,
  `latest_posts`, `featured_posts`, `editor_picks`, `category_grid`, and
  `gallery_block`. Every post/category/media reference in a section's
  `config` must already exist for the same tenant, and — for
  `gallery_block` — be a verified Cloudflare R2 media object (Issue
  #633's registry); a non-conforming reference is rejected with
  `422 HOMEPAGE_SECTION_REFERENCE_INVALID` before anything is written. A
  tenant with no configured sections sees the exact pre-#637 `/news` page
  — this is purely additive. At render time, every reference is
  re-resolved against live data (a curated post that's since been
  unpublished, or a category/media object that's since been removed,
  silently disappears rather than erroring), and any rendered image
  always comes from resolved, verified R2 media metadata via the
  existing shared whitelisted renderer — never a raw or arbitrary image
  URL.

  `video_block`, `ad_slot`, `custom_widget_block`, and `static_page_block`
  from the issue's suggested section list are deliberately not
  implemented yet — they depend on surfaces (#638's R2-only ad images,
  #639's video block) that don't exist, or are explicitly out of scope
  (arbitrary HTML widgets), or would require a new public page-detail
  route (`static_page_block`) that isn't otherwise needed. See the
  `awcms-mini-news-portal` skill's §637 section for the full reasoning.

- d7facca: Add full SEO and social preview metadata for public news article sharing
  (Issue #649, epic `news_portal` #631-#642/#649): `/news/{slug}` and
  `/blog/{tenantCode}/{slug}` now render complete Open Graph metadata
  (`og:type=article`, `og:image` with `og:image:secure_url`/`og:image:type`/
  `og:image:width`/`og:image:height`/`og:image:alt`, `article:published_time`/
  `article:modified_time`/`article:section`/`article:tag`), Twitter/X
  `summary_large_image` Card metadata (including `twitter:image:alt`), a
  `<meta name="robots">` directive (`index,follow,max-image-preview:large`
  for public posts, `noindex,nofollow` for unlisted), and `NewsArticle`
  JSON-LD structured data (headline/description/image/dates/author/publisher/
  mainEntityOfPage), all safely escaped (including inside the JSON-LD
  `<script>` tag).

  The social/SEO preview image is resolved through a strict priority chain —
  an explicit per-post SEO image override (new `seoImageMediaId` field),
  then the featured image, then the first verified R2 image found in the
  post's own content (if the tenant allows), then a tenant-level R2 fallback
  image — every source re-verified against the existing R2-only media
  registry (Issue #636) at render time; `og:image`/`twitter:image`/JSON-LD
  `image` are always either a verified Cloudflare R2 object or omitted
  entirely, never a local path or arbitrary external URL. Draft/private/
  review/archived/soft-deleted/scheduled-future content never renders any of
  this metadata (it 404s before rendering starts, unchanged from before).

  The content quality checklist (Issue #640) gains two new advisory rules,
  `social_preview_image_ready` and `social_preview_image_alt_text`, using the
  exact same resolution chain the render route uses. RSS feeds and the news
  sitemap now include the resolved preview image (`<enclosure>` /
  `<image:image>`) when one is available.

- c33b08e: Add public social share buttons and expanded Open Graph/Twitter Card
  metadata for published news articles (Issue #642, epic `news_portal`
  #631-#642/#649): native Web Share API, copy-link, WhatsApp, Telegram,
  Facebook, LinkedIn, X, and email on `/news/{slug}` and
  `/blog/{tenantCode}/{slug}` — every link built from the server-resolved
  canonical URL only (never the request's raw querystring/tracking
  parameters), `rel="noopener noreferrer"` on all external links, no
  third-party script loaded (native share/copy-link is a small same-origin
  static file, `public/js/news-share.js`). Instagram has no supported
  web-share URL, so it is never a fake button — only a short note pointing
  to native share/copy-link. Adds `og:title`/`og:description`/`og:url`/
  `og:site_name` and `twitter:title`/`twitter:description`/`twitter:card`
  to the public page shell (derived from the same title/description/
  canonical URL fields already rendered — `og:image`/`twitter:image` remain
  gated on a verified R2 media object per Issue #636). New per-platform
  `NEWS_SHARE_*_ENABLED` config flags (all default `true`) let operators
  disable the widget or a specific platform.
- ec2d93d: Add a safe `video_news` content block for `blog_content` posts/pages
  (Issue #639, epic `news_portal`).

  A `video_news` block (`{ provider, videoId, title?, caption?,
thumbnailMediaObjectId?, durationSeconds?, sourceLabel? }`) is now a
  recognized `content_json` block type, alongside paragraph, heading,
  list, quote, and gallery. `provider` is validated against an allowlist
  (currently only `youtube`) and `videoId` is validated/normalized
  server-side from either a bare video id or a common YouTube URL form
  (`watch?v=`, `youtu.be/`, `/embed/`, `/shorts/`) — unconditionally, for
  every tenant, independent of full-online R2-only mode. Every
  `video_news` block is rebuilt at write time from only its known fields,
  so no unrecognized field (e.g. a smuggled raw embed field) is ever
  persisted; a request with an unsupported provider or an invalid/
  malformed `videoId` is rejected with `400 VALIDATION_ERROR`.

  The block's optional custom `thumbnailMediaObjectId` follows the exact
  same R2-only-mode-gated policy Issue #636 established for
  `featuredMediaId` and gallery images: when full-online R2-only mode is
  active for the tenant, a present thumbnail reference must resolve to an
  existing, same-tenant, `verified`/`attached` R2 media object — a
  cross-tenant, deleted, or unverified reference is rejected with
  `422 NEWS_MEDIA_REFERENCE_INVALID`. A missing thumbnail is never an
  error (a custom thumbnail is optional). This check is enforced at
  post/page create and update, and at revision restore.

  The public post detail routes (`/news/{slug}`,
  `/blog/{tenantCode}/{slug}`) render a `video_news` block as a safe
  `<iframe>` embed built only from the validated `provider`+`videoId`
  (YouTube's privacy-enhanced `youtube-nocookie.com` embed domain,
  also allow-listed in the CSP `frame-src` directive) — never from any
  raw HTML the client submitted. The resolved custom thumbnail, when one
  verifies successfully, is rendered as a separate `<img>` alongside it.

- a5c335d: Add public `/news` routes for `blog_content` (Issue #560, epic #555):
  `src/pages/news/{index,[slug],category/[slug],tag/[slug],search,feed.xml,sitemap-news.xml}.ts`
  — the tenant-code-free counterpart of `/blog/{tenantCode}` (ADR-0009,
  still unchanged and unremoved). Reuses every existing public
  application/domain service unchanged (`public-blog-directory.ts`,
  `public-page-rendering.ts`, `seo-rendering.ts`, `content-block-rendering.ts`,
  `blog-search.ts`'s `searchPublicBlogContent`, `error-responses.ts`); the
  only difference is tenant resolution, via a new shared helper
  `withNewsTenant()` (`src/modules/blog-content/application/public-news-tenant-resolution.ts`)
  that calls `resolvePublicTenantFromRequest` (Issue #559) instead of
  resolving from a `tenantCode` path segment, and additionally enforces a
  module-disabled gate (`blog_content` disabled for the resolved tenant now
  404s exactly like an unresolved tenant) — an explicit Issue #560
  acceptance criterion that does not yet exist for the legacy
  `/blog/{tenantCode}` routes (documented as a follow-up candidate, not
  retrofitted here).

  Also resolves an ambiguity flagged by two reviewers on Issue #559:
  `resolvePublicTenantFromRequest()` (`src/lib/tenant/public-host-tenant-resolver.ts`)
  now returns `null` unconditionally for `PUBLIC_TENANT_RESOLUTION_MODE=tenant_code_legacy`,
  skipping the entire env/setup fallback chain instead of only the
  host-lookup step — that mode means "no default tenant guess, every route
  must carry its own `tenantCode`", which `/news` structurally cannot
  satisfy. Leaving `PUBLIC_TENANT_RESOLUTION_MODE` unset (today's
  offline/LAN default) is unaffected and still uses the full safe-fallback
  chain.

  Pure refactor, no behavior change for existing `/blog/{tenantCode}` call
  sites: `public-page-rendering.ts`'s `renderPostSummaryListHtml` now
  delegates to a new, more general `renderPostSummaryListHtmlAtBasePath`.

- 93c2f08: Add a provider-neutral, privacy-safe metrics port for operational
  observability (Issue #698, epic #679 platform-hardening) —
  `src/lib/observability/metrics-port.ts` (`MetricsPort` contract,
  `METRIC_DEFINITIONS` cardinality/privacy registry,
  `recordCounter`/`recordHistogram`/`recordGauge`), a default no-op adapter
  (zero I/O, zero external collector needed for offline/LAN deployments), an
  in-memory adapter for tests, and a dependency-free Prometheus text-
  exposition adapter example
  (`src/lib/observability/adapters/prometheus-text-adapter.ts`, not wired up
  by default).

  Hooked into the existing shared mechanisms, not duplicated per call site:
  `http_requests_total`/`http_request_duration_ms` from `src/middleware.ts`
  (via `context.routePattern`, never a concrete request id);
  `job_run_total`/`job_run_duration_ms`/`job_run_item_count` from
  `src/lib/jobs/job-runner.ts`'s single `buildResult` choke point;
  `provider_call_total`/`provider_call_duration_ms`/`provider_circuit_state`
  from a new `decorateWithMetrics` wrapper around
  `getDatabaseCircuitBreaker`/`getProviderCircuitBreaker`
  (`src/lib/database/circuit-breaker.ts`), which also adds
  `deriveProviderFamilyLabel` to keep a tenant-scoped breaker registry key
  (Issue #610 shape) from ever reaching a metric label; and
  `db_pool_work_class_active`/`db_pool_work_class_queued` from
  `src/lib/database/work-class.ts`.

  Adds a new authorized endpoint `GET /api/v1/logs/observability/dependency-health`
  (permission `logging.observability.read`, migration
  `047_awcms_mini_observability_metrics_permission.sql`) distinguishing
  local dependencies (database) from optional external providers (email,
  object storage, SSO/OIDC, Cloudflare DNS, …), aggregated by the same
  bounded provider family label the metrics use — never a raw registry key
  or tenant id.

  See `docs/awcms-mini/observability-metrics.md` for architecture, the
  per-metric cardinality/privacy review, initial SLIs/SLOs with burn-rate
  guidance, dashboard/runbook examples, and the optional Prometheus/
  OpenTelemetry adapter pattern.

- 35476bb: Add config-only support for online public tenant routing (Issue #556,
  epic #555): `PUBLIC_TENANT_RESOLUTION_MODE`
  (`host_default`/`env_default`/`setup_default`/`tenant_code_legacy`),
  `PUBLIC_DEFAULT_TENANT_ID`, `PUBLIC_DEFAULT_TENANT_CODE`,
  `PUBLIC_CANONICAL_BASE_PATH` (default `/news`), `PUBLIC_TRUST_PROXY`
  (safe default `false`), and `PUBLIC_PLATFORM_ROOT_DOMAIN`. `bun run
config:validate` (`scripts/validate-env.ts`) now enforces the mode enum,
  `host_default` requiring `PUBLIC_PLATFORM_ROOT_DOMAIN`, `env_default`
  requiring at least one of `PUBLIC_DEFAULT_TENANT_ID`/
  `PUBLIC_DEFAULT_TENANT_CODE`, and `PUBLIC_CANONICAL_BASE_PATH` being an
  absolute path — while leaving every new var unset still passes
  `config:validate`, so existing offline/LAN deployments are unaffected.
  Documented in `docs/awcms-mini/18_configuration_env_reference.md` §Public
  routing and `docs/awcms-mini/deployment-profiles.md` §Profil online, with
  an explicit security note that `PUBLIC_TRUST_PROXY=true` must only be set
  behind a trusted reverse proxy (a future host-based resolver, Issue #559,
  would otherwise trust a spoofable `X-Forwarded-Host` header). No
  tenant-domain schema, `/news` routes, or Cloudflare DNS integration in
  this issue — those land in epic #555's remaining child issues
  (#557-#567).
- f8cbd18: Split the public OpenAPI contract into per-module source fragments and enforce route-operation-security parity (Issue #695, epic #679, platform-hardening).

  `openapi/awcms-mini-public-api.openapi.yaml` was a single 13,587-line hand-edited file — the existing `scripts/api-spec-check.ts` checker (Issue #685) verified basic shape, route-method parity, and the public-operation allow-list, but nothing proved every route method, operation ID, request schema, and security requirement matched the implementation exhaustively, and nothing stopped the file itself from growing further.

  The contract is now split by the spec's own existing `tags` (already a clean 1:1 module boundary — every operation has exactly one tag, and every path's operations share that tag) into `openapi/awcms-mini-public-api.src.yaml` (root: `info`/`servers`/`tags`/`security`, `components.securitySchemes`/`parameters`/`responses`, and any schema shared by 2+ modules) plus one `openapi/modules/<module-key>.openapi.yaml` fragment per module/tag (26 files) owning that module's `paths` and module-exclusive `components.schemas`. New `scripts/openapi-bundle.ts` (`bun run openapi:bundle`) merges every fragment — module files loaded in a fixed alphabetical-by-filename order, paths and schemas re-sorted alphabetically on output — into the SAME published path, `openapi/awcms-mini-public-api.openapi.yaml`, which is now a GENERATED artifact (do not hand-edit). Bundling twice against unchanged sources is byte-identical (`tests/unit/openapi-bundle.test.ts`).

  `scripts/api-spec-check.ts` gains five checks, additive to the Issue #685 checks (none removed or rewritten):

  - `checkBundleFreshness` — the committed bundle must exactly match what `bun run openapi:bundle` produces right now from the source fragments.
  - `checkOperationIdUniqueness` — every `operationId` must be globally unique (names both colliding locations on failure).
  - `checkPathParameters` — every `{param}` in a path template must have exactly one matching `in: path, required: true` parameter declaration, and vice versa.
  - `checkStandardErrorSchema` — every non-2xx/3xx response must resolve (directly, via `components.responses`, or through `allOf`/`oneOf`/`anyOf`) to the shared `ApiError` schema (`src/modules/_shared/api-response.ts`'s `fail()` envelope) rather than an ad-hoc inline error shape.
  - `checkOperationSecurityMetadata` — extends (does not duplicate) the Issue #685 `checkPublicOperationAllowlist`: that check only handles explicit `security: []`; this one fails an operation that omits `security` entirely and isn't allow-listed, and validates every named scheme in a `security` requirement actually exists in `components.securitySchemes`.

  `checkRouteParity`'s existing route-file/OpenAPI-operation parity is unchanged, and gains an explicit, reviewed `ROUTE_PARITY_EXEMPTIONS` list (same pattern as `CONFIG_EXEMPTIONS`, Issue #689, and `DYNAMIC_KEY_FAMILIES`, Issue #694) for a route deliberately internal or feature-flag-gated and not part of the public contract — empty today, every existing route already has a matching operation.

  **One deliberate, explicitly-called-out API contract change** (not a silent side effect of the split): the top-level `tags` array was missing a "Tenant Domains" entry even though 7 operations already used that tag (`GET/POST/PATCH/DELETE /api/v1/tenant/domains*`, epic #555) — a pre-existing documentation gap this split's tag-usage analysis surfaced. Added the tag declaration (name + description) alongside the existing tags; no path, schema, or security requirement changed. Verified: parsed old vs. newly bundled spec are deep-equal in every respect except this one array insertion (checked programmatically, not by line-diff, given the file's size).

  New tests: `tests/unit/openapi-bundle.test.ts` (determinism against the real fragments, freshness against the committed bundle, and synthetic fixtures for ordering/duplicate-path/duplicate-schema detection) and additions to `tests/unit/api-spec-check.test.ts` (fixtures proving each new check fails on the drift shape it targets, including one exercising the intentional overlap between `checkPublicOperationAllowlist` and `checkOperationSecurityMetadata` without duplicating assertions). `openapi/README.md`, `.claude/skills/awcms-mini-new-endpoint/SKILL.md`, `docs/awcms-mini/examples/minimal-domain-module.md`, and `AGENTS.md` document the new edit-fragment-then-bundle workflow.

- d55674d: Add `organization_structure`, a brand new optional, tenant-scoped organization-structure foundation module (Issue #749, epic `platform-evolution` #738 Wave 2, admission decision `docs/adr/0016-organization-structure-module-admission.md`).

  - Tenant-scoped legal entities (`awcms_mini_legal_entities`) — generic opaque registration-identifier pair (never a government-specific field like NPWP/SIUP), status, effective dates, soft-delete/deactivate only. Demonstrably distinct from the tenant itself (ADR-0013 §2).
  - Tenant-configurable organization-unit types (`awcms_mini_organization_unit_types`) and effective-dated organization units (`awcms_mini_organization_units`), each optionally linked to a legal entity (never required) and optionally typed.
  - A versioned/effective-dated (SCD Type 2 style) parent-child hierarchy (`awcms_mini_organization_unit_hierarchies`) — reparenting never mutates a `parent_id` column in place, it closes the current open edge and opens a new one. No-cycle/self-parent validation runs transactionally in the SOLE write path (`reparentUnit`), guarded by a tenant-wide `pg_advisory_xact_lock` plus a `SELECT ... FOR UPDATE` on the affected edge to close the concurrent-reparent race.
  - Operational locations (`awcms_mini_operational_locations`, optional lat/lng validated to `[-90,90]`/`[-180,180]`), an explicit location-to-unit many-to-many relationship (`awcms_mini_location_unit_relationships`), and effective-dated party/unit assignments (`awcms_mini_organization_unit_assignments`) referencing `identity_access`'s existing tenant users — never a duplicate person/party registry.
  - Tenant-safe CRUD/list/search (keyset-paginated), a hierarchy tree endpoint, and an as-of query parameter for hierarchy/assignment/relationship history. Every high-risk mutation — reparent, deactivate/soft-delete/restore a legal entity/unit-type/unit/location, and end an assignment/location-unit relationship — requires `Idempotency-Key` and is audited (`critical` for reparent, `info`/`warning` for the rest).
  - Accessible admin UI screens for legal entities, unit types, units, hierarchy (list + reparent form), locations, and assignments.
  - A REAL implementation of `BusinessScopeHierarchyPort` (`_shared/ports/business-scope-hierarchy-port.ts`) for `scopeType` `"legal_entity"`/`"organization_unit"`, walking the real effective-dated hierarchy — `identity_access` has no lifecycle or capability dependency on this module in either direction (Core never depends on Optional).
  - **Breaking change to `BusinessScopeResolution`** (Issue #746's port, low blast radius): `ancestorScopeIds`/`descendantScopeIds: string[]` replaced with `ancestorScopes`/`descendantScopes: BusinessScopeReference[]` (`{ scopeType, scopeId }`) to support heterogeneous ancestry (an organization unit's ancestor chain can legitimately terminate at a different-typed legal entity). `identity-access`'s flat "office" default adapter updated to the new shape; its only real caller reads `.resolved` only and needed no logic change.
  - Organization lifecycle events published to `domain_event_runtime` (Issue #742) as a real producer, same pattern as `workflow_approval` (Issue #747): `legal-entity.{created,updated,deactivated}`, `unit.{created,updated,deactivated}`, `hierarchy.changed`, `assignment.{created,ended}`.
  - Metrics: active units, hierarchy max depth, and expiring-soon assignments (gauges, sampled by a new read-only scheduled job `bun run organization-structure:metrics-snapshot`); invalid/cyclic hierarchy attempts (counter, incremented inline on every validator rejection).

  Out of scope (explicit): tenant provisioning/subscription management; chart of accounts, inventory/warehouse stock, HR, payroll, tax, government-specific organization rules; treating branch/legal entity as an RLS tenant boundary; a hard runtime dependency on the future `data_exchange` import contract (#750/#752).

- 781befe: Add a reproducible performance suite (Issue #744, epic #738
  platform-evolution): deterministic synthetic multi-tenant fixtures
  (`src/lib/performance/fixture-generator.ts`/`fixture-seeder.ts`, safe/
  standard/large scale profiles, one designated noisy-neighbor tenant),
  load/mixed-workload/saturation-and-recovery scenarios covering every
  work class (`bun run performance:suite`, reusing the resilience-drill
  scenario-runner and safety interlock unchanged), and versioned
  query-plan regression budgets for RLS-scoped pagination, full-text
  search, outbox claim, retention-purge, and reporting queries
  (`bun run performance:query-plan:check`), including an adversarial
  regression fixture proving the gate genuinely fails a bad plan against
  real PostgreSQL. Both commands produce a redacted machine-readable JSON
  report plus a human Markdown summary, documenting hardware/container/
  database configuration so results are comparable release-to-release.
  The safe subset (small deterministic fixtures, five fast scenarios, six
  query-plan budgets) runs on every PR via `.github/workflows/ci.yml`'s
  `quality` job; the heavier `--full` lane (large fixture scale plus a
  soak-stability scenario) is documented for scheduled/manual runs only.
  See `docs/awcms-mini/performance-suite.md`.
- 23a5505: Make `bun run production:preflight` non-destructive by default (Issue #684, epic #679, platform-hardening).

  `db:migrate` previously ran as an early, unconditional stage — a later stage failing (spec check, tests, build) still left the target database migrated, even though the preflight's own final verdict was "GO-LIVE DIBLOKIR". `bun run production:preflight` is now entirely read-only: `config:validate`, `security:readiness`, a new `db:connectivity` check (confirms the database is reachable via a single `SELECT`, never a write), `api:spec:check`, `test`, `build`, `db:pool:health` (now blocks go-live if skipped when `APP_ENV=production`, rather than silently passing), and a new `migration:plan` dry-run stage that reports exactly which migrations are pending without applying them.

  Applying migrations is now a separate, explicit, gated action: `--apply-migrations --backup-verified --acknowledge-target=<APP_ENV value>`. All three flags are required together, the apply step only runs if every read-only stage passed, and `--acknowledge-target` must match `APP_ENV` exactly (a typo-catcher against accidentally targeting the wrong environment). `--json-output=<path>` optionally writes a structured `{ go, results, plan, applied }` result for deploy-evidence retention.

  New runbook (`docs/awcms-mini/production-preflight-runbook.md`) documents the full staging-rehearsal → backup-evidence → apply → rollback procedure.

- a9560f0: Complete the `profile_identity` module (Issue #748, epic #738
  platform-evolution Wave 2) into a full canonical party lifecycle: person/
  organization CRUD/list/search/archive/restore, effective-dated identifiers
  with provenance/verification/masking, effective-dated addresses/
  communication channels, generic (non-hardcoded) party-to-party
  relationships and authorized-representative records, deterministic +
  heuristic duplicate-candidate detection (always reviewable, never
  auto-merging), and an approval-gated, idempotent, concurrency-safe merge
  workflow with immutable merge history. Adds a `PartyDirectoryPort`
  capability (ADR-0011) and a `profile.merged` domain event (via
  `domain_event_runtime`, Issue #742) so future domain modules can reference
  parties without importing profile tables directly. Cross-tenant matching/
  merge is strictly prohibited, enforced at both RLS and application layers.
  New migration `059`, admin UI (`/admin/profile-identity`), OpenAPI/AsyncAPI
  updates, and en/id i18n catalogs.
- 3079973: Add the public host tenant resolver (Issue #559, epic #555):
  `src/lib/tenant/public-host-tenant-resolver.ts` resolves the public tenant
  for anonymous requests from `Host`/domain/subdomain, then falls back
  safely to `PUBLIC_DEFAULT_TENANT_ID` -> `PUBLIC_DEFAULT_TENANT_CODE` ->
  `awcms_mini_setup_state.tenant_id` -> generic `null` (404). Host-based
  lookup only runs when `PUBLIC_TENANT_RESOLUTION_MODE=host_default`; the
  env/setup fallback chain always runs regardless of mode, so existing
  offline/LAN deployments that never set `PUBLIC_*` never touch the new
  lookup path at all. `X-Forwarded-Host` is read only when
  `PUBLIC_TRUST_PROXY=true` is explicitly passed by the caller. Every
  failure case (unknown host, non-`active` domain status, soft-deleted
  domain, inactive tenant) returns an identical `null` — no distinguishable
  signal.

  Adds `sql/033_awcms_mini_tenant_domain_lookup_function.sql`, a narrowly
  scoped `SECURITY DEFINER` function
  (`awcms_mini_resolve_tenant_domain_lookup`) that closes the RLS bootstrap
  gap flagged in migration 031: it is the single sanctioned read path for
  `hostname -> tenant` before any tenant context exists. It joins the
  already-RLS-free `awcms_mini_tenants` row into the same call (no new
  privilege exposure — those columns are unconditionally public already)
  so `resolvePublicTenantByHost` completes in exactly one DB round trip for
  every outcome, closing a timing side-channel an earlier version had
  between "unmapped host" and "mapped but inactive tenant". `EXECUTE` is
  `REVOKE`d from `PUBLIC` and granted only to `awcms_mini_app`. `FORCE ROW
LEVEL SECURITY` remains on `awcms_mini_tenant_domains` — direct queries
  against the table from the app role still return zero rows without a
  tenant GUC, proven alongside the function's bypass behavior and its
  single-round-trip property in
  `tests/integration/public-tenant-resolution.integration.test.ts`.

  `X-Forwarded-Host` handling also hardens against a misconfigured/spoofed
  multi-value header: if it ever contains more than one comma-separated
  value (never expected for this repo's documented single-trusted-proxy
  topology), the resolver does not guess which entry is trustworthy — it
  logs the anomaly and falls back to the plain `Host` header, exactly as if
  `PUBLIC_TRUST_PROXY` were `false` for that request. The requirement that a
  trusted proxy must fully overwrite (never append to) `X-Forwarded-Host` is
  now documented as binding in
  `docs/awcms-mini/18_configuration_env_reference.md`,
  `docs/awcms-mini/deployment-profiles.md`, and the
  `awcms-mini-tenant-domain-routing` skill.

  A general "Using `SECURITY DEFINER`" checklist (owner-is-superuser
  verification, static/parameterized body, minimal returned columns,
  explicit `EXECUTE` grant, `search_path` pinning, empirical verification,
  timing-side-channel awareness) is added to
  `docs/adr/0003-postgresql-rls-multi-tenant.md` and the
  `awcms-mini-new-migration` skill, referencing migration 033 as the
  canonical example, so future `SECURITY DEFINER` functions in this repo
  don't have to rediscover these rules from scratch.

  Library only — not yet consumed by any route/endpoint (that is Issue
  #560's `/news` routes). Covered by
  `tests/unit/public-host-tenant-resolver.test.ts` and
  `tests/integration/public-tenant-resolution.integration.test.ts`.

- 05cb74c: Add `reference_data`, a brand-new Official Optional Module providing a provider-neutral reference-data foundation (Issue #750, epic `platform-evolution` #738 Wave 3, ADR-0021).

  - Effective-dated, localized value sets and codes (`awcms_mini_reference_value_sets`/`_codes`/`_code_translations`) with provenance, deprecation/supersession — GLOBAL tables (no `tenant_id`, reviewed RLS-exempt, same convention as `awcms_mini_permissions`/`awcms_mini_idn_admin_regions`), identical for every tenant by design.
  - A tenant-scoped override/extension layer (`awcms_mini_reference_tenant_codes`/`_translations`, RLS FORCE, predicate always and only `tenant_id`) that never mutates the global baseline — precedence between baseline and tenant override is deterministic and enforced server-side by each value set's `overridePolicy` (`none`/`tenant_extend`/`tenant_override`/`tenant_extend_and_override`).
  - A validated import pipeline (`awcms_mini_reference_imports`): non-mutating dry-run/diff, commit that re-validates checksum and destructive-replace protection inside the same transaction as the write, and a bounded rollback. A code already referenced by tenant data can never be deleted or destructively repurposed — only deprecated/superseded.
  - A static module-contribution mechanism (`ModuleDescriptor.referenceData.contributesValueSets`) letting other modules register their own reference catalogs without direct table imports, validated by `bun run reference-data:contributions:check` (wired into `bun run check` and CI) and synced via `bun run reference-data:contributions:sync`. Ships currency/unit-of-measure/fiscal-calendar as neutral, non-authoritative example contributions of its own mechanism.
  - A `ReferenceDataPort` capability port for resolving codes/snapshots for other modules to consume.
  - Full CRUD/search/version/history/preview REST API (`/api/v1/reference-data/*`, tag `Reference Data`) and admin UI (`/admin/reference-data/value-sets`, `/codes`, `/tenant-codes`) — every mutation endpoint (create/update/deprecate/restore/import dry-run/commit/rollback) requires `Idempotency-Key` and is audited.
  - Two new `AccessAction` literals (`commit`, `rollback`, both `HIGH_RISK_ACTIONS`), additive-only to `identity-access/domain/access-control.ts`.
  - `idn_admin_regions` remains module-owned and is not duplicated or migrated into this module (ADR-0021 §4).
  - Security-review hardening (pre-release, same unreleased module): `createTenantReferenceCode` now checks the submitted `code` against the real base row/global baseline before classifying `kind`, closing a policy-bypass gap where an "override" could disguise a brand-new code (mismatched `code` vs. `baseCodeId`'s real code, rejected as `code_mismatch_with_base_code`) or an "extension" could silently shadow an existing baseline code (`code` already present in the global baseline, rejected as `code_collides_with_baseline`) even under a policy that forbids it. `validateReferenceMetadata` and the import path (`validateImportPayloadShape`, which now also applies the same `code`/`labels`/`metadata` validators the manual create/update path does) reuse `findSecretShapedValues` (`_shared/redaction.ts`) to reject credential-shaped metadata values (API key, JWT, PEM private key, Bearer/Basic token, connection string), not just a bespoke SQL/template/XSS regex. `restoreReferenceCode` also now rejects restoring a `managed_by_descriptor` code, consistent with create/update/deprecate.
  - Security-review hardening #2 (pre-release, same unreleased module, High severity): five mutation endpoints computed their `Idempotency-Key` request hash from an empty or partial object (`imports/{importId}/rollback`, `value-sets/{key}/restore`, `tenant-codes/{id}/restore`, `value-sets/{key}/codes/{code}/restore` all hashed `{}`; `imports/{importId}/commit` hashed only `{ checksum }`) without folding in the path parameter(s) identifying which resource was being mutated. Since the idempotency store key is `(tenant_id, request_scope, idempotency_key)` and `request_scope` is shared across every resource of a type in the tenant, a client that reused the same `Idempotency-Key` for two different resources of the same type (e.g. two different import batches) would have the second request incorrectly replay the first resource's cached response instead of being rejected or executed — silently reporting success for a resource that was never touched. All five now hash the identifying path parameter(s) plus an explicit `action` literal (matching the existing convention in `blog/posts/{id}/restore`, `social-publishing/jobs/{id}/retry`, `domain-events/deliveries/{id}/replay`), so a reused key across different resources now correctly yields `409 IDEMPOTENCY_CONFLICT` instead of a false replay. Also closed a related gap in `imports/{importId}/commit` and `imports/{importId}/rollback`: both resolved the URL's `{key}` only to 404 on an unknown value set, then operated on `{importId}` without verifying the resolved import batch's `value_set_id` actually matched — an `importId` from one value set could be committed/rolled back through a different value set's URL. Both now 404 on that mismatch (`fetchReferenceImportById` ownership check), mirroring the two-direction ownership check in `application/tenant-code-directory.ts`.
  - Security-review hardening #3 (pre-release, same unreleased module, High severity — same defect class as #2, missed in that pass): six sibling mutation endpoints had the identical gap: `value-sets/{key}` `PATCH`/`DELETE`, `tenant-codes/{id}` `PATCH`/`DELETE`, and `value-sets/{key}/codes/{code}` `PATCH`/`DELETE` all computed `computeRequestHash(body)` with no resource-identifying path parameter folded in, so reusing an `Idempotency-Key` across two different value sets/tenant codes/codes with an identical-shaped body would replay the wrong resource's cached response instead of a clean `409` or the real mutation. Unlike the pure action-triggers fixed in round #2, these are `PATCH`/`DELETE` endpoints where the body content is itself part of what must be verified for a safe replay, so the hash now folds in both the body and the identifying path parameter(s) plus an explicit `action` literal, e.g. `computeRequestHash({ ...body, key, action: "update" })` — never dropping the body. Adds adversarial integration tests (`tests/integration/reference-data.integration.test.ts`) proving that reusing an Idempotency-Key across `PATCH`/`DELETE` of two different value sets with the same-shaped body yields `409 IDEMPOTENCY_CONFLICT`, that the second value set is left untouched by the false-replay attempt, and that it still applies correctly once given its own key.

  See `docs/adr/0021-reference-data-module-admission.md` and `src/modules/reference-data/README.md`.

- 06f4b76: Add end-to-end release automation (Issue #692, epic #679, platform-hardening): a least-privilege, reproducible pipeline from Changeset to a verifiable production image.

  - **PR-time gate** (`.github/workflows/changesets.yml`, `scripts/changeset-policy-check.ts` → `bun run changesets:policy:check`): fails a PR that changes any non-`docs/**`/non-`.claude/**`/non-Markdown file without adding a new `.changeset/*.md`, and validates that new changeset's frontmatter (`"awcms-mini": major|minor|patch`). The exempt/non-exempt path split is derived from this repo's own merged-PR history (PR #595/#585 docs-only, no changeset; PR #707/#701/#609 with CI/scripts/source changes, all carried one).
  - **Tag-triggered release** (`.github/workflows/release.yml`):
    - `validate` job: refuses to release from a tag whose commit is not an ancestor of `origin/main` (this repo has no branch protection rule configured — see `docs/awcms-mini/branch-protection.md`); `bun run release:verify` (`scripts/release-verify.ts`) confirms the tag's version matches `package.json`, `CHANGELOG.md` has that version's section, and no changesets remain unconsumed; then re-runs the full `bun run check` quality gate against a real migrated Postgres.
    - `build` job (unprivileged: `contents: read`/`packages: write` only): builds `Dockerfile.production`, generates two CycloneDX SBOMs (source tree + built image, via `anchore/sbom-action`/Syft — a self-contained non-npm tool, so it never conflicts with this repo's Bun-only rule), computes checksums, uploads them as a workflow artifact.
    - `sign-attest-publish` job (gated behind a `release` GitHub Environment — required reviewers are a repo-admin step, documented not self-applied): signs the image with `cosign` keyless OIDC, attests SLSA-compatible build provenance and SBOM (`actions/attest-build-provenance`, `actions/attest-sbom`) for both the image and the source artifacts, pushes to `ghcr.io/ahliweb/awcms-mini`, and creates the GitHub Release with all artifacts attached. Split from `build` so the third-party `anchore/sbom-action` never runs in a job holding `id-token`/`attestations` credentials.
    - `workflow_dispatch` (no inputs, any branch) runs the identical pipeline as a rehearsal against a throwaway `dryrun-<sha>` image tag — no GitHub Release is created and `:latest` is never touched, so it can be run safely before the first real release.
  - Every third-party action is pinned by full commit SHA; permissions are minimal and scoped per job (`packages: write`/`id-token: write`/`attestations: write` only on the publish job).
  - Consumers verify signature/attestation/SBOM/checksums without any repository secret — `gh attestation verify`, `cosign verify`, and `sha256sum -c` all work against public registry/Sigstore data (exact commands in `docs/awcms-mini/release-process.md` §Verification).
  - New docs: `docs/awcms-mini/release-process.md` (pipeline, SBOM tool rationale, environment-approval manual step, dry-run/rehearsal, verification commands, rollback/yank guidance); `docs/awcms-mini/branch-protection.md` gained the new PR-gate check row; `.claude/skills/awcms-mini-release/SKILL.md` updated to describe the now-automated tag → publish path.

- 1fe4541: Add a generated repository inventory and docs CI checks, and reconcile status/version claims (Issue #688, epic #679, platform-hardening).

  A 2026-07-11 static repo audit found real docs/reality drift: a GitHub snapshot dated 2026-07-09 claiming 6 open issues while 33+ (now 35, re-verified live) were actually open; `SECURITY.md` still describing a "first target 0.1.0" while `package.json` had already reached `0.23.5` and the base generic backlog was complete; `CONTRIBUTING.md` and doc 08 naming the Docker Compose Postgres service `postgres` while the actual service is `db`; and a stale, mismatched module map in `AGENTS.md` (naming concerns like `localization-ui`/`database-connectivity`/`ui-experience` that don't correspond to any real `src/modules/` directory, and omitting `tenant-domain`/`visitor-analytics`/`news-portal` from the list of domain modules registered directly in this base repo).

  New GENERATED artifact `docs/awcms-mini/repo-inventory.md` (`bun run repo:inventory:generate`, read-only freshness gate `bun run repo:inventory:check`, now part of `bun run check`) lists modules (from `listModules()`), migrations (`sql/*.sql`), tables & Row-Level Security (parsed from migrations, cross-checked against a reviewed `RLS_EXEMPT_TABLES` allow-list — zero unexplained gaps found), tests (file counts per `tests/` subdirectory), and a route/operation count summary from the bundled OpenAPI contract. It deliberately does not re-implement GitHub issue/label/milestone snapshotting (`docs/awcms-mini/github/`, `scripts/github-snapshot-refresh.ts`) or route<->contract parity (`scripts/api-spec-check.ts`'s `checkRouteParity`) — both already exist and are linked instead. Same "no embedded timestamp, regenerate-and-diff in CI" pattern as `docs/awcms-mini/api-reference.md` (Issue #700).

  `scripts/check-docs.mjs` (`bun run check:docs`, part of `bun run check`) gains a new check: every `docker compose`/`docker-compose` command referenced in a fenced code block or inline code span across all tracked Markdown must use a service name that actually exists in `docker-compose.yml`/`docker-compose.prod.yml` — this is what caught the `postgres` vs `db` drift.

  Fixed: `CONTRIBUTING.md` and doc 08's setup walkthrough now say `docker compose up -d db`; `SECURITY.md`'s Supported Versions table now reflects the real released version instead of a stale pre-0.1.0 placeholder; `AGENTS.md`'s module map now lists the actual 14 registered modules and documents where cross-cutting concerns (i18n, observability, pooling, security readiness) actually live (`src/lib/`, `scripts/`) instead of implying they're modules; `docs/awcms-mini/github/` refreshed to the live GitHub state (35 open, 156 closed, 99 labels, 25 milestones).

  New skill `.claude/skills/awcms-mini-repo-inventory/SKILL.md` documents the regenerate workflow and how to add a new `RLS_EXEMPT_TABLES` entry when a genuinely global table is added.

  Per the issue's own instruction, contract (`info.version`) and module descriptor (`version`/`status`) versioning were left untouched — that policy is ADR-0008/Issue #451's decision, already settled, and not mechanically forced to match the package version here.

- 5b58e2f: Extend the `reporting` module with module-contributed read-model
  projections (Issue #753, epic `platform-evolution` #738 Wave 3): a
  `ProjectionDescriptor` contract modules contribute entries to (three
  registered here — `access_audit_summary`, `module_activity_summary`,
  `event_activity_summary`), a bounded incremental `cursor_table` engine,
  a crash-safe idempotent rebuild engine, live-computed freshness/
  staleness status, on-demand source reconciliation, scheduled CSV/JSON
  exports with checksum/expiry/secure download, eleven new
  `/api/v1/reports/{projections,exports}*` endpoints (ABAC-gated,
  audited, `Idempotency-Key`-protected), two new scheduled jobs with
  least-privilege worker grants, and a new admin screen at
  `/admin/reporting/projections`. Seven new tenant-scoped RLS-protected
  tables (`sql/069`-`070`), fully additive to the five existing live
  `/api/v1/reports/*` views.

  Each `ProjectionDescriptor`'s own `requiredPermission` is now enforced
  a second time at read time (list/get/reconcile), independent of the
  coarse module-level ABAC gate, so a caller granted `reports:read` but
  not a specific projection's own permission is filtered out of the
  list and gets `403` on a direct lookup. The event-driven incremental
  updater for `event_activity_summary` no longer silently loses an
  event's count when a concurrent rebuild is cancelled mid-flight (it
  now throws to roll back its own idempotency marker instead of writing
  one before the effect is confirmed) while a watermark comparison
  against the rebuild's own cursor prevents the same event being
  double-counted once the rebuild completes normally. Scheduled exports
  now reject a non-empty `filter` (`400 NOT_IMPLEMENTED`) instead of
  silently ignoring it, and export downloads reverify the SHA-256
  checksum against the bytes actually read from disk before serving
  them.

- 36e9280: Add application-level request body size limits across every `/api/v1` endpoint (Issue #686, epic #679, platform-hardening).

  Most handlers previously called `request.json()`/`request.text()` directly with no size cap of their own — a reverse-proxy `client_max_body_size` protects nothing for direct/local access (offline/LAN deployments often run with no proxy in front at all), and nothing at all protects against a chunked-transfer or `Content-Length`-lying body.

  New shared reader (`src/lib/security/request-body-limit.ts`) is now the only place any `/api/*` handler reads a request body — `readJsonBody`/`readTextBody`/`readFormBody` enforce a declared `Content-Length` check before any byte is read, and a running streamed-byte count that aborts the read the instant it's exceeded (catching a chunked or `Content-Length`-lying body the header check alone would miss). Two tiers: `default` (128 KiB, most endpoints) and `large` (5 MiB, content-heavy endpoints — blog post/page/template/theme, email template/announcement, news-portal homepage sections, sync push/pull). A hard ceiling (`BODY_SIZE_HARD_CEILING_BYTES`, 10 MiB) bounds every tier, enforced by a unit test invariant, not just documentation.

  All 71 call sites across 57 route files migrated. A new `checkContentLengthCeiling` backstop in `src/middleware.ts` additionally rejects any `/api/*` request with a declared `Content-Length` above the hard ceiling before it reaches a route handler at all — defense-in-depth for future endpoints, not a replacement for the per-handler tiered check (it can't catch a chunked/unlabeled body).

  Oversized requests return `413 PAYLOAD_TOO_LARGE` using the standard error envelope; malformed JSON continues to flow through as `null` into each endpoint's existing validator, unchanged from before, so `400 VALIDATION_ERROR` responses stay exactly as they were. `deploy/nginx/awcms-mini.conf.example` now sets `client_max_body_size 10m` to match the application's hard ceiling.

- 0aac6a0: Add failure-injection and disaster-recovery verification (Issue #699,
  epic #679 platform-hardening): `bun run resilience:dr-drill`
  (`scripts/dr-drill.ts`) runs deterministic, non-destructive scenarios —
  PostgreSQL disconnect (client-level simulation), pool saturation, worker
  interruption (real SIGTERM, reusing Issue #697's job-runner fixture),
  and partial SSO/email provider outage — and, in the `--full` tier, a real
  backup/restore/rollback round trip reusing Issue #691's
  `deploy/backup/restore-drill.sh`. A non-overridable safety interlock
  (`src/lib/resilience/target-guard.ts`) refuses to run against
  `APP_ENV=production` or any unrecognized/production-like database host by
  default. Produces a tri-state (`pass`/`incomplete`/`fail`) JSON report
  with RTO/RPO evidence. CI runs the safe subset on every PR; the full tier
  is documented for staging rehearsal and scheduled cadence (see
  `docs/awcms-mini/resilience-dr-verification.md`).
- dada4f7: Add responsive admin navigation and a reusable admin component library
  (Issue #693, epic #679 platform-hardening).

  **Responsive sidebar/drawer** (`src/layouts/AdminLayout.astro`): below
  `--bp-md` (768px) the previously-static, always-visible sidebar becomes an
  off-canvas drawer toggled by a new hamburger button (`#admin-nav-toggle`).
  Opening it moves focus to the first nav link, traps Tab/Shift+Tab within
  the drawer, adds a click-to-close scrim, closes on `Escape` with focus
  returned to the toggle button, and marks the rest of the page `inert`
  while it's open. Desktop (`--bp-md`+) is unchanged: sidebar always visible,
  toggle hidden. The pre-existing skip link and `aria-current="page"` active-
  route marking are untouched. Also fixed the active-nav-link fill to use
  `--color-primary-strong` instead of the plain token (Issue #434's own AA
  contrast fix, missed on this one selector).

  **New `src/components/ui` primitives**: `DataTable` (scrollable table
  shell + accessible caption + standard empty row), `Pagination` (keyset
  prev/next, dispatches `awcms:paginate`), `FilterBar` (labelled filter
  toolbar), `ActionBanner` (extracted from a `<div id="action-banner">` block
  duplicated across most admin pages), `ConfirmDialog` (native `<dialog>` +
  new `src/lib/ui/confirm-dialog-client.ts` helper — replaces
  `window.confirm`/`window.prompt` for destructive actions with a real focus-
  trapped, Escape-closing, optionally reason-required dialog), `FormField`
  (label+control+hint+error wrapper), and `StatusBadge` (generalizes the
  `.status-pill` pattern, `-strong` fill tokens for AA contrast).

  **`TenantBadge.astro` replaces `TenantSwitcher.astro`**: the previous
  component rendered a `<select disabled>` styled like a real dropdown —
  exactly the "authorization decision relies on hidden/disabled UI alone"
  shape this issue's acceptance criteria forbid. `TenantBadge` renders a
  plain non-interactive badge on single-tenant deployments (today's only
  real case — `awcms_mini_identities.tenant_id` has no cross-tenant identity
  linking) and only renders a real `<select>` switcher when a new
  `availableTenants` prop — which must be computed server-side from real
  authorization data — is non-empty.

  **Two representative large-page migrations** to the new primitives (no
  full redesign): `src/pages/admin/access-users.astro` (1011 lines — two
  `DataTable`s, `StatusBadge`, `ActionBanner`, `FormField`, and
  `ConfirmDialog` for role deletion) and `src/pages/admin/tenant/domains.astro`
  (1076 lines — chosen for its three separate confirm-then-act flows: verify,
  set-primary, delete-with-reason, all previously bare `window.confirm`/
  `window.prompt`, now one shared `ConfirmDialog`). Both keep their existing
  SSR-read-direct / mutation-through-API split unchanged.

  New i18n catalog entries (en + id): `admin.layout.nav_toggle_aria_label`,
  `common.confirm_button`, `common.cancel_button`,
  `common.reason_required_error`, `admin.access_users.delete_role_confirm_title`,
  `admin.access_users.delete_role_confirm_body`,
  `admin.tenant_domain.verify_confirm_title`,
  `admin.tenant_domain.set_primary_confirm_title`,
  `admin.tenant_domain.delete_confirm_title`.

  New `--z-drawer` design token (`src/styles/tokens.css`, between `--z-nav`
  and `--z-dropdown`) for the mobile sidebar drawer + its scrim.

  New E2E specs (`tests/e2e/`, Playwright + Bun): `admin-responsive-nav.e2e.ts`
  (drawer open/close/focus/Escape/skip-link across mobile and desktop
  viewports), `admin-access-users-migrated.e2e.ts` and
  `admin-tenant-domains-migrated.e2e.ts` (ConfirmDialog flows end to end
  against the real API), and `admin-a11y-smoke.e2e.ts` (new devDependency
  `@axe-core/playwright` — automated WCAG 2.2 AA smoke test across the admin
  shell and both migrated pages, including a 320px viewport with the drawer
  open).

  Docs: `docs/awcms-mini/14_ui_ux_design_system.md` (component library table,
  responsive drawer + tenant badge policy, new `--z-drawer` token, §Migrated
  reference pages) and skills `awcms-mini-ui-screen`/`awcms-mini-browser-test`
  updated to reference the new primitives and specs.

- a6da7c7: Add a reusable, provider-neutral email module (epic #492, Issues
  #493-#500): message/recipient DTOs, an `EmailProvider` port with a real
  Mailketing adapter, a tenant-scoped schema/RLS/delivery queue
  (`sql/020`-`024`), a claim/send/finalize dispatcher (`bun run
email:dispatch`, circuit breaker, retry/backoff), template management
  (CRUD, soft-delete/restore, i18n locale variants, per-category variable
  allowlists, admin preview), password reset
  (`POST /api/v1/auth/password/{forgot,reset}`, enumeration-safe), bulk
  announcement/notification workflows
  (`POST /api/v1/email/announcements[/preview]`, tenant/role/explicit-user
  targeting with two-tier ABAC, idempotent), and admin
  observability/ops (`GET /api/v1/email/messages` + cancel,
  `GET/POST/DELETE /api/v1/email/suppressions`, `GET
/api/v1/reports/email-health`, a `security:readiness` provider-config
  gate). Generic infrastructure — analogous to `sync_storage`'s
  object-storage port — for password reset, system announcements, and
  workflow notifications; not a domain-specific "send a receipt" feature.
  See `src/modules/email/README.md`.
- d200e32: Add a reusable multi-step wizard form pattern for derived-application admin
  screens: `WizardStepper`/`WizardPanel`/`WizardActions` Astro components and
  a pure `src/lib/ui/wizard-client.ts` state helper (step navigation, per-step
  validation, field-error mapping, and idempotency-key generation for the
  final submit). No schema or API change — server-side validation, ABAC/RLS,
  audit, and idempotency remain the authoritative controls for any domain
  module that adopts this pattern. See
  `docs/awcms-mini/examples/wizard-form-pattern.md` (Issue #479, PR #480).
- 69a12dc: Add a shared worker runner (`src/lib/jobs/job-runner.ts`, `./advisory-lock.ts`,
  `./batching.ts`, `./retry-classification.ts`, Issue #697, epic #679) for
  `scripts/*.ts` cron/systemd worker scripts: a per-job-name PostgreSQL advisory
  lock (`pg_try_advisory_lock`, non-blocking, session-level) that safely
  skips a concurrent duplicate run instead of both racing to mutate the same
  data; a timeout + SIGTERM/SIGINT-aware cancellation with guaranteed lock
  release on success, thrown error, timeout, or termination; generic bounded
  tenant/item batching (`iterateTenantsInBatches`/`runBoundedBatches`,
  generalizing the `MAX_PASSES_PER_TENANT` loop several scripts hand-rolled
  independently); a retry classification helper (`classifyError`) that
  reuses `tenant-context.ts`'s existing SQLSTATE-class split; and structured,
  already-redacted JSON telemetry (via Issue #687's `sanitizeErrorForLog`) —
  printed to stdout and optionally to `--json-output=<path>`, the same
  pattern `production-preflight.ts` already established.

  `scripts/audit-log-purge.ts` (tenant-iterating maintenance job) and
  `scripts/modules-sync.ts` (non-tenant-loop job) are migrated to the new
  runner as the two representative proofs-of-concept the issue calls for —
  both gain a `--dry-run` mode and advisory-lock duplicate-run protection
  with UNCHANGED mutation behavior for a normal (non-dry-run) invocation.
  Every other existing scheduled script (`sync:objects:dispatch`,
  `email:dispatch`, `blog:publish:scheduled`, `form-drafts:purge`,
  `analytics:rollup`, `analytics:purge`) is intentionally left as-is —
  adoption is incremental, not all-at-once (see
  `docs/awcms-mini/deployment-profiles.md` §Shared worker runner).

  No new orchestration platform, job queue, or external dependency is
  introduced — this is an internal, in-process helper; scheduling remains an
  external cron/systemd timer/container scheduler invoking `bun run <script>`
  exactly as before.

- e26eeff: Add the LinkedIn organization-page social publishing adapter (Issue
  #645, epic `social_publishing` #643-#647): the first real
  `SocialProviderAdapter` implementation (`provider_key:
"linkedin_organization"`) registered into #643's foundation outbox.

  Publishes eligible news-article posts to a connected LinkedIn
  organization page. Every publish attempt performs two live LinkedIn
  calls (never inside a DB transaction, per ADR-0006): an
  `organizationAcls` check enforcing that the connected member currently
  holds a supported organization role (`ADMINISTRATOR`/`CONTENT_ADMIN` —
  ads-only `DIRECT_SPONSORED_CONTENT_POSTER` is rejected), then the
  actual post-creation call. Verified R2 article images are attached via
  LinkedIn's real Images API (`initializeUpload` -> fetch verified bytes
  -> `PUT`) gated by a defense-in-depth re-check against
  `NEWS_MEDIA_R2_PUBLIC_BASE_URL`; an untrusted/missing image, or any
  upload failure, degrades gracefully to a link-share post rather than
  blocking the publish. Every request sends the configured
  `LinkedIn-Version` header (`LINKEDIN_API_VERSION`, format `YYYYMM`) and
  `X-Restli-Protocol-Version: 2.0.0`. Token expiry (401 at any stage)
  maps to `needs_reauth`; provider errors are normalized into safe
  internal status/error codes, and every error message is redacted of
  the literal bearer token before it can reach an audit/attempt row.

  New config: `LINKEDIN_PROVIDER_ENABLED`, `LINKEDIN_CLIENT_ID`,
  `LINKEDIN_CLIENT_SECRET_REFERENCE` (a secret-storage reference, never
  the raw secret — validated by reusing `looksLikeRawSecretToken`
  verbatim), `LINKEDIN_API_VERSION`, `LINKEDIN_OAUTH_REDIRECT_URI`,
  `LINKEDIN_REQUIRED_SCOPES`. No interactive OAuth authorize/callback
  flow is implemented — connect/disconnect/reauthorize continue to use
  #643's existing generic `POST /api/v1/social-publishing/accounts`
  (upsert), consistent with every other provider in this module; the new
  config vars describe the LinkedIn App an operator registers manually
  (app-review requirement), not a redirect this codebase drives itself.
  `bun run config:validate`/`security:readiness` gain a matching
  LinkedIn-specific config-completeness check (`checkLinkedInProviderConfig`/
  `checkLinkedInProviderReadiness`), static/config-only — live
  token/role/scope verification happens per publish attempt via the
  adapter itself, not the deployment-wide readiness gate.

  No new migration or AsyncAPI event: every "Account metadata" field the
  issue describes (`organization_urn`, `organization_name`,
  `token_expires_at`, `last_verified_at`) already maps onto #643's
  existing generic account columns, and organization role/permissions are
  checked live per attempt rather than persisted (a role revoked on
  LinkedIn's side must never be trusted from a stale local snapshot).

- 5ab9b24: Add the Meta (Facebook Page + Instagram Business) social publishing
  adapter (Issue #644, epic `social_publishing` #643-#647) on top of the
  #643 provider-neutral outbox foundation.

  Registers two real adapters — `meta_facebook_page` (Graph API `POST
/{page-id}/feed` link posts) and `meta_instagram` (a 2-call
  media-container-then-publish flow to a linked Instagram Business
  Account, with best-effort permalink resolution) —
  `src/modules/social-publishing/infrastructure/meta/`, into the
  foundation's provider registry. Every Graph API call goes through an
  injectable `MetaGraphClient` (fetch-based, timeout-bounded, mirroring
  `email/infrastructure/mailketing-provider.ts`'s existing testable-client
  pattern) — no real network call to Meta exists in this repo's test
  suite.

  Adapter-level config: `META_PROVIDER_ENABLED`, `META_APP_ID`,
  `META_APP_SECRET_REFERENCE` (a secret-storage reference, never a raw
  app secret — rejected at boot if it looks like one, reusing
  `social-account-validation.ts`'s `looksLikeRawSecretToken` verbatim),
  `META_GRAPH_API_VERSION`, `META_OAUTH_REDIRECT_URI`,
  `META_REQUIRED_SCOPES` — independent of the foundation's
  `SOCIAL_PUBLISHING_ENABLED`/`_PROFILE` deployment gate. New boot check
  (`checkMetaSocialPublishingProviderConfig`, `bun run config:validate`)
  and a new critical readiness check
  (`checkMetaSocialPublishingAccountReadiness`, `bun run
security:readiness`) covering missing config, missing scopes, expired
  token, and unsupported account type per connected Meta account.

  New endpoint `POST /api/v1/social-publishing/accounts/{id}/verify` (any
  provider, not Meta-specific in shape) calls the account's adapter's
  `verifyCredentials` — for Meta, a live Graph API `debug_token` check —
  entirely outside any DB transaction; a finding that the token/scopes are
  no longer valid transitions the account to `needs_reauth` (`409
SOCIAL_ACCOUNT_NEEDS_REAUTH`), reusing the same transition path the
  outbox dispatcher already uses. Tenant admin can trigger this from a new
  "Verify connection" button on `/admin/social-publishing/accounts`.
  Connect/disconnect of Meta accounts reuse the foundation's existing
  generic account endpoints unchanged.

  Content eligibility and R2 media re-verification are enforced before any
  provider call: Facebook Page posts need a canonical URL + caption (no
  image required — Facebook's own link-preview scraper supplies one);
  Instagram posts require a verified R2 image URL and reject a URL that
  doesn't match the deployment's configured `NEWS_MEDIA_R2_PUBLIC_BASE_URL`
  origin exactly (defense-in-depth on top of the already-guaranteed
  verified-media invariant from the job-creation pipeline). Provider
  errors are normalized into a small fixed catalog of safe internal status/
  error codes (`meta_oauth_exception_190`, `meta_rate_limited_32`, ...) —
  Meta's own raw error message/trace id is never included in a stored
  `errorMessage`, log line, or API response.

- 3e08cb2: Add the `social_publishing` module (Issue #643, epic `social_publishing`
  #643-#647): a provider-neutral social auto-posting outbox and connector
  foundation, full-online-only (`SOCIAL_PUBLISHING_ENABLED`/
  `SOCIAL_PUBLISHING_PROFILE=full_online`, mirroring the established
  `AUTH_ONLINE_SECURITY_*` gate pattern).

  Adds six tenant-scoped, RLS-protected tables
  (`sql/053_awcms_mini_social_publishing_schema.sql`): social account
  connections (`awcms_mini_social_accounts`, secret tokens stored only as
  an opaque `token_reference` pointer into external secret storage —
  never plain text, rejected by a write-time heuristic if it looks like a
  raw JWT/access token), publish rules (`awcms_mini_social_publish_rules`,
  one per account/trigger-event with an optional approval gate), caption
  templates (`awcms_mini_social_publish_templates`), an idempotent outbox
  (`awcms_mini_social_publish_jobs`, unique per article/account/action via
  a deterministic idempotency key), an append-only attempt audit trail
  (`awcms_mini_social_publish_attempts`), and a per-tenant auto-posting
  master switch (`awcms_mini_social_publishing_settings`).

  Publishing jobs are created (idempotently, snapshotting title/excerpt/
  canonical URL/verified R2 image) right after an eligible
  (public+published, never draft/private/archived/soft-deleted) article
  publishes — via a new `SocialPublishingPort` (`_shared/ports/`) that
  `blog_content`'s publish route and scheduled-publish worker call, inside
  the same DB transaction as the publish itself (plain outbox-row writes
  only, no external call — ADR-0006 compliant). The actual provider call
  happens later, entirely outside any transaction, via a new
  claim/call/finalize dispatcher (`bun run social-publishing:dispatch`)
  with per-provider circuit breaker, timeout, and exponential retry/
  backoff to a terminal `failed` state; rate-limited and needs-reauth
  outcomes are handled distinctly (the latter also flips the linked
  account to `needs_reauth`).

  This is a FOUNDATION issue: it ships a pluggable
  `SocialProviderAdapter` interface and an empty provider registry — zero
  real Meta/LinkedIn/Telegram HTTP calls exist anywhere in this module
  (those are separate adapter issues #644/#645/#646). A new readiness
  check (`checkSocialPublishingProviderReadiness`, critical) fails if any
  tenant has a connected account whose provider has no adapter registered.

  New admin UI (`/admin/social-publishing/{accounts,rules,jobs}`), REST
  API (`/api/v1/social-publishing/**`, OpenAPI fragment
  `openapi/modules/social-publishing.openapi.yaml`), and AsyncAPI domain
  events (`awcms-mini.social-publishing.*`). ABAC default-deny with ten
  new permissions (`social_publishing.{accounts,rules,jobs,logs}.*`);
  `connect`/`disconnect` join `AccessAction`/`HIGH_RISK_ACTIONS`.
  Connect/disconnect/approve/cancel/retry require `Idempotency-Key`.

- 16639b1: Add the Telegram channel publishing adapter (Issue #646, epic
  `social_publishing` #643-#647) — the first real provider adapter
  registered into the `social_publishing` outbox foundation's provider
  registry (`provider_key: "telegram_channel"`).

  Configuration is gated by a second, provider-specific flag
  (`TELEGRAM_PROVIDER_ENABLED`) layered on top of the outer
  `SOCIAL_PUBLISHING_ENABLED`/`SOCIAL_PUBLISHING_PROFILE` gate. The bot
  token is stored only as a secret-storage reference
  (`TELEGRAM_BOT_TOKEN_SECRET_REFERENCE`, and per-connected-account
  `token_reference`) — reuses the existing write-time
  `looksLikeRawSecretToken` heuristic rather than a new one.

  Publishing sends a safe `sendMessage` link post (title, excerpt,
  canonical URL) with `parse_mode` omitted by default — plain text, so no
  Telegram Markdown/HTML formatting can ever be interpreted out of
  user-authored article titles/excerpts. An operator can opt into
  `MarkdownV2`/`HTML` (`TELEGRAM_DEFAULT_PARSE_MODE`), in which case every
  interpolated field is escaped per Telegram's own escaping rules
  (`telegram-message-formatting.ts`) before being sent. Provider errors
  (missing channel permission, invalid channel, invalid bot token, rate
  limiting) are normalized into safe internal outcomes
  (`failed`/`needs_reauth`/`rate_limited`) without ever leaking the bot
  token — which Telegram's Bot API embeds directly in the request URL path
  — into a log line, error message, or audit record.

  Adds a new, provider-neutral `POST
/api/v1/social-publishing/accounts/{id}/verify` endpoint (permission
  `social_publishing.accounts.verify`, migration
  `055_awcms_mini_social_publishing_verify_permission.sql`) so an admin can
  confirm a bot can post to its target channel before enabling
  auto-posting; a new critical readiness check
  (`checkTelegramProviderReadiness`) flags any auto-publishing
  `telegram_channel` account that has never been verified.

- 6f8dc08: Add the tenant domain/subdomain admin UI (Issue #563, epic #555):
  `src/pages/admin/tenant/domains.astro`, at the path/permission already
  declared by the module descriptor (Issue #558) —
  `/admin/tenant/domains`, gated on `tenant_domain.domains.read`.

  List, add platform subdomain/custom domain, show/copy TXT/CNAME
  verification records, trigger manual-first verify, set primary domain,
  soft delete, and preview the public `/news` link for a domain that is
  both `active` and the tenant's primary. Status badges use the real DB
  enum (`pending_verification | active | suspended | failed`, migration 031) rather than the issue's own shorthand list.

  SSR reads (`listTenantDomains`) are a direct, read-only DB call inside
  `withTenant` — the same convention `admin/blog/categories.astro` uses.
  **Every mutation** (create/update/verify/set-primary/delete) goes through
  the real `/api/v1/tenant/domains/**` endpoints (Issue #562) via
  client-side `fetch` — no privileged SSR shortcut. `verify`/`set-primary`
  send a fresh `Idempotency-Key` (`crypto.randomUUID()`) per click, matching
  `admin/blog/posts/[id].astro`'s lifecycle-action buttons; every mutating
  control is `lockElement`-guarded against double-submit. Hostname
  validation is duplicated client-side as a UX nicety only (mirrors
  `normalizePublicHost()`'s shape rules) — the API remains the enforcement
  boundary.

  Extends `src/lib/i18n/error-messages.ts`'s `ERROR_CODE_KEYS` with the
  tenant domain API's own `HOSTNAME_CONFLICT`, `INVALID_STATUS_TRANSITION`,
  and `CONCURRENT_UPDATE` codes so the admin UI never surfaces a raw
  server message for them. `src/modules/tenant-domain/domain/tenant-domain-validation.ts`
  now exports its enum vocabulary arrays (`TENANT_DOMAIN_TYPES` etc.) so the
  create/edit forms build their `<select>` options from the same source of
  truth the validator itself uses, instead of a second opinion.

  New i18n catalog entries under `admin.tenant_domain.*` and
  `admin.layout.nav_tenant_domains` (en + id). New test:
  `tests/integration/tenant-domain-admin.integration.test.ts` — the SSR
  read path's empty/populated/active-primary/tenant-isolation shapes, and
  that the three new error codes are ones the real API actually returns.

  Post-review fix: the edit form's status `<select>` was previously hidden
  entirely for an `active` domain, leaving no self-service way to suspend a
  live domain from this screen (the API already allowed `active ->
suspended`/`failed` via `PATCH`, since Issue #562 never gated that
  transition on current status). The status field now always renders, with
  a "leave unchanged" default option (wiring up a catalog entry the first
  draft had added but never used) plus a hint explaining the consequence
  when the current status is `active`. Also removed a native HTML `pattern`
  attribute on the create form's hostname input that could block submission
  with the browser's untranslated tooltip before the app's own localized
  error banner (`looksLikeValidHostname()`) ever ran — the client-side
  check remains a UX nicety only; `normalizePublicHost()` via the API stays
  the enforcement boundary.

- 6f5c779: Add an optional Cloudflare DNS adapter for the `tenant_domain` module
  (Issue #567, epic #555 — the epic's final issue). Manual domain management
  (`POST /api/v1/tenant/domains/{id}/verify`, Issue #562) remains the MVP
  default; this issue adds a provider boundary, not a hard dependency, and
  **no route calls it yet** — wiring it into `.../verify` or a "provision
  platform subdomain" flow is left for future work.

  Four new env vars, all optional/backward-compatible
  (`src/modules/tenant-domain/domain/tenant-domain-dns-config.ts`,
  `scripts/validate-env.ts`'s new `checkTenantDomainDnsConfig`):
  `TENANT_DOMAIN_DNS_PROVIDER` (`manual` default | `cloudflare`),
  `TENANT_DOMAIN_PLATFORM_ROOT_DOMAIN`, `TENANT_DOMAIN_CLOUDFLARE_ZONE_ID`,
  and `TENANT_DOMAIN_CLOUDFLARE_API_TOKEN` — the last three required only
  when `TENANT_DOMAIN_DNS_PROVIDER=cloudflare`.
  `TENANT_DOMAIN_PLATFORM_ROOT_DOMAIN` is deliberately a separate variable
  from `PUBLIC_PLATFORM_ROOT_DOMAIN` (Issue #556) even though the two will
  often share a value — one gates the public host-based resolver (#559),
  the other scopes which hostnames this adapter is allowed to touch.

  New adapter, `src/modules/tenant-domain/infrastructure/cloudflare-dns-adapter.ts`:
  a `TenantDomainDnsProvider` port with `createVerificationRecord` (creates a
  TXT/CNAME record, idempotent by construction — lists for an existing
  matching record before writing) and `checkVerificationStatus` (lists and
  compares against an expected value, normalizing CNAME case/trailing dot).
  Both calls are timeout-bounded (`withTimeout`, default 8s) and gated by a
  shared circuit breaker, mirroring
  `email/infrastructure/mailketing-provider.ts` and
  `sync-storage/infrastructure/object-storage-uploader.ts`; both are meant to
  run outside any DB transaction (ADR-0006).

  Security: the Cloudflare API token/zone id are read only from env — never
  persisted to `awcms_mini_tenant_domains` or `awcms_mini_module_settings`,
  never rendered in any response. `validateDnsRecordInput` (exported, pure)
  rejects any `recordName` outside `TENANT_DOMAIN_PLATFORM_ROOT_DOMAIN` (or a
  subdomain of it) before any network call. Provider errors are redacted:
  only Cloudflare's numeric `errors[].code` values are surfaced (never
  `.message`), and a `redact()` pass strips the configured token/zone id out
  of any thrown-error text as defense in depth, before truncation.

  Test: `tests/unit/cloudflare-dns-adapter.test.ts` (pure validation cases,
  plus a local `Bun.serve` fake Cloudflare API covering success, idempotent
  re-create, provider error with redaction proof, timeout, circuit-breaker
  trip, and `resolveTenantDomainDnsProvider`'s missing/invalid-env behavior)
  and `tests/validate-env.test.ts`'s new `checkTenantDomainDnsConfig`
  `describe` block. Docs: `src/modules/tenant-domain/README.md` §Cloudflare
  DNS adapter, `docs/awcms-mini/18_configuration_env_reference.md` §Cloudflare
  DNS adapter, `.env.example`.

- a8d4136: Add the tenant domain management API (Issue #562, epic #555):
  authenticated, tenant-scoped, audited CRUD + lifecycle actions over
  `awcms_mini_tenant_domains` under `/api/v1/tenant/domains` — the first
  application code that writes rows to this table (previously only the
  public host resolver, Issue #559, ever read from it).

  ```txt
  GET    /api/v1/tenant/domains              list, keyset-paginated
  POST   /api/v1/tenant/domains              create
  GET    /api/v1/tenant/domains/{id}         read one
  PATCH  /api/v1/tenant/domains/{id}         partial update
  DELETE /api/v1/tenant/domains/{id}         soft delete
  POST   /api/v1/tenant/domains/{id}/verify        manual-first verify
  POST   /api/v1/tenant/domains/{id}/set-primary   atomic primary swap
  ```

  Every route uses the standard ABAC guard
  (`tenant_domain.domains.{read,create,update,delete,verify,set_primary}`,
  migration 032's existing permission seed) and `withTenant` (RLS `FORCE`d
  on the table since migration 031) — never the migration-033 `SECURITY
DEFINER` bootstrap function, which stays reserved for the anonymous
  public resolver. `verify`/`set_primary` are new entries in
  `identity-access/domain/access-control.ts`'s `AccessAction` union (not
  added to `HIGH_RISK_ACTIONS`, same precedent as `retry`/`sync`/`enable`/
  `disable`/`check`/`publish`) and both require `Idempotency-Key`.

  Hostname validation reuses `normalizePublicHost()` (Issue #559) directly
  rather than inventing a second hostname-shape opinion. A duplicate
  normalized hostname (the underlying unique index is global, not
  per-tenant) always returns a generic `409 HOSTNAME_CONFLICT` — never
  reveals whether the existing mapping belongs to this tenant or another
  one. Unknown/cross-tenant/soft-deleted domain ids all collapse to an
  identical generic `404`. `hostname` is immutable after create; `is_primary`
  is only ever settable via the atomic `set-primary` endpoint (two `UPDATE`s
  in the same `withTenant` transaction, old-primary-unset then
  new-primary-set, so the one-primary-per-tenant partial unique index is
  never violated mid-transaction); `PATCH .../{id}` cannot set `status` to
  `"active"` (only `POST .../verify` can, manual-first, no outbound DNS/HTTP
  call). No response ever includes `verification_token_hash`.

  Also fixes a timing side-channel flagged as a pre-`#562`-go-live blocker
  in the `awcms-mini-tenant-domain-routing` skill:
  `blog-content/application/public-news-tenant-resolution.ts`'s
  `withNewsTenant()` used to cost a different number of DB round trips for
  "tenant not resolved" (no transaction) versus "tenant resolved but
  `blog_content` disabled" (opens a transaction + one module-check query),
  even though both produce the identical generic 404 — an external prober
  varying the `Host` header could have learned "this hostname maps to a
  real active tenant" purely from response latency once this API lets
  `awcms_mini_tenant_domains` hold real mappings. `padUnresolvedTenantLatency()`
  now pays the same round-trip shape on the "not resolved" path (a harmless
  padding query scoped to the all-zero fail-closed sentinel tenant id from
  migration 013).

  Post-review fix (security audit, Medium finding): `set-primary` now
  catches a concurrent-first-primary race — two parallel `set-primary`
  calls for a tenant that never had a primary before could both pass the
  "unset old primary" step (nothing to unset) and race to "set new
  primary," with the loser previously surfacing a raw
  `awcms_mini_tenant_domains_primary_dedup` constraint-violation error
  instead of a clean response. `setPrimaryTenantDomain` now catches that
  violation and returns a generic `409 CONCURRENT_UPDATE`, mirroring the
  existing hostname-dedup catch pattern in `createTenantDomain`. Covered by
  a new parallel-request test in `tenant-domain-api.integration.test.ts`.

  New files: `src/modules/tenant-domain/domain/tenant-domain-validation.ts`,
  `src/modules/tenant-domain/application/tenant-domain-directory.ts`,
  `src/pages/api/v1/tenant/domains/index.ts`,
  `src/pages/api/v1/tenant/domains/[id].ts`,
  `src/pages/api/v1/tenant/domains/[id]/verify.ts`,
  `src/pages/api/v1/tenant/domains/[id]/set-primary.ts`. No new migration —
  this issue is API-only over the existing migration 031/032 schema.
  Covered by `tests/integration/tenant-domain-api.integration.test.ts` and
  three new round-trip-counting tests in
  `tests/integration/blog-content-public-news.integration.test.ts`.

- cd03e14: Register `tenant_domain` as a first-class AWCMS-Mini module (Issue #558,
  epic #555): `src/modules/tenant-domain/module.ts` declares `type:
"system"`, `dependencies: ["tenant_admin", "identity_access"]`,
  `api.basePath: "/api/v1/tenant/domains"`, `navigation.path:
"/admin/tenant/domains"`, the six `tenant_domain.domains.*` permissions
  seeded by `sql/032_awcms_mini_tenant_domain_permissions.sql`
  (`read`/`create`/`update`/`delete`/`verify`/`set_primary`), and
  `settings.defaults: { defaultVerificationMethod: "manual" }` (manual DNS
  mode only — no automatic provider default). Registered in
  `src/modules/index.ts`'s `listModules()` so `bun run modules:sync` picks
  it up and Module Management's permission sync/status report has a
  descriptor to compare the migration 032 seed against. Descriptor
  metadata only — no API implementation, admin UI, host-based resolver, or
  Cloudflare DNS adapter in this issue (those are #559/#562/#563/#567).
  Covered by `tests/modules/tenant-domain-module.test.ts`.
- 426ca49: Add the tenant domain/subdomain mapping schema (Issue #557, epic #555):
  `awcms_mini_tenant_domains` (`sql/031_awcms_mini_tenant_domain_schema.sql`)
  maps a public hostname to a tenant, with a separate `normalized_hostname`
  column (lowercase/trimmed, kept in sync by a CHECK constraint) that is
  globally unique among non-deleted rows, a partial unique index enforcing
  at most one active primary domain per tenant, `domain_type`
  (`subdomain`/`custom_domain`) and `route_mode` (`canonical`/`legacy_blog`)
  extension points for the future resolver (#559) and `/news` routes
  (#560), `verification_method`/`verification_token_hash` (hashed, never
  the raw token)/`verification_record_name`/`verification_record_value` for
  DNS ownership verification (no provider credential ever stored here),
  soft delete, and `ENABLE`+`FORCE` row-level security with the standard
  `tenant_isolation` policy. `sql/032_awcms_mini_tenant_domain_permissions.sql`
  seeds six new `tenant_domain.domains.*` permissions
  (`read`/`create`/`update`/`delete`/`verify`/`set_primary`). Schema only —
  no module descriptor, resolver, API, or admin UI in this issue (those are
  #558/#559/#562/#563). Covered by
  `tests/integration/tenant-domain-schema.integration.test.ts`.
- 28d994a: Add the tenant-module matrix admin UI (Issue #566, epic #555, depends on
  #565): `src/pages/admin/modules/tenants.astro`, at the path already used
  by the issue (`/admin/modules/tenants`), gated on **both**
  `module_management.modules.read` and `module_management.tenant_modules.read`.

  **Single-tenant scope, not cross-tenant** (decided with the maintainer,
  documented in full in the page's own docblock and
  `module-management/README.md`): this repo's identity model is strictly
  1:1 tenant-scoped, so this screen shows module x relevant-attribute for
  the admin's own tenant only — there is no tenant selector/filter anywhere
  on this page.

  What the matrix adds beyond the existing `/admin/modules` list +
  `/admin/modules/{moduleKey}` detail pages: dependency and
  reverse-dependency warnings surfaced for every module at once (100%
  reuse of `evaluateModuleEnable`/`evaluateModuleDisable`, no re-derived
  graph logic — new `application/module-matrix.ts`'s `fetchModuleMatrix`),
  bulk core/protected visualization (`isCore` plus Issue #565's
  `resolveProtectedModuleKeys`, with the disable control hidden for both),
  and a client-side "only show modules with a warning" filter. Settings
  editing and the audit-event list are not duplicated — this screen links
  to the existing detail page for both. Applying a module preset
  (`applyModulePreset`, #565) was considered but left out of this issue —
  doing so cleanly needs a new guarded/audited API endpoint, a separable
  unit of work — and is noted as a follow-up.

  SSR reads (`fetchModuleMatrix`) are a direct, read-only DB call inside
  `withTenant`. Every mutation (enable/disable) goes through the real
  `/api/v1/tenant/modules/{moduleKey}/enable|disable` endpoints (Issue
  #515) via client-side `fetch` — no privileged SSR shortcut, same binding
  split `admin/tenant/domains.astro` (#563) established. Neither endpoint
  requires an `Idempotency-Key`; disable prompts for a reason via
  `window.prompt`, matching `admin/modules/[moduleKey].astro`'s existing
  enable/disable buttons exactly.

  New i18n catalog entries under `admin.modules.matrix_*` plus
  `admin.layout.nav_module_matrix` (en + id) — the module descriptor's
  `navigation` array gained a second entry for this page. New test:
  `tests/integration/module-tenant-matrix.integration.test.ts` — covers
  `fetchModuleMatrix`'s health-inclusion toggle, both warning directions
  (using the same registry scenarios
  `module-tenant-lifecycle.integration.test.ts` already established), core
  protection, real enable/disable mutations with audit-event assertions,
  and a 403 for a caller without `module_management.tenant_modules`
  permissions.

- 6f04a30: Add a typed configuration registry and a new CI drift gate, and mark six
  dead/misleading environment variables deprecated (Issue #689, epic #679
  platform-hardening).

  `src/lib/config/registry.ts` is now the single structured source of truth
  (TypeScript, not JSON — full type-checking) for every environment
  variable this repo's application/deployment tooling reads: one entry per
  variable with `type`, `required` (`required`/`optional`/`conditional` —
  mirroring `scripts/validate-env.ts`'s actual boot-time enforcement),
  `ownerModule`, `sensitivity` (`secret`/`non-secret`), `profiles`
  (development/staging/production/offline-lan), `default`, and an optional
  `deprecated` marker (`since`/`removalVersion`/`guidance`). The ~30
  existing `checkXxxConfig` functions in `scripts/validate-env.ts` are
  unchanged (same tested pass/fail behavior, same 81 existing tests still
  pass) — the registry is a purely additive metadata layer, cross-referenced
  via each entry's `validatorGroup` rather than wired as a risky
  circular-import refactor.

  `bun run config:docs:check` (`scripts/config-docs-check.ts`, now part of
  `bun run check`) enforces three-way parity between the registry,
  `.env.example`, and `docs/awcms-mini/18_configuration_env_reference.md` —
  failing CI when a variable exists in one surface but not the others,
  except for explicit, reasoned exemptions (`CONFIG_EXEMPTIONS` in the
  registry for illustrative example content like `STARSENDER_*`/
  `AI_ANALYST_*`/platform-level `NODE_ENV`/`PORT`; `DOC18_NON_VARIABLE_TOKENS`
  in the script for prose false positives like quoted SQL keywords). This
  gate already caught and fixed two real drift instances found during this
  issue's audit: `FORM_DRAFT_RETENTION_DAYS` was documented in doc 18 but
  missing from the real `.env.example`, and `AWCMS_MINI_APP_DB_PASSWORD` was
  in `.env.example` but never mentioned in doc 18 at all.

  Six variables are now marked `deprecated` (verified dead via exhaustive
  grep, not assumed from a description) with migration guidance and a
  `1.0.0` target removal version — `config:validate`'s boot-time pass/fail
  behavior is unchanged for this release (`AUTH_JWT_SECRET`/`APP_TIMEZONE`
  remain required, non-breaking for every existing deployment); a new
  informational-only "deprecation notices" section is appended to
  `config:validate`'s CLI report when a deprecated variable is currently
  set:

  - `AUTH_JWT_SECRET` — sessions are opaque tokens
    (`awcms_mini_sessions.token_hash`), never JWT; no code signs or verifies
    anything with this value.
  - `APP_TIMEZONE` — `src/lib/i18n/format.ts` hardcodes `Asia/Jakarta`;
    per-tenant timezone comes from `awcms_mini_tenant_settings` (DB).
  - `APP_DEFAULT_LOCALE` — `src/lib/i18n/locale.ts` hardcodes
    `DEFAULT_LOCALE = "en"` as the runtime fallback (the exact `id` vs `en`
    drift called out in this issue's evidence); per-tenant locale comes from
    `awcms_mini_tenants.default_locale` (DB).
  - `AWCMS_MINI_NODE_ID` — node identity is resolved from
    `awcms_mini_sync_nodes` (DB), never read from this env var.
  - `STORAGE_DRIVER` / `LOCAL_STORAGE_PATH` — never read; the real
    local-vs-R2 switch for the sync object queue is `R2_ENABLED`.

  New tests: `tests/unit/config-registry.test.ts` (registry field
  completeness, no leaked secret values across every registry-declared
  secret var in `runEnvValidation`'s output, a minimal offline/LAN config
  derived from the registry's `required` vars passes validation, and
  explicit locale/timezone/storage source-of-truth tests) and
  `tests/unit/config-docs-check.test.ts` (drift-detection fixtures, plus an
  assertion that the real repository files are in sync today).

- 9efcdc3: Add the visitor analytics REST API (Issue #621, epic: visitor analytics
  #617-#624) — eleven endpoints under `/api/v1/analytics` for realtime
  presence, range-bounded summary/pages/devices/locations/security
  aggregates, keyset-paginated sessions/events, settings, and on-demand
  retention purge. Every endpoint enforces ABAC default-deny; raw IP/
  user-agent/login-identifier detail on sessions/events is gated behind the
  separate `visitor_analytics.raw_detail.read` permission, independent of
  `sessions.read`/`events.read`. Retention purge requires an
  `Idempotency-Key` and is recorded as a `critical` audit event. OpenAPI
  contract updated with all new paths, schemas, and error responses.
- 0e46dad: Add the visitor analytics admin dashboard at `/admin/analytics` (Issue
  #622, epic: visitor analytics #617-#624) — surfaces the `GET
/api/v1/analytics/*` endpoints shipped in #621 (realtime online counts,
  24h/7d/30d human visitor summaries, top pages, device/browser
  distribution, country/location summary, bot/suspicious traffic summary,
  and a keyset-paginated active-sessions table) behind the module's own
  `visitor_analytics.dashboard.read`/`.realtime.read`/`.sessions.read`
  permissions.

  The dashboard is UI-only: it adds no new endpoint, no new permission, and
  never queries `awcms_mini_visitor_sessions`/`awcms_mini_visit_events`
  directly — every number/table is loaded client-side from the existing
  HTTP API (`fetchJson`, `src/lib/ui/admin-form-client.ts`), so server-side
  ABAC remains the sole enforcement point. `visitor_analytics.raw_detail.read`
  is never re-checked in the UI; the dashboard renders exactly what
  `GET /api/v1/analytics/sessions` already shaped for the caller (a `null`
  raw field renders as a placeholder, never a leaked value), and only
  additionally hides the four raw-detail table columns as a presentation
  nicety for callers who lack that permission.

  The Location section is hidden with a safe "disabled" notice when
  geolocation is not active for the deployment (`VISITOR_ANALYTICS_GEO_ENABLED`
  - `_TRUST_CLOUDFLARE`). The Area/Visitor-type filters narrow the
    active-sessions table's already-fetched rows client-side (no aggregate
    endpoint accepts those as query parameters); the Range filter
    (`24h|7d|30d|12m`) re-fetches the range-scoped aggregate cards for real.

  New pure view-model module
  `src/modules/visitor-analytics/domain/dashboard-view.ts` (loading/empty/
  error state resolution, raw-detail-null formatting) with its own unit
  tests, plus two Playwright E2E specs covering access-denied and
  aggregate-view-render/raw-detail-gating. i18n strings added for English
  and Indonesian.

- dbb149f: Add visitor identity, user-agent parsing, human/bot classification, path
  sanitization, and referrer extraction helpers (Issue #619, epic: visitor
  analytics #617-#624) under `src/modules/visitor-analytics/domain/`. Pure,
  unit-tested functions (visitor-key, user-agent, human-classifier,
  path-sanitizer, referrer) — not wired into any request path yet; the
  middleware collector lands in Issue #620.
- 13008d7: Add the `visitor_analytics` module foundation (Issue #617, epic: visitor
  analytics #617-#624) — a new `type: "system"` module (like
  `reporting`/`logging`) for privacy-first human visitor statistics. Adds
  `src/modules/visitor-analytics` (module descriptor, env-based
  configuration gate with `basic`/`detailed` modes, all raw-detail/geo
  collection disabled by default), the 8-entry `visitor_analytics.*`
  permission seed (migration `038`), and `checkVisitorAnalyticsConfig` in
  `bun run config:validate`. No analytics tables, middleware collector,
  API, dashboard UI, geolocation enrichment, or rollup/retention jobs yet —
  those land in Issues #618-#624.
- 87eee7a: Add trusted online geolocation enrichment (Issue #623, epic: visitor
  analytics #617-#624) — country code from Cloudflare's `CF-IPCountry`
  header, gated behind both `VISITOR_ANALYTICS_GEO_ENABLED` and
  `VISITOR_ANALYTICS_TRUST_CLOUDFLARE`, never an external network call.
  `GET /api/v1/analytics/locations` now returns real data for deployments
  that opt in. Also hardens `resolveAnalyticsClientIp` against ambiguous
  multi-value `X-Forwarded-For`/`CF-Connecting-IP` headers (fail-safe with
  a warning log, matching the tenant-domain-routing epic's
  `X-Forwarded-Host` handling) and fixes a latent bug where
  `user_agent_parsed`/`geo` jsonb columns were written via
  `JSON.stringify(...)::jsonb`, which silently made every later read of
  those columns return a raw JSON string instead of a parsed object.
- f8dd093: Wire visitor analytics collection into the request lifecycle (Issue #620,
  epic: visitor analytics #617-#624). `src/middleware.ts` now collects
  lightweight telemetry for `/admin/*` and public page requests (gated by
  the Issue #617 config flags), writing to `awcms_mini_visitor_sessions`/
  `awcms_mini_visit_events` via the new `application/collector.ts` service.
  Fail-open (a collector error never breaks the real response), raw IP/UA
  stay hashed unless explicitly opted in, and `identityId`/
  `visitor_session_id` are always server-derived — never a client-supplied
  value, closing the cross-tenant FK-oracle risk the Issue #618 security
  audit flagged ahead of time. Adds migration `040` (session lookup index).
  No API endpoints or dashboard UI yet — those land in Issues #621-#622.
- 9bd8ab7: Close out the visitor analytics operational/privacy loop (Issue #624,
  epic #679 platform-hardening) with a 2026-07-11 repository audit
  addendum: `VISITOR_ANALYTICS_ENABLED` now defaults to `false` — a fresh
  installation collects no visitor telemetry at all until an operator
  explicitly opts in (`.env.example`, `src/lib/config/registry.ts`, and
  `VISITOR_ANALYTICS_DEFAULTS` all updated together). Existing deployments
  that already set `VISITOR_ANALYTICS_ENABLED=true` explicitly are
  completely unaffected; deployments relying on the previous implicit
  default must add the var explicitly to keep collecting after upgrading
  (see `docs/awcms-mini/visitor-analytics.md` §Default opt-in dan upgrade
  path for the full migration note — no data migration or schema change is
  involved, this is config-only).

  The anonymous `awcms_mini_visitor_key` cookie's lifetime is now
  configurable via `VISITOR_ANALYTICS_VISITOR_KEY_COOKIE_TTL_DAYS` (30 days
  by default, replacing a previous hardcoded ~2-year constant), and is now
  actively revoked (deleted) the moment the module is disabled — a new
  `bun run security:readiness` check
  (`checkVisitorAnalyticsVisitorKeyCookieTtlReady`) flags an unusually long
  configured TTL. No cookie is ever set, and no session/event row is ever
  written, while the module is disabled — verified by new pure unit tests
  (`domain/visitor-key-cookie.ts`'s `shouldRevokeVisitorKeyCookie`/
  `planVisitorKeyCookie`).

  Documentation updated across `docs/awcms-mini/visitor-analytics.md`
  (new §Default opt-in dan upgrade path and §Cookie anonim sections, a
  data-subject deletion/anonymization mapping under UU PDP, and an
  ISO/IEC 27701:2025 reference update), `18_configuration_env_reference.md`,
  `deployment-profiles.md`, `20_threat_model_security_architecture.md`, the
  `visitor-analytics` module README, and the
  `awcms-mini-visitor-analytics` skill.

- 0e46dad: Add the visitor analytics rollup job, retention purge job, readiness
  checks, and closing documentation (Issue #624, epic: visitor analytics
  #617-#624 — the final issue in the epic).

  `bun run analytics:rollup` (`scripts/visitor-analytics-rollup.ts`)
  aggregates `awcms_mini_visit_events` into `awcms_mini_visitor_daily_rollups`,
  one row per `(tenant, date, area)`, for every active tenant. It is
  idempotent by construction: each run fully recomputes a date's totals
  from raw events and UPSERTs (`ON CONFLICT ... DO UPDATE SET ... =
EXCLUDED...`), so rerunning the same date never double-counts. CLI
  accepts `--date=YYYY-MM-DD`, `--start-date=.../--end-date=...` for
  backfill, or defaults to "yesterday" (UTC).

  `bun run analytics:purge` (`scripts/visitor-analytics-purge.ts`) iterates
  every active tenant and calls the existing `purgeVisitorAnalyticsData`
  (Issue #621) directly — the same function `POST
/api/v1/analytics/retention/purge` already uses on demand — rather than
  re-deriving its four retention cutoffs. Only a tenant where the purge
  actually deleted/cleared something gets a `critical` `retention_purged`
  audit event (safe summary counts only, never raw data).

  `bun run security:readiness` gains five new cross-field checks:
  `checkVisitorAnalyticsRawIpRetentionReady` (critical — raw IP enabled
  with unsafe retention ordering), `checkVisitorAnalyticsRawUserAgentRetentionReady`
  (warning), `checkVisitorAnalyticsGeoTrustedSourceReady` (critical — geo
  enabled without a trusted Cloudflare source), `checkVisitorAnalyticsRetentionOrderingReady`
  (warning — general raw-detail/rollup retention ordering), and
  `checkVisitorAnalyticsHashSaltReady` (warning — empty hash salt while
  the module is active). Every check passes cleanly on the privacy-first
  default configuration (nothing set); only `critical` findings block
  go-live.

  New `docs/awcms-mini/visitor-analytics.md` documents offline/LAN, full-online,
  and trusted-proxy/Cloudflare operating modes, the per-column retention
  policy, rollup/purge job behavior, and a practical compliance mapping to
  UU PDP, PP PSTE, ISO/IEC 27001/27002/27005/27701, OWASP ASVS, and the
  OWASP Logging Cheat Sheet. `18_configuration_env_reference.md`,
  `deployment-profiles.md`, `20_threat_model_security_architecture.md`, and
  `04_erd_data_dictionary.md` are updated to match. With this issue, the
  visitor analytics epic (#617-#624) is complete.

- b743794: Add the visitor analytics database schema (Issue #618, epic: visitor
  analytics #617-#624) — `awcms_mini_visitor_sessions`,
  `awcms_mini_visit_events`, and `awcms_mini_visitor_daily_rollups`
  (migration `039`), all tenant-scoped with `ENABLE`+`FORCE ROW LEVEL
SECURITY`. Raw IP/user-agent columns are nullable and unused by default;
  no writer exists yet (the middleware collector lands in Issue #620).
- bd1fe89: Evolve `workflow-approval` from a linear single-step approval engine (Issue 11.1) into a managed, versioned, graph-based enterprise workflow minimum (Issue #747, epic `platform-evolution` #738 Wave 2).

  - Managed workflow-definition lifecycle: `draft -> active -> retired`, full version history, immutable published/retired rows (migration `060`). New endpoints `POST/PUT/DELETE /api/v1/workflows/definitions`, `.../publish`, `.../retire`, `.../new-version`, `.../validate`.
  - Generic node/transition graph (`approval`/`condition`/`parallel`/`join`/`notify`/`end`) replaces the old linear `steps` list — sequential approval, bounded conditional routing over declared facts (never arbitrary expressions/code, doc 21 §3 decision tree), and parallel fan-out/fan-in.
  - Quorum/any/all approval rules per node, tracked via new `awcms_mini_workflow_task_assignments` (eligible deciders, reassignment history).
  - Effective-dated delegation/substitute assignments (`awcms_mini_workflow_delegations`) — scoped, reasoned, audited, revocable; never widens the delegator's own verified authority.
  - Escalation/timeout policies processed by a new scheduled worker job (`bun run workflow:escalations:dispatch`), built on the shared worker runner with bounded batches, an advisory lock, and an optimistic-concurrency idempotency guard so a task is never escalated twice for the same due event.
  - Administrative recovery — reassign, cancel, force-approve/force-reject — each permission-gated, reason-required, `Idempotency-Key`, fully audited, and never overwriting prior decision/task history.
  - Every instance is pinned to the exact definition version active when it started (`workflow_definition_id`/`workflow_definition_version`); newer published versions never retroactively change a running instance's behavior.
  - Module-contributed condition resolvers/actions via a static, reviewed-source-code registry (`infrastructure/condition-action-registry.ts`, mirroring `domain_event_runtime`'s consumer registry) — never runtime-registered or tenant-uploaded code.
  - Consolidated admin approval inbox: `GET /api/v1/workflows/tasks` gains keyset pagination, filters (workflow key/resource type/status/overdue), safe parameterized search, plus a new `GET /api/v1/workflows/instances/{id}` immutable action-history view; new admin UI screen at `/admin/workflows`.
  - New workflow lifecycle events (`awcms-mini.workflow.instance.{started,advanced,approved,rejected,cancelled}`, `.task.escalated`, `.delegation.{created,revoked}`) published via `domain_event_runtime`'s transactional outbox (Issue #742) in the same transaction as the triggering state change.
  - Low-cardinality metrics for active/overdue instances, decision latency, escalation, and recovery actions.

  Security-auditor fixes applied before merge (PR #778):

  - `force-decision` (administrative force-approve/force-reject) now looks up the task's original requester before authorizing and denies a caller force-deciding their own instance — previously this path structurally bypassed self-approval denial (the check only ever fired for the `approve` action, never `force_decide`).
  - `publish`, `retire`, `DELETE /api/v1/workflows/definitions/{id}`, and both delegation create/revoke endpoints now call `recordAuditEvent`; `DELETE .../definitions/{id}` and both delegation endpoints now also require `Idempotency-Key` (all were previously missing one or both).
  - `POST /api/v1/workflows/delegations/{id}/revoke` is now gated on the `workflow.delegation.revoke` permission (previously gated on `.read` only, leaving the seeded `revoke` permission unenforced) — an integrator's role must hold `workflow.delegation.revoke` (Owner/Manager by default, doc 17) to revoke a delegation, even their own.
  - The escalation-job worker role's grant on `awcms_mini_workflow_instances` trimmed from `SELECT, UPDATE` to `SELECT`-only (the job never writes to that table).

### Patch Changes

- 32695b0: Bump `actions/cache` GitHub Actions workflow dependency from 4.3.0 to
  6.1.0 (Dependabot), used in `.github/workflows/changesets.yml`,
  `ci.yml`, and `release.yml`. CI infrastructure only, no application code
  changes required.
- a1ce87d: Bump `astro` dependency from 7.0.6 to 7.0.7 patch release (Dependabot).
  Upstream patch release only, no repository code changes required.
- 2fb7484: Bump `actions/attest-sbom` GitHub Actions workflow dependency from
  2.4.0 to 4.1.0 (Dependabot). CI infrastructure only, no application code
  changes required.
- d00ce7d: Close the documentation/contract/readiness loop for the full-online auth
  security hardening epic (Issue #593, epic #587-#593) — the audit/closure
  issue, not a new auth feature.

  Fixed real gaps found by the audit:

  - `docs/awcms-mini/18_configuration_env_reference.md` and
    `deployment-profiles.md` still said "#592-#593 backlog" even though the
    admin policy UI (#592) had already merged — corrected to reflect the
    epic's actual state.
  - `docs/awcms-mini/20_threat_model_security_architecture.md` had zero
    mentions of Turnstile/MFA/Google OIDC/SSO/break-glass — added a new
    section mapping this epic's seven requested threat categories (credential
    stuffing, bot abuse, OIDC callback abuse, provider outage, MFA recovery
    abuse, SSO lockout, offline dependency breakage) to concrete evidence.
  - `scripts/security-readiness.ts` adds `checkSsoBreakGlassReady` (critical):
    `saveTenantAuthPolicy` (#591) only validates that a tenant's
    `sso_required=true`/`password_login_enabled=false` policy has an eligible
    break-glass identity at the moment the policy is SAVED. A break-glass
    identity can be deactivated (or lose its tenant membership) by an
    unrelated action afterward without the policy ever being re-saved,
    silently leaving the tenant with no way back into local password login.
    The new check re-derives eligibility from a fresh database read, for
    every active tenant, at `bun run security:readiness` time — reusing
    `countEligibleBreakGlassIdentities` (now exported from
    `tenant-auth-policy.ts`) so the eligibility rule is never re-derived a
    second, divergent way. Covered by a new integration test,
    `tests/integration/security-readiness-break-glass.integration.test.ts`.
    Per-tenant errors during the scan are isolated (caught individually
    inside the loop) rather than aborting the whole check on the first bad
    tenant — a single tenant with an unexpected query failure no longer
    masks a genuine at-risk finding for every other tenant.

  Everything else audited (`.env.example`, `scripts/validate-env.ts`,
  OpenAPI, `src/modules/identity-access/README.md`) was already accurate
  from #587-#591 and is confirmed, not changed.

- 381a1a5: Fix two non-blocking UX-integrity gaps around tenant auth policy break-glass
  identity selection (Issue #605, follow-up from the security-auditor review
  of PR #604/Issue #592). Neither was a bypassable security boundary —
  `saveTenantAuthPolicy` (Issue #591) has always re-validated break-glass
  eligibility via a fresh database read before allowing `sso_required=true`/
  `password_login_enabled=false` to persist.

  - `src/pages/admin/security.astro`'s break-glass checkbox picker now filters
    candidates to `tenant_user.status === 'active' && identity.status ===
'active'` before rendering, instead of listing every tenant user
    (including suspended/inactive ones) as a selectable break-glass owner —
    an admin no longer discovers a doomed selection only after submitting.
    `fetchTenantUsersWithRoles` itself is unchanged (shared with
    `admin/access-users.astro`, which does need the full list); the filter
    is applied at the point of use.
  - `saveTenantAuthPolicy` (`src/modules/identity-access/application/tenant-auth-policy.ts`)
    now persists only the ids confirmed eligible right now, never the
    submitted list verbatim. Previously it only checked that _at least one_
    submitted id was eligible before allowing the save — a submission of "1
    valid + N garbage/typo'd/nonexistent ids" (possible via the admin UI's
    manual free-text fallback for admins without `user_management.read`, or
    a direct API call) would silently persist all of them. `break_glass_identity_ids`
    is now self-cleaning on every save.
  - `countEligibleBreakGlassIdentities` is now a thin wrapper around a new
    `fetchEligibleBreakGlassIdentityIds` (returns the actual eligible ids, not
    just a count) so the filtering and the count check share one query
    instead of two divergent implementations. `scripts/security-readiness.ts`'s
    `checkSsoBreakGlassReady` (Issue #593) is unaffected — its call site's
    signature is unchanged.

  New regression test in `tests/integration/tenant-sso-flow.integration.test.ts`:
  "break-glass hygiene: saving policy with 1 valid + N garbage/ineligible ids
  persists ONLY the valid one" — submits one real identity id alongside two
  syntactically-valid-but-nonexistent UUIDs and confirms only the real one is
  ever persisted, verified via a fresh re-read of the policy.

  Per a security-auditor follow-up finding on this PR: the `sso_policy_updated`
  audit event now also records `breakGlassIdentityIdsSubmittedCount`/
  `breakGlassIdentityIdsPersistedCount` (counts only, never the ids
  themselves) whenever `breakGlassIdentityIds` is part of the request, so a
  forensic review of the audit log alone can see that a save silently dropped
  ineligible/garbage ids, without needing a before/after database snapshot
  diff. Covered by a new test in `tests/integration/admin-security-ui.integration.test.ts`.

- 1519ed3: Wire `organization_structure`'s real `BusinessScopeHierarchyPort` adapter (`organizationStructureHierarchyPortAdapter`, Issue #749) into its actual production consumer, `POST /api/v1/identity/business-scope/assignments` (Issue #786, follow-up to #746/#749, epic `platform-evolution` #738). Previously this route hardcoded only `identity_access`'s own flat `"office"` default adapter, so `legal_entity`/`organization_unit` business-scope references always resolved as `SCOPE_UNRESOLVED` even when the referenced row genuinely existed — the reviewer's non-blocking follow-up note on PR #779.

  - The route's `buildHierarchyPort` now resolves `organization_structure`'s per-tenant enablement (`resolveModuleEnabled`) and, when enabled, tries the real adapter first for every scope, falling back to the flat `"office"` adapter when it doesn't resolve (any other scope type, or every scope type when the module is disabled for that tenant).
  - Wiring lives entirely in the route file (a composition root), never inside `identity_access`'s own `application`/`domain` tree — keeps Core free of any compile-time import of the Optional `organization_structure` module (ADR-0013 §1), verified by `tests/unit/module-boundary-cycles.test.ts`.
  - `identity_access/module.ts` now declares `capabilities.consumes` for `organization_hierarchy_resolution` (`providedBy: "organization_structure"`, `optional: true`), matching `organization_structure`'s own declared `capabilities.provides` for the module-composition validator.
  - New integration coverage (`tests/integration/business-scope-organization-structure-wiring.integration.test.ts`): real `legal_entity`/`organization_unit` scope resolution end-to-end through the real adapter, tenant isolation, a same-scope SoD conflict check that is only reachable once the real adapter validates the scope, and the flat-adapter fallback (both for `organization_structure`'s own scope types and for `"office"`) when the module is disabled for a tenant.

  Scope note: this fixes scope EXISTENCE/validity resolution — SoD conflict matching (`same_scope_only`) still compares `(scopeType, scopeId)` by exact equality and does not yet consult ancestor/descendant hierarchy chains; that remains a distinct, not-yet-built feature.

- 2c8888b: Make the optional Cloudflare DNS adapter's (Issue #567, `tenant_domain`
  module) per-call network timeout configurable, closing a Low-severity
  follow-up from the `awcms-mini-security-auditor` review on PR #580: the
  timeout was previously hardcoded (`DEFAULT_TIMEOUT_MS = 8_000` in
  `cloudflare-dns-adapter.ts`) with no way to tune it per-deployment.

  Added `resolveTenantDomainCloudflareTimeoutMs(env)` to
  `tenant-domain/domain/tenant-domain-dns-config.ts`, following the exact
  same pattern `email/domain/email-config.ts`'s
  `resolveEmailSendTimeoutMs` already uses for `EMAIL_SEND_TIMEOUT_MS`:
  reads the new `TENANT_DOMAIN_CLOUDFLARE_TIMEOUT_MS` env var, falls back
  to the existing 8-second default for any unset or non-positive value,
  and is never validated by `scripts/validate-env.ts` (an invalid value
  can never fail boot — same reasoning as the email timeout). This
  adapter is still not wired into any route (Issue #567's own scope, and
  this PR does not change that) — the timeout only matters once a future
  issue wires the adapter into a real endpoint, but the config exists now
  so that issue doesn't have to add it under time pressure.

  `resolveTenantDomainDnsProvider(env)` — the production resolver — now
  passes this resolved value through to `createCloudflareDnsProvider`.

  New tests in `tests/unit/cloudflare-dns-adapter.test.ts`: unit coverage
  for `resolveTenantDomainCloudflareTimeoutMs` (default, valid override,
  non-numeric fallback, zero/negative fallback), plus a test confirming a
  resolved env-sourced timeout value is enforced the same way an existing
  test already proved for a raw `timeoutMs` number.

  Docs updated: `.env.example`, doc 18 (env reference table + Cloudflare
  adapter security note), `tenant-domain/README.md`, and skill
  `awcms-mini-tenant-domain-routing` (moved from open follow-up to "sudah
  diperbaiki").

- a6bd24f: Triage 15 open CodeQL code-scanning alerts (Issue #788): remove genuinely
  dead test imports, close 3 real test-coverage gaps the alerts incidentally
  surfaced (news-media R2 deletion assertion, social-publishing rule-list
  tenant-isolation test, LinkedIn API version resolver unit tests), and
  dismiss 2 confirmed false positives (Bun.SQL tagged-template parameter
  binding misread as implicit string coercion) plus 1 won't-fix (a
  build-time extension-seam conditional that's genuinely trivial in this
  base repo by design). No production behavior change.
- 03e99f9: Fix 2 open CodeQL `js/unused-local-variable` alerts (#52, #53) by closing the
  real coverage gaps they flagged, instead of just deleting the unused import:

  - `tests/integration/reference-data.integration.test.ts`: the imported
    `listValueSets` (`GET /api/v1/reference-data/value-sets`) handler was never
    called — the test titled "create, list, deprecate" only ever exercised the
    codes-within-a-value-set list, not the value-set-level list endpoint or its
    `status`/`scope` filters. Added assertions that the created value set
    appears in the list, and that `status=active`/`status=deprecated` correctly
    include/exclude it after deprecation.
  - `tests/integration/integration-hub.integration.test.ts`: the imported
    `listSubscriptions` (`GET /api/v1/integration-hub/subscriptions`) handler
    was never called — the end-to-end worker-role test created a subscription
    and verified dispatch via raw SQL, but never exercised the real REST list
    endpoint. Added an assertion that the created subscription appears in the
    list with the correct `targetAdapterKey`.

  No application code changed — test-only.

- e36a73f: Fix a High security-auditor finding on PR #782 (Issue #752, data_exchange
  module): `GET /api/v1/data-exchange/exports/{id}/download` — the route
  serving the raw materialized export FILE CONTENT — never called
  `authorizeExchangeDescriptorPermission` before serving it, unlike every
  other route that resolves an `ExchangeDescriptor` (stage, preview,
  commit, retry, export-create). Not live-exploitable today (no shipped
  descriptor sets `requiredPermission` yet), but a future owning module
  registering a sensitive export descriptor (e.g. payroll, HR) with its own
  `requiredPermission` would have had that gate silently skipped for
  downloads, letting any caller holding only the generic
  `data_exchange.export_downloads.read` permission download it. `download.ts`
  now resolves the job's descriptor and enforces its `requiredPermission`
  before serving content, mirroring `exports/index.ts`'s existing pattern.
- e36a73f: Fix a CI non-determinism in the `performance:query-plan:check` gate
  (Issue #744/#782, epic `platform-evolution` #738) surfaced while landing
  the `data_exchange` module (Issue #752): `scripts/performance-suite.ts`
  and `scripts/performance-query-plan-check.ts` both seed independent
  "safe"-scale synthetic fixtures into the same CI database with no reset
  between them, so `awcms_mini_audit_events` accumulates roughly double a
  single seed's row count by the time the query-plan budgets are
  evaluated — whether that run observes the intended cost or the
  inflated one then depends on PostgreSQL autovacuum's background
  `ANALYZE` timing, not a deterministic measurement. Root-caused
  empirically (including an identical reproduction on `main`, proving
  this was never specific to `data_exchange`'s own code): the same
  accumulated data costs ~11 immediately after seeding (stale,
  pre-accumulation planner statistics) but ~1088-1132 once autovacuum
  catches up. Added `resetPerformanceFixtureRows()`
  (`src/lib/performance/fixture-seeder.ts`), scoped to only
  `perf-*`-tagged synthetic fixture tenants, called by
  `performance-query-plan-check.ts` before it reseeds — bounding
  unbounded accumulation across repeated runs against a long-lived
  database. Recalibrated the `audit-events-tenant-activity-reporting`
  budget's `maxTotalCost` from 700 to 1300 in
  `src/lib/performance/query-plan-budgets.ts` (with a fresh, dated
  `approval` record) to reflect this query's real, timing-independent
  cost — it is the one registered budget with no `LIMIT`, so unlike
  every other budget its cost genuinely scales with the driving table's
  accumulated physical size in this shared CI job structure, not just
  one tenant's own row count.
- 92a9ba6: Extend `withTenant`'s database circuit-breaker exclusion (`src/lib/database/tenant-context.ts`,
  Issue #599/PR #600) to also cover Postgres SQLSTATE class `22` (data
  exception — `22P02` invalid_text_representation, `22003`
  numeric_value_out_of_range, and siblings), not just class `23` (integrity
  constraint violation).

  Follow-up from the security-auditor review of PR #600 (Issue #601): class
  `22` errors are structurally the same kind of "bad caller input, not a
  database/infra failure" outcome as class `23` — e.g. a non-UUID-shaped
  string compared/cast against a `uuid` column throws `22P02`, exactly the
  same shape of bug as the FK-violation DoS class `23` was added to guard
  against. No live endpoint exploits this today (every caller-supplied
  identifier is already format-validated via `assertUuid()` before reaching
  SQL), so this closes a structural gap rather than fixing an active
  exploit.

  `isPostgresIntegrityConstraintViolation` is renamed to
  `isPostgresClientInputError` and now checks against both SQLSTATE classes
  (`22` and `23`) via a small array, rather than a single hardcoded prefix.
  Every other error class (`08` connection exception, `53` insufficient
  resources, `57` operator intervention, plain non-Postgres errors, ...)
  still trips the breaker exactly as before — verified by two new unit
  tests in `tests/unit/tenant-context-circuit-breaker.test.ts` proving
  `22P02` and `22003` never trip the breaker across repeated failures,
  alongside the existing tests proving genuine infra failures still do.

- 43d2e44: Fix `withTenant`'s shared database circuit breaker (`src/lib/database/tenant-context.ts`)
  conflating ordinary Postgres integrity constraint violations with genuine
  database/infra failures (Issue #599).

  Security review of PR #598 (Issue #590, Google OIDC login) found that an
  unauthenticated caller could send a handful of nonexistent `tenantId`
  values to `GET /api/v1/auth/providers/google/start`, each tripping a
  foreign-key violation inside a `withTenant` transaction. Before this fix,
  `withTenant`'s catch-all treated **any** exception (other than the
  already-excluded `IdempotencyRaceLostError`) as an infra failure and
  recorded it against `getDatabaseCircuitBreaker()` — a single
  application-wide breaker shared by every tenant and every
  `withTenant`-based endpoint. Five garbage tenant ids were enough to open
  the breaker and fail every request for 30 seconds, repeatedly — a larger
  blast radius than the analogous per-provider Turnstile circuit-breaker
  bug (#596) this same epic already fixed once.

  That specific call site was already patched in PR #598 (commit `56b18ee`)
  with a `SELECT`-before-`INSERT` existence check, but the same class of
  bug exists at any call site with a foreign key or uniqueness constraint
  (e.g. `autoLinkByEmail`'s insert into
  `awcms_mini_identity_provider_accounts` under a legitimate concurrent
  request race in `src/modules/identity-access/application/google-oidc.ts`).

  `withTenant` now inspects the thrown error's Postgres SQLSTATE
  (`Bun.SQL.PostgresError#errno`) and skips `breaker.recordFailure()` for
  class `23` — integrity constraint violation (`23503`
  foreign_key_violation, `23505` unique_violation, `23514`
  check_violation, and siblings) — mirroring how `IdempotencyRaceLostError`
  was already excluded. Every other error (connection failures, timeouts,
  syntax errors, permission errors, ...) still trips the breaker exactly as
  before. This is centralized in `withTenant` itself, so none of the
  ~25+ existing endpoints need their own pre-check.

  Excluded violations are logged as `database.integrity_violation_excluded`
  (SQLSTATE + tenant id, no query data) so operators keep visibility into
  how often this happens, matching the existing `idempotency.race_lost`
  logging for the other breaker exclusion.

  New unit tests in `tests/unit/tenant-context-circuit-breaker.test.ts`
  prove: a `23505`/`23503` error thrown inside `withTenant` never trips the
  breaker even across repeated failures; a genuine Postgres infra error
  (`08006` connection failure) and a plain non-Postgres `Error` still trip
  it after the existing 5-consecutive-failure threshold; a successful call
  still resets state as before; and the new log line fires with the
  correct SQLSTATE.

- 0f8f371: Bump `docker/setup-buildx-action` GitHub Actions workflow dependency
  from 3.12.0 to 4.2.0 (Dependabot). CI infrastructure only, no
  application code changes required.
- 4525589: Repo-wide docs/skills consistency audit (Issue #805), the 4th round of this recurring
  maintenance pass (previous rounds: PR #554, #586, #768). Since the last audit
  (2026-07-13), the platform-evolution epic (#738, 17 issues) grew the module registry
  from 16 to 23 modules and landed idempotency-hash-binding and SoD hierarchy-aware
  fixes — this pass reconciles docs/skills with that new state (~55 verified findings).

  - Fixed stale "16 modules" claims (now 23) across `docs/awcms-mini/README.md`, doc 13,
    doc 21, `AGENTS.md`, `module-management/README.md`, and 3 skills.
  - Fixed `module-management/README.md`'s permission/navigation/job-ownership counts
    (grown from 7/11/8 to 17/33/16 modules).
  - Added explicit resource-identity-binding guidance and a worked code example to
    `awcms-mini-idempotency`, the skill responsible for preventing the idempotency-hash
    bug class that recurred 3 times (Issue #750/#795) — it previously had no guidance on
    this at all.
  - Fixed `awcms-mini-abac-guard`'s `AccessAction` union (16 missing members),
    `awcms-mini-audit-log`'s mandatory-audit-action list (workflow decisions, document
    void/reclassify, generic export/import, legal hold), `awcms-mini-new-module`'s stale
    `api/` folder structure, `awcms-mini-new-event`'s wire-envelope shape and channel
    count, `awcms-mini-production-preflight`'s stage count (9 → 11).
  - Corrected `src/modules/organization-structure/README.md`'s hierarchy-port
    composition function name/location after its PR #804 refactor.
  - Added 4 missing epic-skills for core modules that previously had zero dedicated
    coverage: `awcms-mini-document-infrastructure`, `awcms-mini-integration-hub`,
    `awcms-mini-workflow-approval`, `awcms-mini-profile-identity`.
  - Refreshed the stale `docs/awcms-mini/github/` snapshot (was 3 days old, claimed 35
    open issues against a real count of 0) and added narrative sections for the
    platform-evolution epic and follow-up issues #794-#804.
  - Filled operational-doc gaps: `deployment-profiles.md`'s cron table (6 missing
    platform-evolution jobs), `08_sop_operasional_user_guide.md` (zero sections for any
    platform-evolution module), and `CONTRIBUTING.md`/root `README.md`'s description of
    the `bun run check` chain (missing several sub-checks).

  No functional/runtime code changed — docs, skills, and ADR Context prose only (ADR
  Decision/Consequences text left untouched per this repo's ADR immutability policy).

- 6b59a1e: Extend `document_infrastructure`'s confidentiality-tier read gating (Issue #751/PR #780) to the module's mutation endpoints and its two remaining read paths (Issue #787, disclosed fast-follow to that Critical fix).

  - `void`, `restore`, `reclassify`, `versions.create`, `relations.assign`, and `relations.revoke` now require the caller to hold read clearance for the document's CURRENT confidentiality level (`documents_confidential.read`/`documents_restricted.read`) as a precondition — a caller holding only the action-specific permission (e.g. `documents.void`) can no longer void/restore/reclassify a `confidential`/`restricted` document, append a version to one, or link/unlink a resource relation on one, without also holding the matching tier permission. Denied attempts return the same "not found"-shaped result the read paths already use — never confirming the document's existence to an unauthorized caller.
  - `GET .../evidence` and `GET .../reservations` now filter rows tied to a document (`document_id IS NOT NULL`) by that document's confidentiality level, at the SQL level (`LEFT JOIN` + `confidentiality_level = ANY(...)`); rows with no document link (sequence-only evidence, a reservation not yet committed) always pass through, since they have no confidentiality dimension.
  - Design decision: reuses the two existing read-tier permissions (`sql/068`) as a precondition rather than introducing separate write-tier permissions — no new migration. See `docs/adr/0017-document-infrastructure-module-admission.md` §7 for the full rationale.
  - 2 new integration tests covering all 8 newly-gated endpoints (deny with only the base/action permission, allow once the tier permission is added); ADR-0017, the threat model (doc 20), and the module README's "accepted fast-follow" disclosure updated to reflect this scope now being closed.

- 91bad66: Security fix (Issue #795, recurring class first found in PR #783/#750 `reference_data`): eleven `document_infrastructure` mutation endpoints computed their `Idempotency-Key` request hash without folding in the path parameter identifying WHICH resource was being mutated. Since the idempotency store key is `(tenant_id, request_scope, idempotency_key)` and `request_scope` is shared across every resource of a type in the tenant, a client that reused the same `Idempotency-Key` across two different resources of the same type could have the second request incorrectly replay the first resource's cached response instead of being rejected or executed — silently reporting success for a resource that was never touched.

  Fixed:

  - `documents/{id}/restore` and `classifications/{id}/restore` hashed `{}` (empty, no `id` at all) — now hash `{ id, action: "restore" }`.
  - `documents/{id}` DELETE hashed `body` alone — now hashes `{ ...body, id, action: "delete" }`.
  - `classifications/{id}` DELETE hashed `body` alone — now hashes `{ ...body, id, action: "deactivate" }` (the underlying operation is a deactivation, not a hard delete).
  - `documents/{id}/relations/{relationId}` DELETE hashed `body` alone — now hashes `{ ...body, relationId, action: "unlink" }`.
  - `reservations/{id}/cancel` hashed `body` alone — now hashes `{ ...body, id, action: "cancel" }`.
  - `reservations/{id}/commit` hashed `body` alone — now hashes `{ ...body, id, action: "commit" }`.
  - `documents/{id}/void` hashed `body` alone — now hashes `{ ...body, id, action: "void" }`.
  - `documents/{id}/reclassify` hashed `body` alone — now hashes `{ ...body, id, action: "reclassify" }` (security-sensitive: this endpoint changes confidentiality level).
  - `documents/{id}/versions` POST (create version) hashed `body` alone — now hashes `{ ...body, id, action: "create" }`.
  - `documents/{id}/relations` POST (link) hashed `body` alone — now hashes `{ ...body, id, action: "link" }`.

  `sequences/revise`, `sequences/restore`, and `sequences/deactivate` were audited and found NOT vulnerable: these are index-level routes (no `[id]`/`[key]` path segment) whose resource identity (`scopeType` + `scopeId` + `sequenceKey`) is already part of the raw request body being hashed, so a reused key across two different sequences already correctly produces a different hash. `documents` POST (create), `classifications` POST (create), `sequences` POST (define), and `reservations/reserve` POST were also audited and confirmed not vulnerable — they create a brand-new resource with no pre-existing resource identity to bind the hash to.

  Adds adversarial integration tests (`tests/integration/document-infrastructure.integration.test.ts`) proving that reusing an Idempotency-Key across two different documents/classifications/relations/reservations with an identical-shaped (or empty) body yields `409 IDEMPOTENCY_CONFLICT`, that the second resource is left untouched by the false-replay attempt (asserted against real DB state — `voided_at`, `confidentiality_level`, `deleted_at`, reservation `status`/`committed_at`/`document_id`), and that it still applies correctly once given its own key. Covers all 11 fixed endpoints: restore (document + classification), delete (document + classification), void, reclassify, unlink relation, and reservation cancel/commit.

  Part of #795 (parallel module-scoped fix; `reference-data` fixed in #783/#750, `organization-structure`/`data-lifecycle`/`identity` business-scope handled in a sibling PR). An independent security-auditor pass on this PR found 4 additional endpoints (`void`, `reclassify`, `versions` create, `relations` link) beyond the original 7-endpoint scope via a required whole-module re-grep — all fixed in this same PR before merge.

- 85718fc: Fix the recurring "Idempotency-Key hash not bound to resource identity"
  defect class (Issue #795, found via the independent security-auditor
  pass on PR #783 / Issue #750) in `data_lifecycle`, `identity_access`
  business-scope, and `reporting`.

  Since the idempotency store key is `(tenant_id, request_scope,
idempotency_key)` and `request_scope` is a per-endpoint-TYPE constant
  shared across every resource of that type in a tenant, an endpoint that
  computed its request hash from the body alone (or from `{}` for a pure
  action-trigger) while the URL's path parameter identified WHICH resource
  was being mutated let a client that reused the same `Idempotency-Key`
  across two DIFFERENT resources of the same type silently replay the
  first resource's cached response for a request meant to mutate the
  second — a false "success" that masked a mutation that never executed.

  Fixed by folding the identifying path parameter(s) plus an explicit
  `action` literal into `computeRequestHash`, alongside the real body
  content where one exists:

  - `POST /api/v1/data-lifecycle/legal-holds/{id}/release`
  - `POST /api/v1/identity/business-scope/assignments/{id}/revoke`
  - `POST /api/v1/identity/business-scope/exceptions/{id}/approve`
  - `POST /api/v1/identity/business-scope/exceptions/{id}/reject`
  - `POST /api/v1/identity/business-scope/exceptions/{id}/revoke`
  - `POST /api/v1/reports/projections/{key}/rebuild/cancel` (was
    `computeRequestHash({})` — completely empty, the same shape as the
    original bug)
  - `POST /api/v1/reports/projections/{key}/rebuild` (the rebuild-trigger
    endpoint — found by an independent reviewer pass on this same PR,
    missed from the original scope; migration 069's partial unique index
    only protects against a duplicate rebuild START for the SAME
    projection, it does not protect against this HTTP-layer idempotency
    shortcut replaying a cached response before `triggerOrResumeRebuild`
    is ever called)
  - `POST /api/v1/reports/exports/{id}/disable` (same reviewer pass)

  `POST /api/v1/data-lifecycle/legal-holds` (the collection-level create
  endpoint) was audited and confirmed NOT vulnerable to this class: it has
  no `{id}`/`{key}` path parameter identifying a pre-existing resource, so
  there is no second resource whose response could be falsely replayed.

  Adds adversarial integration tests
  (`tests/integration/business-scope-assignments.integration.test.ts`,
  `tests/integration/reporting-projections.integration.test.ts`) proving
  that reusing the same `Idempotency-Key` across two DIFFERENT resources
  of the same type — including with an identical-shaped request body —
  now yields a clean `409 IDEMPOTENCY_CONFLICT`, that the second
  resource's real DB state is left untouched by the false-replay attempt,
  and that it still executes correctly once given its own distinct key —
  mirroring PR #783's test rigor.

  This is a partial fix for Issue #795, split across three parallel PRs by
  module cluster; `document-infrastructure`/`organization-structure` and
  `reference-data`'s own already-merged fix (PR #783) round out the rest
  of the repo-wide grep.

- 1c050c8: Fix a pre-existing race condition in the shared idempotency store
  (`src/modules/_shared/idempotency.ts`): two concurrent requests with the
  same `Idempotency-Key` (e.g. a client network retry racing its original
  request) could both pass `findIdempotencyRecord` under READ COMMITTED
  before either committed, and the loser's `saveIdempotencyRecord` insert
  then failed on the `awcms_mini_idempotency_keys_scope_key` unique index
  uncaught — surfacing as a raw constraint error / 500 and incorrectly
  tripping the database circuit breaker, instead of the documented
  "double submit paralel -> tidak dobel" guarantee (skill
  `awcms-mini-idempotency`).

  `saveIdempotencyRecord` now uses `INSERT ... ON CONFLICT (tenant_id,
request_scope, idempotency_key) DO NOTHING RETURNING id`. On losing the
  race, it re-`SELECT`s the now-committed winning row (guaranteed visible,
  since `ON CONFLICT` only fires against an already-committed row under
  READ COMMITTED — a still-uncommitted conflicting insert would have
  blocked instead) and compares its `request_hash`: identical payload ->
  throws a new `IdempotencyRaceLostError` carrying the winner's response to
  replay, honoring the pre-existing "hash sama -> replay" rule even under
  the race; different payload -> throws it with no replay (a genuine
  conflict). `withTenant` (`src/lib/database/tenant-context.ts`) — the
  single chokepoint every existing endpoint already calls — catches this
  error: rolls back the loser's transaction (so its mutation never
  persists), skips the circuit breaker (benign concurrency outcome, not an
  infra failure), logs `idempotency.race_lost` (a SHA-256 hash of the key,
  never the raw value, per doc 10 masking discipline), and returns either
  the replayed response or a clean `409 IDEMPOTENCY_CONFLICT`. This applies
  automatically to every idempotent endpoint in the repo (POS-style
  posting, blog lifecycle actions, workflow decisions, tenant domain
  `verify`/`set-primary`, email announcements, form-draft submit, etc.)
  without touching any of the individual route files.

  New regression tests in
  `tests/integration/tenant-domain-api.integration.test.ts`: "set-primary
  under concurrent SAME Idempotency-Key + SAME payload" fires two parallel
  requests with an identical key and identical target against the real
  database and asserts both get 200 (the winner's mutation and the loser's
  transparent replay), exactly one audit event, and exactly one persisted
  idempotency key row; "verify under concurrent SAME Idempotency-Key +
  DIFFERENT payload" (using two different domains, deliberately avoiding
  `set-primary`'s own unrelated primary-dedup race) asserts exactly one 200
  and one clean `409 IDEMPOTENCY_CONFLICT` — never two 200s, never a 500.

- 9c96fd2: Vendor the upstream `cahyadsn/wilayah` (MIT License) source dataset and
  provenance metadata under `data/idn-admin-regions/` (Issue #656, epic
  #654 — master data wilayah administratif Indonesia, following #655's
  module scaffold). Adds `README.md`, `NOTICE.md` (upstream attribution +
  official-reference caveat), `manifest.schema.json`, `manifest.json`
  (dataset code, upstream repo/commit SHA/license, file list with SHA-256
  checksums), a top-level `checksums.sha256`, and
  `upstream/cahyadsn-wilayah/` (verbatim upstream `LICENSE`, `SOURCE.md`
  recording the imported commit SHA/timestamp/file list, a scoped
  `checksums.sha256`, and the four raw `db/*.sql` files named in the issue
  — `wilayah.sql`, `wilayah_pulau.sql`, `wilayah_penduduk.sql`,
  `wilayah_luas.sql`).

  No code, schema, or endpoint changes — pure third-party data vendoring.
  Adds a `.gitattributes` rule (`data/idn-admin-regions/upstream/**
binary`) so Git never normalizes these vendored files' line endings
  (upstream `wilayah.sql` ships CRLF), which would otherwise silently
  mutate the committed bytes and invalidate the recorded checksums.

- b41265a: Define module admission, lifecycle, and registry governance policy (Issue #696, epic #679 platform-hardening). No code change — documentation only.

  Adds `docs/awcms-mini/21_module_admission_governance.md`: five module categories (Core, System, Official Optional Module, Derived Application, External Integration) with a decision tree for where a new capability belongs, admission criteria per category, required vs optional capability dependency rules (building on ADR-0011's `capabilities.consumes[].optional`), offline/LAN-safe vs full-online-only compatibility expectations (tied to `src/lib/config/registry.ts`'s existing `profiles` field), an external-provider/data-governance review checklist, ownership/maintenance model, and deprecation/removal policy. Maps the 14 currently registered modules (`src/modules/index.ts`) to these categories (3 Core, 9 System, 2 Official Optional Module) and documents four remediation gaps found while mapping them: inconsistent `ModuleDescriptor.type` field usage (only 5/14 modules set it), `isCore` set on only one module (`module_management`) despite three modules meeting this policy's Core definition, the unused `maintainers` field, and a stale module list in `AGENTS.md` §Peta modul — none fixed in this PR (tracked as follow-ups, out of atomic scope for a docs-only issue).

  Also adds ADR-0012 (trusted static registry boundary — explicit, non-negotiable prohibition on marketplace/runtime code upload/install, reaffirming ADR-0001/ADR-0002), two lightweight templates (`docs/awcms-mini/templates/module-proposal-template.md`, `module-admission-decision-checklist.md`), and links the new policy from `.github/ISSUE_TEMPLATE/feature_request.yml`, `.github/PULL_REQUEST_TEMPLATE.md`, and the `awcms-mini-new-module`/`awcms-mini-module-management` skills.

- 4f03be1: Close a gap flagged as a non-blocking follow-up during the epic #555
  security audit chain: `validateModuleSettingsPatch`
  (`src/modules/module-management/domain/module-settings.ts`, the shared
  validator behind every `PATCH /api/v1/tenant/modules/{moduleKey}/settings`
  call across every module) only rejected secret-_named_ keys
  (`_shared/redaction.ts`'s `REDACTION_KEYS`). An admin could still paste a
  real credential into an innocently-named field — e.g. a JWT or
  `Bearer ...` token into `publicLabel` — and have it stored raw in
  `awcms_mini_module_settings` and returned as-is via `GET`.

  Added `findSecretShapedValues` to `src/modules/_shared/redaction.ts`: a
  value-shape complement to the existing key-name check, scanning every
  string value (recursively through nested objects/arrays) against a
  deliberately conservative pattern set chosen to keep false positives near
  zero — a JWT (three base64url segments), a PEM private key block, an AWS
  access key id, a raw `Bearer `/`Basic ` header value, or a connection
  string with an embedded `user:pass@` credential. Ordinary labels, URLs,
  and feature flags never match.

  `validateModuleSettingsPatch` now calls this after the existing key-name
  check and rejects with a new `SETTINGS_SECRET_SHAPED_VALUE_REJECTED`
  (`400`) error code when a match is found — the rejection message names
  only the offending key path, never the value itself. The one route file
  (`tenant/modules/{moduleKey}/settings.ts`) is already generic over
  `ModuleSettingsErrorCode`, so this applies to every module on the
  settings framework with zero route changes.

  New tests: `tests/audit-log.test.ts`'s `findSecretShapedValues` (unit —
  every pattern, plus a case proving ordinary label/URL/flag values are
  never flagged) and
  `tests/integration/module-settings.integration.test.ts`'s "PATCH rejects
  a secret-shaped VALUE under an innocently-named key" (integration,
  against the real database).

- 5af9269: Document the target full-online R2-only media architecture and SOP for
  the new `news_portal` epic (Issue #631, epic #631-#642 plus downstream
  #649 and the dependent `social-publishing` epic #643-#647) — no code,
  migration, or endpoint changes in this issue.

  Adds `docs/awcms-mini/news-portal/`: `full-online-r2-architecture.md`
  (scope/assumptions, the key decision to keep news media on a **separate**
  R2 bucket and credentials from `sync-storage`'s existing private object
  sync queue, the `NEWS_MEDIA_R2_*` env var naming convention, object key
  convention, upload flow diagrams, presigned URL lifecycle, MIME/
  extension/checksum validation order, CORS, custom domain, Cache-Control,
  credential rotation, and a practical mapping to ISO/IEC 27001, 27002,
  27005, 27017, 27018, 27701, 27034, ISO 22301, OWASP ASVS, and OWASP API
  Security Top 10), `r2-upload-sop.md`, `r2-security-checklist.md`,
  `r2-incident-response.md`, `r2-backup-lifecycle.md`, and
  `newsroom-user-guide.md`.

  Adds skill `.claude/skills/awcms-mini-news-portal/SKILL.md` summarizing
  the architecture decisions for follow-up issues #632-#642/#649, with a
  per-issue status table (#631 done, the rest not started with a scope
  summary each) so later issues don't need to re-read the full GitHub
  issue bodies. Registers the skill in `AGENTS.md` and
  `.claude/skills/README.md`, and links the new docs from
  `docs/awcms-mini/README.md` and `docs/awcms-mini/deployment-profiles.md`
  (explicit: this mode does not apply to offline/LAN deployments).

- d9b21f8: Narrow the read surface of the anonymous public `/news` module-enabled
  gate, closing a non-blocking follow-up from the epic #555 security audit
  chain (found auditing Issue #560, tracked in
  `.claude/skills/awcms-mini-tenant-domain-routing/SKILL.md` as a
  "consider as an optional narrowing" item — not a real DoS risk, but
  unnecessary read surface for an unauthenticated code path).

  `blog-content`'s `public-news-tenant-resolution.ts` only needs
  `blog_content`'s own tenant-enabled state, but was calling
  `fetchTenantModuleEntries` — which reads every registered module's row
  for the tenant and filters in memory — to get it.

  Added `fetchTenantModuleEntry(tx, tenantId, moduleKey)` to
  `module-management/application/tenant-module-lifecycle.ts`: a
  single-module narrowing that filters `module_key` in the `SQL` itself,
  returning `null` only if `moduleKey` isn't a registered descriptor.
  Same opt-out-by-default semantics as the existing plural function (no
  `awcms_mini_tenant_modules` row means `tenantEnabled: true`).
  `fetchTenantModuleEntries` (plural) is unchanged and still used by its
  three other consumers that genuinely need the full list: the
  `GET /api/v1/tenant/modules` endpoint, tenant module presets, and the
  tenant-module matrix admin UI.

  `checkBlogContentAndRouteGate` (the one function both the real `/news`
  resolve path and the Issue #562 timing-parity padding path call) now
  uses the singular lookup — since both paths share this one function,
  the round-trip count for the module-enabled check stays identical (a
  single query either way), so the existing timing-parity guarantee is
  unaffected.

  New test: `tests/integration/module-tenant-lifecycle.integration.test.ts`'s
  "fetchTenantModuleEntry ... matches the plural function's per-entry
  result before and after a real disable" (also covers the unknown-module
  -> `null` case). The pre-existing round-trip-parity tests in
  `tests/integration/blog-content-public-news.integration.test.ts` pass
  unchanged, confirming the query-count parity holds with the new
  function.

- 95384d3: Fix a High-severity idempotency defect in `organization_structure` (Issue #795, found by an independent security-auditor pass on Issue #750 / PR #783 across `reference_data`, then confirmed present in other modules via a repo-wide `computeRequestHash(` grep). Ten mutation endpoints computed their `Idempotency-Key` request hash without folding in the path parameter identifying which resource was being mutated: `unit-types/{id}/restore`, `units/{id}/restore`, `locations/{id}/restore`, `legal-entities/{id}/restore`, and `location-unit-relationships/{id}/end` hashed an empty object (`{}`); `units/{id}` `DELETE`, `unit-types/{id}` `DELETE`, `legal-entities/{id}` `DELETE`, `locations/{id}` `DELETE`, and `assignments/{id}/end` hashed the request body alone (which never contains the resource id). Since the idempotency store key is `(tenant_id, request_scope, idempotency_key)` and `request_scope` is shared across every resource of a type in a tenant, a client reusing the same `Idempotency-Key` across two different resources of the same type would have the second request silently replay the first resource's cached response instead of being rejected or executed — a false "success" for a resource that was never touched.

  All ten now fold the identifying path parameter(s) plus an explicit `action` literal into the hash (restore/end endpoints: `computeRequestHash({ id, action: "restore" })`; `DELETE` endpoints: `computeRequestHash({ ...body, id, action: "delete" })`, preserving the real body content), matching the convention `reference_data`'s fix established. `hierarchy/reparent` and `assignments` (create) were audited and left unchanged: the former already carries `organizationUnitId` inside the hashed body (no separate path parameter), and the latter is a create endpoint with no pre-existing resource identity to collide on.

  Adds adversarial integration tests (`tests/integration/organization-structure.integration.test.ts`) proving that reusing an Idempotency-Key across restore, deactivate (`DELETE`), and assignment-end of two different resources with an identical-shaped body/no body yields `409 IDEMPOTENCY_CONFLICT`, that the second resource's real DB state is left untouched by the false-replay attempt, and that it still applies correctly once given its own key.

  Part of Issue #795 — the same defect class is being fixed in parallel in `document-infrastructure` and other affected modules.

- 5c94ddd: Bump `prettier` devDependency from 3.9.4 to 3.9.5 patch release
  (Dependabot). Formatting-tool devDependency, no runtime or repository
  code changes required.
- 74b82fd: Add adversarial cross-resource Idempotency-Key-reuse regression tests
  (Issue #796) for `reference-data` `tenant-codes/{id}` and
  `value-sets/{key}/codes/{code}` `PATCH`/`DELETE`, the two endpoint pairs
  `tests/integration/reference-data.integration.test.ts` never exercised
  after PR #783's (Issue #750) round-2 idempotency-hash fix. Each new test
  proves reusing an Idempotency-Key across two different resources of that
  type with an identical-shaped body yields `409 IDEMPOTENCY_CONFLICT`
  (re-fetching the second resource to confirm it was not silently mutated),
  and that the second resource's own distinct key then genuinely applies its
  mutation. No production behavior change — closes the last known
  test-coverage gap from the idempotency-hash-not-bound-to-resource-id defect
  class across all 11 originally-affected endpoints.
- b1f35c2: Harden the shared secret/PII redaction utility (`src/modules/_shared/redaction.ts`,
  Issue #785) — surfaced independently by two security audits during epic
  #738 Wave 3 (PR #783/#750 reference-data, PR #784/#754 integration-hub).

  `findSecretShapedValues`/`SECRET_VALUE_PATTERNS` (used to reject a
  credential-shaped value pasted into an innocently-named module settings
  field, e.g. `publicLabel`) and `redactSecretsInText`/`TEXT_SECRET_PATTERNS`
  (the free-text complement used by admin-page/CLI-worker error logging)
  previously only recognized JWT/PEM/AWS-`AKIA`/`Bearer|Basic`/embedded
  connection-string credential shapes. Both now also detect common vendor
  secret-key formats: GitHub personal access token (`ghp_...`) and
  fine-grained PAT (`github_pat_...`), OpenAI key (`sk-proj-...`/`sk-...`),
  Slack bot/user OAuth token (`xoxb-...`/`xoxp-...`) and incoming-webhook URL
  (`hooks.slack.com/services/...`), Stripe secret key
  (`sk_live_...`/`sk_test_...`), and Google API key (`AIzaSy...`). Each
  pattern keeps a minimum-length floor after its prefix so a short,
  innocuous value that merely shares a prefix (e.g. a `sk-`-prefixed SKU
  code) is never false-flagged. A generic high-entropy-string backstop was
  evaluated and deliberately NOT added — this codebase legitimately stores
  many long, high-entropy-looking values (UUID keys, content hashes,
  idempotency keys) that would false-positive constantly at this
  cross-module layer; sticking to explicit vendor patterns keeps the
  false-positive rate near zero (documented residual: any secret shape not
  on the list is still undetected).

  New sibling function `redactSensitiveJsonValue` recurses into a top-level
  JSON _array_ (not just a top-level object, which is all
  `redactSensitiveAttributes` has ever handled) — for a future consumer
  whose payload is an array of records (e.g. a batch-webhook provider body)
  rather than a single object. Purely additive: every existing call site
  (`logging/application/audit-log.ts`, `lib/logging/logger.ts`,
  `domain-event-runtime/domain/payload-redaction.ts`) keeps calling the
  unchanged `redactSensitiveAttributes` and is unaffected.

  Adversarial unit tests added for every new vendor shape (fabricated,
  non-canonical fixtures — same convention as the existing JWT fixture, to
  avoid tripping GitGuardian's own shape-based secret scanning on this PR),
  the array-recursion case, and negative fixtures (UUID, content hash, a
  short `sk-`-prefixed code, an ordinary webhook URL) confirming no
  over-blocking.

  **PR #791 review round follow-up** (both fixed in the same PR before
  merge): added the same-privilege-class sibling prefixes the reviewer/
  security-auditor found still slipped through — GitHub OAuth/GitHub-App
  tokens (`gho_`/`ghu_`/`ghs_`/`ghr_`), Slack app-level/rotated/legacy
  tokens (`xoxa-`/`xoxe-`/`xoxe.xoxp-`/`xoxs-`), Stripe restricted keys
  (`rk_live_`/`rk_test_`) and webhook signing secret (`whsec_`), and
  OpenAI's newer service-account/admin key families
  (`sk-svcacct-`/`sk-admin-`) — and tightened the classic OpenAI key floor
  from `{20,}` to `{40,}` (matching this file's own comment that real
  classic keys run ~48 characters). Also fixed a fixed-length-match design
  flaw in the free-text `ghp_`/`AIzaSy` patterns: they previously matched
  an EXACT character count, so a real token a few characters longer than
  expected left its extra tail sitting in plaintext right next to the
  `[REDACTED_*]` tag — both now match a MINIMUM length instead, sweeping
  any same-charset tail into the redaction.

- b3d01c1: Fix (Issue #802, follow-up to #794/PR #800, epic #738 platform-evolution):
  close the residual `checkHighRiskSoDConflicts` hierarchy-matching gap Issue
  #794 explicitly left open. `detectSoDConflicts`'s `"same_scope_only"`
  hierarchy-aware matching (#794) was previously wired ONLY into
  `createBusinessScopeAssignment` — the OTHER `same_scope_only` call site,
  `checkHighRiskSoDConflicts` (`src/modules/identity-access/application/high-risk-sod-guard.ts`),
  wired at the generic `authorizeInTransaction` chokepoint (`access-guard.ts`)
  shared by ~124 route files, still compared `sodScopeType`/`sodScopeId` by
  exact equality only — an actor holding `.revoke` via an ordinary RBAC role
  plus a business-scope `.create` fact at an ancestor `organization_unit`
  could revoke a descendant-scope assignment without tripping
  `business_scope_assignment_scope_maker_checker` through this path. Because
  `detectSoDConflicts` found no match, this near-miss also generated ZERO
  telemetry (`sod_conflicts_detected_total` never fired), contradicting
  #794's own "if not fixed, at minimum add monitoring" fallback requirement.

  Investigation found the real exploitable surface much narrower than "124
  route files": only ONE caller of `authorizeInTransaction`,
  `.../business-scope/assignments/[id]/revoke.ts`, has ever populated
  `resourceAttributes.sodScopeType`/`.sodScopeId` — every other caller
  already gets `requestedScope: null`, which a `same_scope_only` rule already
  treats as `indeterminate: true` (default-deny), not a silent gap.

  `checkHighRiskSoDConflicts`/`authorizeInTransaction` now accept an OPTIONAL
  `hierarchyPort` parameter, resolved LAZILY only when both a
  `requestedScope` is supplied and a `hierarchyPort` is passed — every other
  caller today passes neither, so their behavior is byte-for-byte unchanged
  (zero new queries, zero regression risk across the other ~123 route
  files). Only `revoke.ts` now composes the real `BusinessScopeHierarchyPort`
  (the same `organization_structure` adapter composition
  `assignments/index.ts` already uses for the create path, factored into
  `src/pages/api/v1/identity/business-scope/hierarchy-port-composition.ts`
  so both routes share one composition root instead of duplicating it) and
  passes it in. Since the detection gap is closed at the source, the
  previously-silent near-miss now correctly fires
  `recordSoDConflictEvaluation`/`sod_conflicts_detected_total` through the
  already-existing mechanism — no separate monitoring code needed.

  Added an adversarial integration test proving a `.create` grant at a
  parent `organization_unit` (via a business-scope assignment) plus
  `.revoke` via an ordinary RBAC role can no longer revoke a DIFFERENT
  subject's assignment at a hierarchy-descendant unit through this
  chokepoint (`tests/integration/business-scope-organization-structure-wiring.integration.test.ts`,
  "Issue #802 adversarial" — now `403 SOD_CONFLICT`, recorded with
  `trigger_context: "high_risk_decision"`).

- 31e88bd: Fix (Issue #794, follow-up to #786/#790, epic #738 platform-evolution): make
  `detectSoDConflicts`'s `"same_scope_only"` segregation-of-duties matching
  hierarchy-aware. Before this fix, a `same_scope_only` rule (e.g.
  `identity_access.business_scope_assignment_scope_maker_checker`) matched
  only on EXACT `(scopeType, scopeId)` equality — a subject holding
  `business_scope_assignments.create` at a parent `organization_unit` could
  be granted `.revoke` at a hierarchically-related child unit without
  tripping the conflict rule, even though both scopes belong to the same
  business hierarchy the rule was meant to bound. This was purely theoretical
  before PR #790 wired the real `organizationStructureHierarchyPortAdapter`
  into production (the hierarchy port always resolved `false` for
  `legal_entity`/`organization_unit` before that) — #790 made it practically
  reachable.

  `detectSoDConflicts` (`src/modules/identity-access/domain/sod-conflict-evaluation.ts`)
  now accepts an optional `RequestedScope.relatedScopes` list; a held fact
  whose scope appears in that list (the requested scope's own
  `ancestorScopes`/`descendantScopes`) is now treated as a scope match, same
  as exact equality or the existing null-scope "ordinary RBAC grant matches
  every scope" case. `createBusinessScopeAssignment`
  (`application/business-scope-assignment-service.ts`) wires this from the
  hierarchy-port resolution it already fetches to validate the requested
  scope — no additional hierarchy-port call is introduced. A caller that
  never resolves hierarchy (e.g. identity-access's own flat "office" scope
  adapter) simply omits `relatedScopes`, so its exact-match-only behavior is
  unchanged.

  Not exploitable across tenant/RLS boundaries and does not bypass ABAC
  default-deny — the documented residual limitation (the generic
  `authorizeInTransaction`/`checkHighRiskSoDConflicts` chokepoint used by
  ~124 route files across many modules still has no hierarchy port wired in
  and still compares scope by exact equality) is called out explicitly in
  `src/modules/identity-access/README.md` and
  `docs/awcms-mini/20_threat_model_security_architecture.md`, not silently
  absorbed into this fix's claim.

  Added an adversarial integration test proving a `.create` grant at a
  parent `organization_unit` now blocks a subsequent `.revoke` grant at a
  real hierarchy-descendant child unit
  (`tests/integration/business-scope-organization-structure-wiring.integration.test.ts`),
  plus pure unit tests for the new `relatedScopes` matching
  (`tests/unit/sod-conflict-evaluation.test.ts`).

- 5daca2e: Cap the number of active tenant OIDC SSO providers a tenant may configure
  (Issue #612, follow-up from the second security-auditor review of Issue
  #610/PR #611).

  Once #610 correctly scoped every `generic-oidc-client.ts` cache/circuit-
  breaker by `${tenantId}:${providerKey}`, each new `awcms_mini_auth_providers`
  row a tenant creates gets its own fully independent probing budget. Without
  a cap, a malicious/compromised tenant admin (the same threat actor already
  accepted for #603/#610 — this requires the existing
  `identity_access.sso_providers.create` ABAC permission) could register an
  unbounded number of provider rows, each pointing at a different internal
  target, to multiply their total internal-network probing volume linearly.

  `POST /api/v1/identity/sso/providers` now rejects with
  `409 SSO_PROVIDER_LIMIT_EXCEEDED` once a tenant's count of active
  (non-soft-deleted) provider rows reaches `AUTH_SSO_MAX_PROVIDERS_PER_TENANT`
  (default 20, `resolveSsoMaxProvidersPerTenant` in `src/lib/auth/sso-config.ts`).
  The count-then-insert check in `createAuthProvider` is deliberately not made
  atomic (no `SELECT ... FOR UPDATE`) — this bounds a probing budget, it is
  not a security invariant like MFA replay prevention. A security-auditor
  pass empirically load-tested this with concurrent bursts against a real
  Postgres instance: a single burst can land more rows than `limit` (bounded
  by the app's shared "interactive" work-class concurrency semaphore, not
  merely "one or two"), but the overshoot does not compound across repeated
  bursts — every later create re-reads the already-committed count and is
  correctly rejected. A single bounded overshoot, not an unbounded or
  repeatable bypass, so it remains harmless for what this defends against.

- fbe907e: Harden the unauthenticated `GET /api/v1/auth/sso/{providerKey}/start` endpoint
  against internal-network probing (Issue #610, follow-up from the Issue #603
  SSRF risk-acceptance decision for tenant-configured OIDC `issuer_url`).
  Narrows — does not eliminate, and does not reopen — the residual risk that
  ABAC on provider CRUD only gates who can _configure_ a malicious
  `issuer_url`, not who can _trigger_ the resulting fetch, since `/start` is
  unauthenticated by design.

  This changeset went through two rounds of security review before landing
  in its final shape — both catches are documented here since they're
  directly relevant to anyone extending this code later:

  **Critical fix, actually pre-existing since Issue #591**: every
  cache/circuit-breaker in `src/lib/auth/generic-oidc-client.ts`
  (`discoveryCache`, `jwksCache`, and the three provider circuit breakers)
  was keyed by `providerKey` ALONE. `provider_key` is only unique PER TENANT
  (`awcms_mini_auth_providers`'s unique index is `(tenant_id, provider_key)`),
  so two different tenants naming a provider "okta" (extremely common) shared
  the same cache entry and circuit-breaker state. A malicious tenant admin
  (already needs the same `identity_access.sso_providers.create` privilege
  level this epic already treats as a threat actor) could register a
  provider under a common vendor slug pointing at an attacker-controlled
  server, and have that attacker-controlled `authorization_endpoint`/
  `jwks_uri` served to a completely unrelated tenant's identically-named,
  legitimately-configured provider — redirecting the victim tenant's real
  SSO users to a phishing page and/or letting the attacker forge ID tokens
  their own JWKS would "correctly" verify. `discoverOidcConfiguration`,
  `fetchProviderJwks`, and `exchangeAuthorizationCode` all now take a
  `tenantId` parameter and key every cache/breaker by
  `${tenantId}:${providerKey}`. New unit test
  (`tests/unit/generic-oidc-client.test.ts`) and integration test
  (`tests/integration/tenant-sso-flow.integration.test.ts`) both prove two
  tenants using the same `providerKey` string get fully independent results.

  **Design correction — an earlier draft of this same changeset introduced a
  new bug**: that draft added an aggregate (not per-source) rate limit on
  `/start`, keyed by `${tenantId}:${providerKey}`, intended to bound a
  prober rotating source IPs against one target. A second security-auditor
  pass found this SHARED budget was itself a privilege-free denial-of-service
  vector: anyone, from as few as 3 source IPs, could exhaust the entire
  budget and lock out every legitimate user of that tenant's SSO login for
  the rate-limit window, repeatedly — the review's own test for that
  mechanism inadvertently proved it. That aggregate rate limit has been
  removed entirely. The actual defense against sustained probing is the
  now-correctly tenant+provider-scoped circuit breaker (opens after
  consecutive failures, fails fast for 30s) plus the negative-TTL failure
  cache below — both only ever throttle FAILING attempts, so neither can
  ever block a legitimate login to a healthy provider, unlike a shared HTTP-level
  rate limit that blocks every request regardless of outcome.

  - `src/lib/auth/generic-oidc-client.ts`'s `discoverOidcConfiguration` and
    `fetchProviderJwks` cache FAILED attempts for 30 seconds
    (`discoveryFailureCache`/`jwksFailureCache`, keyed by
    `${tenantId}:${providerKey}`). Previously, a target that never returns a
    valid OIDC document got a fresh live network attempt on every single
    unauthenticated `/start` hit; now repeated hits within the negative-TTL
    window return the same cached failure instantly.
  - Documented an infra-layer recommendation in
    `docs/awcms-mini/deployment-profiles.md` (§Generic tenant OIDC SSO): for
    `full_online` deployments (the only profile where this feature is
    reachable, and the profile most likely to run on cloud infrastructure),
    operators should block/restrict the app container's egress to the cloud
    metadata endpoint (`169.254.169.254`) at the network/firewall level, or
    enforce IMDSv2 with hop-limit=1.

  Follow-up filed as Issue #612 (non-blocking): no cap exists on how many
  `awcms_mini_auth_providers` rows a single tenant can create, so a malicious
  tenant admin could still register many provider rows (each getting its own
  independent, now correctly-scoped, cache/breaker budget) to multiply total
  probing volume linearly with row count. Deferred per this repo's established
  convention of closing what's asked and filing narrow follow-ups rather than
  scope-creeping a single PR — the two Critical findings above (cross-tenant
  leakage, self-inflicted DoS) were fixed in this same changeset since they
  were regressions/gaps in the mechanism this PR itself claims to fix, not
  pre-existing out-of-scope concerns.

- 448dd02: Close Issue #603 (follow-up from the manual review of PR #602/Issue #591)
  as a documented, explicit decision — no code change.

  `awcms_mini_auth_providers.issuer_url` (generic tenant OIDC SSO) is the
  only outbound URL in this codebase that comes from tenant-admin data
  rather than server-side environment configuration, unlike every other
  provider adapter (R2, Mailketing, Cloudflare DNS/Turnstile), which all
  follow a documented "SSRF-safe" convention. Issue #603 asked whether to
  add IP-range blocking (resolve hostname, reject private/loopback/
  link-local/cloud-metadata ranges) before the discovery/JWKS/token-exchange
  fetches in `generic-oidc-client.ts`.

  **Decided: do not add IP-range blocking.** This generic SSO feature only
  activates in the `full_online` deployment profile, which still often
  needs to reach an enterprise tenant's on-prem IdP (Keycloak/ADFS) over a
  private VPN/tunnel path — a "bring-your-own-IdP" pattern common in
  multi-tenant SaaS. A blanket private-IP block would break that legitimate
  pattern.

  **Correction from an initial draft of this decision** (caught by a
  security-auditor pass before merge): the first version of this writeup
  incorrectly invoked "AWCMS-Mini's LAN-first/offline deployment support"
  as the rationale — but this feature is gated to activate _only_ in the
  `full_online` profile, the opposite of LAN-first/offline, which never
  loads this code path at all. The corrected rationale above (enterprise
  on-prem IdP reachable via VPN, from a `full_online` deployment) is what
  actually applies. The writeup also initially overstated how much the
  existing ABAC gate mitigates this: ABAC on
  `identity_access.sso_providers.create`/`update` only limits who can
  _configure_ a malicious `issuer_url` — it does not limit who can _trigger_
  the outbound fetch afterward, since `GET /api/v1/auth/sso/{providerKey}/start`
  is unauthenticated and only rate-limited per-source+tenant (not per
  `providerKey`), with a discovery cache that only fills on success. This
  residual is now documented explicitly as accepted alongside the "no IP
  blocking" decision, rather than implied to already be closed by ABAC.

  Documented in `docs/awcms-mini/20_threat_model_security_architecture.md`
  (A10 SSRF row + §Batasan yang dicatat), the `awcms-mini-auth-online-hardening`
  skill (§SSRF/`issuer_url`), and an inline code comment in
  `src/lib/auth/generic-oidc-client.ts`, so this reads as a deliberate,
  accurately-scoped decision if revisited later — including a list of
  cheap, not-yet-implemented follow-ups (per-`providerKey` rate limiting,
  negative-TTL caching on failed discovery attempts, an infra-layer
  recommendation to block cloud-metadata-endpoint egress for `full_online`
  deployments, and a possible future opt-in strict-SSRF mode) that don't
  require revisiting the core "no blanket IP blocking" call.

- b1f36a3: Bump `@types/node` devDependency from 26.1.0 to 26.1.1 patch release
  (Dependabot). Type-only devDependency, no runtime or repository code
  changes required.
- 7086f8f: Bump `typescript` devDependency from 6.0.3 to 7.0.2 (Dependabot). Also
  fixes a real typecheck regression the upgrade surfaced:
  `scripts/lib/docs-checks.mjs`'s `checkMermaid` JSDoc comment contained an
  unescaped literal triple-backtick (` ```mermaid `) with no matching
  close before the comment's `@param` tags. TypeScript 7's stricter JSDoc
  parser toggles an internal "inside a fenced code block" state on any raw
  run of 3+ backticks; the unmatched opener left it toggled on for the rest
  of the comment, silently swallowing the following `@param` tags and
  turning `file`/`lines` into implicit `any` (`TS7006`). Reworded the
  comment to avoid backticks entirely rather than relying on a
  backtick-count-parity escape, since parity is fragile and easy to break
  again silently. No runtime behavior change.

Semua perubahan penting pada AWCMS-Mini dicatat di file ini.

Format mengikuti [Keep a Changelog](https://keepachangelog.com/id/1.1.0/) dan proyek ini menganut [Semantic Versioning](https://semver.org/lang/id/). Entri versi dihasilkan/dikonsumsi lewat [Changesets](.changeset/README.md) (`bun run changeset` → `bun run changeset:version`).

## [Unreleased]

## [0.23.5] - 2026-07-06

### Added

- **Aktivasi sistem log & manajemennya** (Issue #447, milestone M9 — issue baru berdiri sendiri, bukan bagian epic M9 5/5 yang sudah closed): tiga gap operasional yang sebelumnya tercatat eksplisit sebagai backlog (`src/modules/logging/README.md` §Belum tersedia, doc 20 §Matrix kepatuhan A.8.16) kini ditutup.
  - **Correlation ID full-propagation**: `ApiMeta.correlationId` sebelumnya hanya diwiring end-to-end ke satu endpoint demo (`GET /logs/audit`). Kini konsisten muncul pada **seluruh** respons JSON `/api/*` — diisi dari satu titik baru (`src/lib/logging/correlation-response.ts`, dipasang di `src/middleware.ts`) yang mengisi `meta.correlationId` bila handler belum mengisinya sendiri, bukan dengan mengedit puluhan file handler satu per satu. Diverifikasi live: `GET /api/v1/health`, `POST /api/v1/setup/initialize`, `POST /api/v1/auth/login`, `GET /api/v1/reports/tenant-activity` (sebelumnya tidak pernah mengisi `meta.correlationId`) kini konsisten mengisinya; endpoint yang sudah eksplisit (`GET /logs/audit`) tidak tertimpa.
  - **Retensi/purge `awcms_mini_audit_events`**: kebijakan retensi eksplisit (default **730 hari**, dikonfigurasi via `AUDIT_LOG_RETENTION_DAYS`, doc 18) + mekanisme purge (`purgeExpiredAuditEvents`, `src/modules/logging/application/audit-purge.ts`) dijalankan oleh job CLI terjadwal baru `bun run logs:audit:purge` (`scripts/audit-log-purge.ts`, pola sama seperti dispatcher Issue #436) — bukan endpoint publik. Purge berbatch (`DELETE ... LIMIT 5000` per pass per tenant), berbasis umur murni (tidak memutus FK), dan aksi purge itu sendiri direkam sebagai audit event baru (`action='purge'`) — tidak pernah purge diam-diam. Diverifikasi live terhadap Postgres nyata: 7 event lama (800 hari) terhapus, event baru tetap ada, event purge tercatat dan terbaca lewat `GET /logs/audit`.
  - **Extension point observability**: dua hook opsional default no-op, tanpa dependency baru — `setLogSink()` (`src/lib/logging/logger.ts`) dan `setAuditExportHook()` (`src/modules/logging/application/audit-log.ts`). Aplikasi turunan bisa memasang consumer log/audit (alerting, export, SIEM) tanpa mengubah kode inti; keduanya menelan error dari consumer (tidak pernah menjatuhkan aplikasi/menggagalkan transaction pemanggil). Bukan implementasi SIEM nyata — batas scope A.8.16 dari Issue #437 tidak berubah, hanya titik pemasangannya yang kini tersedia.
  - `LOG_LEVEL` diverifikasi tetap dihormati (regresi-check, bukan fitur baru) — tidak ada perubahan kode, hanya konfirmasi ulang lewat test yang sudah ada (`tests/logger.test.ts`).
  - Tidak ada migration SQL baru — tidak ada kolom/tabel/permission baru yang dibutuhkan; `bun run db:migrate` tetap 18 migration sebelum/sesudah.

## [0.23.4] - 2026-07-06

### Added

- **Security hardening berbasis standar OWASP Top 10 / ASVS / ISO 27001** (Issue #437, milestone M9 — pakai skill `awcms-mini-security-hardening`, issue terakhir epic M9): matrix kepatuhan baru di `docs/awcms-mini/20_threat_model_security_architecture.md` §"Matrix kepatuhan OWASP / ASVS / ISO 27001" memetakan kontrol yang sudah ada (ABAC default-deny, RLS FORCE, audit append-only, redaction, argon2id, HMAC sync) ke OWASP Top 10 (2021) 10/10 terpenuhi, ASVS L1/L2 8/8 area terpenuhi, dan ISO/IEC 27001:2022 Annex A 9/10 terpenuhi (1 di luar scope kode: A.8.16 monitoring/SIEM terpusat, tanggung jawab lapisan operasional aplikasi turunan) — setiap baris disertai bukti konkret (path file/fungsi/query), bukan asumsi.
- **Security response headers** (`src/lib/security/security-headers.ts`, dipasang di `src/middleware.ts` untuk setiap response): `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, `Strict-Transport-Security` (digerbang `APP_ENV=production`). Sebelumnya tidak satupun ada — gap nyata ditemukan lewat grep repo, ditutup di PR ini.
- **Content-Security-Policy** memakai fitur bawaan Astro `security.csp` (`astro.config.mjs`), bukan nonce/hash manual. Dua pendekatan manual dicoba lebih dulu dan dibatalkan setelah verifikasi **headless-Chrome/CDP nyata** (curl tidak bisa mendeteksi pelanggaran CSP karena tidak mengeksekusi JS/CSS): nonce per-request dihapus diam-diam oleh compiler Astro dari atribut `is:inline`; hash manual untuk satu skrip `is:inline` yang diketahui ternyata melewatkan beberapa skrip/style lain yang di-inline Astro per-komponen (`ThemeToggle.astro`, `LanguageSwitcher.astro`, tombol logout) dan benar-benar memblokir fungsinya (tombol tema tidak merespons klik) saat diverifikasi di browser sungguhan. Solusi akhir: hash otomatis Astro untuk semua yang di-inline-nya + satu hash manual (`src/lib/security/theme-init-script.ts`, dijaga sinkron oleh `tests/theme-init-script.test.ts`) untuk satu-satunya skrip `is:inline` tersisa (pencegah flash tema di `AdminLayout.astro`).
- **Rate limiting login** (`src/lib/security/rate-limit.ts`, env baru `AUTH_LOGIN_RATE_LIMIT_MAX`/`AUTH_LOGIN_RATE_LIMIT_WINDOW_SEC`, default 20/60 detik): memperluas pola lockout `AUTH_LOGIN_MAX_ATTEMPTS` yang sudah ada (per-identitas) dengan limiter sumber+tenant untuk menutup celah enumerasi lintas-identitas dari sumber yang sama. Diverifikasi live: percobaan ke-21 dari IP+tenant sama → `429 RATE_LIMITED` + header `Retry-After`; sumber IP berbeda tidak terpengaruh.
- `scripts/security-readiness.ts` diperluas dua check baru (`checkSecurityHeadersPresent` — live, hit server nyata; `checkLoginRateLimitImplemented` — murni), keduanya `warning` (defense-in-depth, bukan kontrol akses primer yang sudah `critical`).

### Fixed

- **False-positive pada gate `security:readiness` sendiri**: `checkNoHardcodedSecret` menandai `ERROR_CODE_KEYS.TOKEN_EXPIRED: "error.token_expired"` (`src/lib/i18n/error-messages.ts`, kode yang sudah ada sejak Issue #433) sebagai kemungkinan secret karena nama variabel mengandung "TOKEN" — nilainya sebenarnya kunci katalog i18n. Ditemukan dengan menjalankan gate ini sendiri terhadap kode yang sudah ada, bukan hipotetis; `bun run security:readiness` sebelumnya gagal (`GO-LIVE DIBLOKIR`) pada kode yang sudah merged. Diperbaiki dengan heuristik tambahan yang mengecualikan nilai berbentuk kunci i18n dot-namespace huruf kecil.

## [0.23.3] - 2026-07-06

### Added

- **Dispatcher object sync queue nyata** (Issue #436, milestone M9 — kerasan backend & integrasi eksternal): `dispatchObjectSyncQueue` (`src/modules/sync-storage/application/object-dispatch.ts`) menutup gap "dispatcher upload R2 nyata" yang sebelumnya jadi backlog eksplisit di `sync-storage/README.md`. Pola tiga fase claim/upload/finalize sesuai ADR-0006 (provider tidak pernah dipanggil di dalam transaction DB): CLAIM memindahkan baris `pending` jatuh tempo ke status transien baru `sending` (migrasi `018` menambah `sending` ke `CHECK` constraint, reuse kolom `next_retry_at` sebagai lease claim — tidak ada kolom baru), UPLOAD memanggil provider di luar transaction, FINALIZE menandai `sent`/`pending`+backoff/`failed` sesuai hasil. Backoff memakai ulang `evaluateObjectRetry` (`domain/object-queue.ts`) tanpa modifikasi; retry manual tetap lewat `POST /sync/object-queue/{id}/retry` yang sudah ada, tidak diubah.
- **Upload nyata via `Bun.S3Client`** (`src/modules/sync-storage/infrastructure/object-storage-uploader.ts`) — Bun-only, tanpa SDK AWS/S3 npm. Route `requires_upload=false` (R2 off/`STORAGE_DRIVER=local`) lewat no-op uploader (tanpa jaringan/I/O sama sekali, selalu sukses — provider off tidak pernah menghentikan operasional, ADR-0006); `requires_upload=true` memverifikasi checksum sha256 lokal aktual sebelum upload (pemanggil nyata pertama `verifyObjectChecksum`, sebelumnya hanya diuji langsung oleh unit test).
- **Circuit breaker generik diperluas ke provider eksternal**: `src/lib/database/circuit-breaker.ts` menambah `getProviderCircuitBreaker(providerKey)` — registry per-provider (bukan singleton tunggal seperti breaker database), dipakai uploader object storage (`"object-storage"`). Saat breaker terbuka, baris `requires_upload=true` tidak diklaim sama sekali pada pass tersebut; baris `requires_upload=false` tetap jalan karena tak pernah menyentuh provider.
- **Timeout panggilan keluar**: `src/lib/integration/timeout.ts` (`withTimeout`), env baru `OBJECT_SYNC_UPLOAD_TIMEOUT_MS` (default 10000ms).
- **CLI dispatcher terjadwal**: `bun run sync:objects:dispatch` (`scripts/object-sync-dispatch.ts`) — bukan endpoint HTTP publik, mengiterasi tenant `active` dan menguras backlog `awcms_mini_object_sync_queue` per tenant, dimaksudkan untuk cron/systemd timer/k8s CronJob.
- Idempotensi dispatcher: baris `sent`/`failed` tidak pernah diklaim ulang; kunci upload (`objectKey`) sendiri jadi dedup key alami (PUT S3/R2 ke key yang sama adalah overwrite, bukan duplikat).
- Tidak ada endpoint/event baru — dispatcher murni internal, sehingga OpenAPI/AsyncAPI baseline tidak berubah untuk issue ini.

## [0.23.2] - 2026-07-06

### Fixed

- **Audit performa aplikasi & database** (Issue #435, milestone M9): `EXPLAIN (ANALYZE, BUFFERS)` terhadap tenant yang di-seed ~200 ribu baris menemukan empat bentuk query tenant-scoped yang Seq/Bitmap-Heap-Scan seluruh tabel — listing admin object-queue (dengan/tanpa filter `status`), endpoint polling node HMAC `GET /sync/objects/status`, dan listing admin conflict tanpa filter `status` — turun dari 20-43ms ke sub-milidetik setelah migrasi `017` menambah empat index komposit `(tenant_id[, status], created_at [DESC])`.
- **Query planner memilih plan salah meski index tersedia**: listing object-queue dengan filter `status` tetap Seq Scan walau index barunya ada, karena planner salah mengestimasi baris hasil join ke `awcms_mini_sync_nodes`. Diperbaiki dengan menata ulang `fetchObjectQueueEntries` agar `LIMIT` diterapkan di dalam subquery **sebelum** join, bukan sesudah — execution time turun dari ~40ms ke <1ms.
- **N+1 write**: empat loop `INSERT` satu-per-item (assign permission ke role, assign role ke user, enqueue object sync) diganti satu `INSERT ... SELECT ... FROM unnest(...)` per request (satu round trip, bukan N).
- **N+1 read** pada `POST /sync/push`: satu `SELECT current_version` per event dalam batch diganti satu prefetch batch ke map in-memory (kunci `aggregateType:aggregateId`), diperbarui setelah tiap event diterima agar event kedua untuk aggregate yang sama dalam satu batch tetap melihat versi yang baru saja di-bump.

### Added

- **Keyset pagination**: `GET /api/v1/access/decision-logs`, `GET /api/v1/logs/audit`, dan `GET /api/v1/sync/object-queue` menerima `?cursor=` opsional (base64 `createdAt|id`, divalidasi) dan mengembalikan `nextCursor` — helper baru `src/modules/_shared/keyset-pagination.ts`.

Tidak ada `OFFSET`, `SELECT *`, atau bigint tak ter-`Number(...)` ditemukan di seluruh `src/` selama audit ini — dilaporkan apa adanya, bukan "diperbaiki" secara kosmetik.

## [0.23.1] - 2026-07-06

### Fixed

- **Audit UX/UI & aksesibilitas WCAG 2.1 AA** (Issue #434, milestone M9) atas layar admin yang sudah ada (`/login`, `/admin`, `/admin/access-users`, `/admin/sync`, `/admin/settings`, `AdminLayout.astro`) — menaikkan mutu, bukan membangun layar baru.
- **Kontras warna di bawah AA**: status pill aktif/nonaktif (teks berwarna di atas `--color-surface-2`, terukur 2.91:1/4.26:1 di tema terang dan 4.06:1 di tema gelap) dan tombol/banner primer bertulisan putih di tema gelap (`--color-primary`/`--color-danger` polos hanya 3.68:1/3.76:1 dengan teks putih) — token baru `--color-primary-strong`/`--color-success-strong`/`--color-danger-strong` (diukur ulang, semua ≥4.5:1) dipakai di tombol CTA, banner error, dan status pill (kini solid-fill, bukan teks-di-atas-tint).
- **Double-submit pada mutation form/tombol**: tak satu pun form/tombol admin (login, tambah/ubah user & role, assign/unassign role, toggle status, resolve conflict, retry queue, simpan settings) menonaktifkan dirinya selama request berjalan — klik ganda/`Enter` ganda yang cepat bisa mengirim mutation dua kali. Ditambahkan `lockElement` (`src/lib/ui/admin-form-client.ts`, modul klien bersama baru) yang menonaktifkan + `aria-busy` tombol pemicu selama request, mengembalikan state semula (termasuk saat gagal — input pengguna tetap utuh).
- **Baris empty-state hilang** pada tabel Roles di `/admin/access-users` (tabel Users sudah punya, tabel Roles tidak).
- **String hardcode lolos ekstraksi i18n #433**: `ThemeToggle.astro` masih hardcode Indonesia ("Sistem"/"Terang"/"Gelap", aria-label "Ganti tema tampilan") — kini menerima label ter-terjemahkan dari `AdminLayout.astro` seperti komponen topbar lainnya.
- **Cabang Error tak pernah ada** pada empat state pattern doc 14 (`Loading -> Error: gagal`) — kegagalan fetch data SSR (mis. DB error di `AdminLayout.astro`/keempat layar admin) sebelumnya tidak punya jalur render sama sekali (500 mentah). Ditambahkan `StateNotice.astro` (komponen bersama baru, `src/components/ui`) yang membedakan "akses ditolak" dari "gagal sementara, coba lagi" — juga menggantikan empat blok `.permission-denied` yang sebelumnya duplikat identik.

### Changed

- Empat implementasi `submitJson`/`showBanner`/`reloadAfterDelay` yang identik di `login.astro`, `admin/access-users.astro`, `admin/sync.astro`, `admin/settings.astro` diekstrak ke satu modul klien bersama (`src/lib/ui/admin-form-client.ts`).
- Ditambahkan skip-link keyboard di `AdminLayout.astro` (lompat ke konten utama, melewati topbar/sidebar), container scroll (`overflow-x: auto`) untuk semua tabel lebar (tablet), dan target sentuh ≥44px pada breakpoint tablet/mobile untuk kontrol interaktif kecil (theme toggle, tombol aksi tabel, chip hapus role).
- `AdminLayout.astro`: query nama tenant/status sync kini dibungkus `try/catch` dengan fallback aman — sebelumnya kegagalan salah satu query (dijalankan di setiap request `/admin/*`) menjatuhkan seluruh shell.
- Key `.po` baru (`common.error_*`, `common.retry`, `common.please_wait`, `admin.access_users.no_roles`, `admin.dashboard.no_module_usage`, `admin.layout.skip_to_content`, `admin.layout.theme_*`) ditambahkan paralel di `en.po`/`id.po`/`messages.pot` — keyset tetap identik di ketiga berkas.

## [0.23.0] - 2026-07-06

### Added

- **Runtime i18n** (Issue #433): katalog gettext `.po` tanpa dependency (`i18n/{messages.pot,en.po,id.po}`, parser murni di `src/lib/i18n/po-parser.ts`) untuk string UI statis — di-bundle bersama aplikasi (dibaca via `Bun.file`, bukan database). Konten data multi-bahasa (input pengguna) memakai konvensi terpisah, disimpan di database per locale aktif (`docs/awcms-mini/04_erd_data_dictionary.md` §Konten multi-bahasa; base belum punya field yang memakainya).
- Komponen **`LanguageSwitcher.astro`** di topbar admin — menampilkan nama asli + ikon bendera tiap bahasa (🇬🇧 English, 🇮🇩 Bahasa Indonesia), memilih men-set cookie `awcms_mini_locale` lalu reload penuh.
- Migrasi **`016`** mengubah default `awcms_mini_tenants.default_locale` dari `'id'` ke `'en'` untuk tenant baru (`ALTER COLUMN ... SET DEFAULT`; tenant lama tidak diubah).
- Seluruh string hardcode di halaman login, admin shell (`AdminLayout.astro`), dan layar dashboard/access-users/sync/settings diekstrak ke katalog; pesan error banner memetakan kode error (doc 05) ke pesan ter-lokalisasi lewat blob `<script type="application/json">` (katalog `.po` hanya bisa dibaca server-side).
- Formatter angka/mata uang IDR dan tanggal sadar-locale (`src/lib/i18n/format.ts`, `Intl.NumberFormat`/`DateTimeFormat`, timezone tetap `Asia/Jakarta`).

### Fixed

- **Bug ditemukan+diperbaiki saat verifikasi live**: locale tenant-fallback yang di-resolve di dalam `AdminLayout.astro` datang terlambat untuk konten halaman itu sendiri (frontmatter halaman berjalan lebih dulu daripada frontmatter layout yang membungkusnya) — shell ter-render dalam bahasa tenant yang benar, tetapi konten dashboard/access-users/sync/settings tetap Inggris. Diperbaiki dengan memindahkan resolusi locale (cookie → `default_locale` tenant → `en`) ke `src/middleware.ts`, sebelum halaman `/admin/*` mana pun dirender.

## [0.22.0] - 2026-07-06

### Added

- **Settings management**: `GET/PATCH /api/v1/settings` (nama tenant, nama legal, bahasa default, tema default, timezone, feature flags — terima subset field apa pun) dan layar admin **`/admin/settings`**, menggantikan placeholder "Pengaturan belum tersedia".
- Migrasi `015` seed dua permission baru `tenant_admin.tenant_settings.{read,update}` (tanpa perubahan schema — semua kolom sudah ada sejak migrasi 002).

### Changed

- Skrip resolusi tema no-flash (`AdminLayout.astro`) kini fallback ke `default_theme` tenant untuk browser yang belum pernah memilih tema personal di localStorage — sebelumnya hardcode `"system"`, dan kolom itu tak pernah dibaca kode mana pun sejak Issue 8.1.
- Memperbaiki dokumentasi usang (`ThemeToggle.astro`, doc 14, doc 18) yang salah menyebut `default_locale`/`default_theme` sebagai kolom `awcms_mini_tenant_settings`, padahal keduanya ada di `awcms_mini_tenants`.

### Security

- `awcms_mini_tenants` sengaja RLS-free (root tenant, `id` adalah tenant id) — endpoint Settings mengandalkan `WHERE id = <tenantId>` eksplisit di setiap `UPDATE`, bukan RLS; dibuktikan dengan test integrasi (update tenant A tidak pernah mengubah tenant B).

## [0.21.0] - 2026-07-06

### Added

- **Sync admin ops dashboard**: `GET/PATCH /api/v1/sync/nodes*` (daftar/aktifkan/nonaktifkan/ganti nama node — nonaktif langsung memblokir endpoint HMAC yang sudah menolak node tidak aktif), `GET /api/v1/sync/object-queue` (tampilan antrean objek tenant-wide, filter status) + `POST /api/v1/sync/object-queue/{id}/retry` (retry manual entri gagal, override jadwal backoff otomatis). Layar admin **`/admin/sync`** (ringkasan, tabel node/konflik/antrean-gagal) di-wire ke sidebar nav (sebelumnya stub "Segera hadir").
- Migrasi `014` seed dua permission baru `sync_storage.node_management.{read,update}` (tanpa perubahan schema).

### Changed

- `GET/POST /api/v1/sync/conflicts*` kini juga menerima cookie SSR (bukan cuma bearer) dan mencatat audit event saat resolve — gap yang sebelumnya terdokumentasi sebagai "belum ada tabel audit_events" padahal tabel itu sudah ada sejak Issue 10.1.
- Union `AccessAction` menambah `"retry"` untuk mengonsumsi permission `sync_storage.object_queue.retry` yang sudah diseed sejak Issue 6.3 tanpa endpoint pemakai — sengaja **bukan** high-risk (nudge jadwal, bukan aksi destruktif), tetap diaudit eksplisit.

## [0.20.0] - 2026-07-06

### Added

- **Access & Users management** penuh di atas fondasi Issue 2.3/2.4: `GET/POST /api/v1/users` + `PATCH /api/v1/users/{id}` (buat/ubah nama/aktifkan-nonaktifkan tenant user — nonaktif langsung memblokir login berikutnya), `GET/POST /api/v1/roles` + `PATCH/DELETE /api/v1/roles/{id}` (buat/ubah nama/ubah permission set/soft-delete role), `GET /api/v1/permissions` (katalog permission read-only), dan `DELETE /api/v1/access/assignments` (unassign — `POST` assign sudah ada sejak Issue 2.4).
- Layar admin **`/admin/access-users`**: tabel user + tabel role, form tambah user/role, editor checkbox permission per role, chip assign/unassign role, toggle aktif/nonaktif — di-wire ke sidebar nav (sebelumnya stub "Segera hadir").

### Changed

- Guard tiap endpoint baru memetakan persis ke permission granular yang sudah diseed (`user_management.{read,create,update}`, `access_control.{read,configure,assign}`) — tidak ada permission baru yang perlu di-seed.
- **Safety rail**: role sistem (`is_system=true`, mis. `owner` yang di-seed Setup Wizard) menolak perubahan `permissionIds` maupun delete dengan `409` — mencegah admin tidak sengaja mengunci semua orang keluar. Delete role juga ditolak `409` bila masih ada assignment aktif.

## [0.19.0] - 2026-07-06

### Added

- Migrasi **`013`** menegakkan RLS multi-tenant: `FORCE ROW LEVEL SECURITY` pada **31** tabel tenant-scoped (policy berlaku bahkan untuk pemilik tabel) + role aplikasi least-privilege **`awcms_mini_app`** (hanya grant DML, non-superuser, non-owner) + default GUC fail-closed (`app.current_tenant_id` = UUID nol → tak cocok tenant mana pun → 0 baris bila tabel RLS dicapai tanpa `withTenant`).
- Wiring deployment dua-peran: service satu-kali **`migrate`** (superuser, `service_completed_successfully`) + hook init **`deploy/postgres/10-create-app-role.sh`** di `docker-compose.yml` yang membuat role dari `AWCMS_MINI_APP_DB_PASSWORD`; model dua-peran didokumentasikan di `.env.example` dan `docs/awcms-mini/deployment-profiles.md`. Runner `db:migrate` diberi `stripDollarQuotedBlocks()` agar blok `DO $$ … $$` tidak salah dibaca sebagai transaction-control (+ test regresi).

### Changed

- Aplikasi kini terhubung sebagai role least-privilege **`awcms_mini_app`** (bukan pemilik/superuser) sehingga RLS benar-benar ditegakkan; migrasi tetap berjalan sebagai role privileged.
- **`security:readiness`** ditingkatkan dari cek flag ke cek **penegakan**: check "RLS enabled AND forced" kini mewajibkan `relforcerowsecurity`, dan check baru "App DB connection role does not bypass RLS" **memblokir go-live** bila peran koneksi `DATABASE_URL` superuser/BYPASSRLS. Harness integrasi di-split dua peran; test isolasi baris RLS (sebelumnya di-drop) kini aktif dan lulus.
- Perbaikan `docker-compose.yml`: volume `db` di-mount di `/var/lib/postgresql` (bukan `/var/lib/postgresql/data`) agar image `postgres:18+` mau start — celah yang lolos dari bump 18.4 (0.17.0) karena diverifikasi via `docker run`, bukan `docker compose up`.

### Security

- **Ditutup** — temuan keamanan 0.18.0: RLS multi-tenant (ADR-0003) sebelumnya inert karena aplikasi terhubung sebagai pemilik tabel + superuser dan migrasi hanya `ENABLE` (bukan `FORCE`). Kini ditegakkan penuh. Diverifikasi live terhadap `postgres:18.4`: `security:readiness` sebagai superuser → **GO-LIVE DIBLOKIR** (menangkap tepat celah ini), sebagai role least-privilege → 11/11 PASS; stack `docker-compose` penuh — app konek sebagai `awcms_mini_app`, konteks tenant bogus → **0** baris, tenant nyata → **1**, sementara superuser melewati RLS (membuktikan `FORCE` + role least-privilege yang menutup celah); 6/6 test integrasi lulus dengan handler berjalan sebagai `awcms_mini_app`.

## [0.18.0] - 2026-07-05

### Added

- Suite test **integrasi HTTP terhadap PostgreSQL nyata** (`tests/integration/`) — memanggil route handler Astro nyata, menjaga wiring endpoint yang tak bisa dijaga suite unit murni: setup singleton-lock, login argon2 + terbit sesi, rantai ABAC allow/default-deny, penolakan cross-tenant session, dan jalur write → audit → read-back. Di-gate pada `DATABASE_URL` (skip bersih tanpa DB — `bun test` lokal tetap hijau).
- Service `postgres:18.4` di CI (`quality` job) + `bun run db:migrate` sebelum `bun test`, sehingga suite integrasi berjalan (dan memblokir) pada setiap PR. Dokumentasi `tests/README.md`.

### Security

- **Temuan** (dari harness di atas, perbaikan menyusul): RLS multi-tenant (ADR-0003) tidak ditegakkan untuk DB user aplikasi karena aplikasi terhubung sebagai pemilik tabel + superuser (`rolbypassrls`), dan migrasi hanya `ENABLE` (bukan `FORCE`) ROW LEVEL SECURITY — RLS sebagai backstop inert; isolasi tenant saat ini bergantung penuh pada filter `WHERE tenant_id` layer aplikasi. Dicatat di `docs/awcms-mini/AUDIT_STANDAR_PENGEMBANGAN_2026-07-04.md` §Perawatan pasca-backlog dengan rencana perbaikan (FORCE RLS + role least-privilege + upgrade check `security:readiness`).

## [0.17.0] - 2026-07-05

### Changed

- Upgrade pin PostgreSQL 16 → **18.4** (perawatan pasca-backlog, bukan issue doc06). Mengganti pin versi forward-looking di `docker-compose.yml` (`db` service), `docs/awcms-mini/deployment-profiles.md`, dan catatan out-of-scope `security:readiness`. Tidak ada perubahan schema/kode aplikasi — seluruh 12 migration, endpoint, dan round-trip backup/restore diverifikasi live terhadap `postgres:18.4`. **Catatan operasional**: volume data named dari Postgres 16 tidak dibaca langsung oleh image 18.x — upgrade stack yang sudah jalan wajib `pg_dump`/`pg_restore` lintas major (alur `deploy/backup/*.sh`). Entri log historis (rilis 0.16.0, snapshot GitHub, entri per-issue AUDIT) sengaja tidak diubah karena mencatat versi yang benar-benar dipakai saat itu.

## [0.16.0] - 2026-07-05

### Added

- Deployment profile offline/LAN (Issue 12.2, tidak ada migration baru): `deploy/systemd/awcms-mini.service.example`, `deploy/nginx/awcms-mini.conf.example`, `deploy/pgbouncer/pgbouncer.ini.example` (kini canonical, `docs/awcms-mini/database-pooling.md` merujuk ke sini alih-alih duplikasi), `deploy/backup/backup-postgres.sh`/`restore-postgres.sh` (checksum + retention, restore aman secara default ke database uji sekali pakai, menolak menimpa database sumber).
- `docker-compose.yml` di root repo — stack LAN-first `app` (`oven/bun:1`) + `db` (`postgres:16`), plus service `pgbouncer` opsional lewat Compose profile.
- `bun run config:validate` (`scripts/validate-env.ts`) — validasi env wajib/bersyarat saat boot sesuai doc 18, tanpa pernah membocorkan nilai secret; ditambahkan sebagai tahap pertama `production:preflight`.
- `docs/awcms-mini/deployment-profiles.md` — memetakan 4 profil environment (development/staging/production/offline-LAN) ke aset deployment yang relevan.
- Ini adalah **issue terakhir** dari seluruh backlog base generik (18 issue doc06) — epic M8 dan seluruh backlog kini tuntas.

## [0.15.0] - 2026-07-05

### Added

- Workflow approval engine generik (Issue 11.1, `sql/012_awcms_mini_workflow_approval_schema.sql`): skema `awcms_mini_workflow_definitions`/`_instances`/`_tasks`/`_decisions` (4 tabel persis sesuai doc 04 — "steps" adalah daftar langkah berurutan milik definisi, bukan tabel ke-5).
- `GET /workflows/tasks` dan `POST /workflows/tasks/{id}/decisions` (bearer session, permission `workflow.approval.read`/`.approve` sesuai seed doc 17 — tidak ada endpoint create-definition/start-instance publik karena doc 17 tidak memberi permission `create`/`configure` untuk workflow; `startWorkflowInstance` internal-only).
- Self-approval guard memakai ulang mekanisme yang sudah ada di `evaluateAccess` (Issue 2.4) — bukan mekanisme baru.
- Tabel idempotency generik `awcms_mini_idempotency_keys` (doc 10/16), konsumer nyata pertamanya adalah endpoint decision workflow (`Idempotency-Key` wajib, replay aman, `409 IDEMPOTENCY_CONFLICT` untuk key sama dengan body berbeda) — dapat dipakai ulang endpoint mutation high-risk lain di masa depan.
- Keputusan workflow (approve/reject) tercatat ke audit trail generik (Issue 10.1).

## [0.14.0] - 2026-07-05

### Added

- Tooling production security readiness (Issue 10.3, tidak ada migration baru): `bun run db:pool:health` (CLI pemeriksa endpoint pool health Issue 10.2), `bun run security:readiness` (checklist go-live nyata dan terverifikasi — no hardcoded secret, `.env` tidak tracked, hashing password argon2id, login lockout, RLS, ABAC default-deny, audit log, cakupan audit soft delete/restore/purge, kebersihan secret HMAC sync, kebocoran stack trace error — dengan bagian "di luar scope base generik ini" eksplisit dan terdokumentasi untuk item domain/deployment), dan `bun run production:preflight` (mengorkestrasi migrate/spec-check/test/build/pool-health/security-readiness menjadi satu vonis go/no-go).
- Gate kritis diverifikasi live: RLS sengaja dimatikan pada satu tabel, `security:readiness` langsung melaporkan kegagalan dan memblokir go-live; diaktifkan kembali, kembali lulus penuh.

## [0.13.0] - 2026-07-05

### Added

- Database connection pooling dan backpressure (Issue 10.2, tidak ada migration baru — infrastruktur murni di `src/lib/database/`): pool config `Bun.SQL` (`max`, `prepare` dinonaktifkan saat `DATABASE_PGBOUNCER=true`, `connection.statement_timeout`), work-class concurrency gate aplikasi (`critical_transaction`/`interactive`/`reporting`/`background_sync`/`maintenance`), dan circuit breaker 3-state, keduanya dikaitkan ke `withTenant` sehingga seluruh endpoint tenant-scoped yang sudah ada otomatis terlindungi (`503 DATABASE_BUSY`) tanpa perlu mengubah setiap file endpoint.
- Endpoint sync dan reporting/audit diklasifikasi ulang ke work class `background_sync`/`reporting` sesuai tabel prioritas doc 16.
- `GET /api/v1/database/pool/health` (publik, hanya agregat) dan event `database.pool.saturated` (kontrak AsyncAPI, belum ada dispatcher live untuk event apa pun di base ini).

## [0.12.0] - 2026-07-05

### Added

- Structured logging dan audit trail (Issue 10.1, `sql/011_awcms_mini_audit_logging_schema.sql`): tabel generik `awcms_mini_audit_events` (tenant-scoped, append-only, RLS), logger JSON terstruktur (`src/lib/logging/logger.ts`, menghormati `LOG_LEVEL`), redaksi lintas-modul (`src/modules/_shared/redaction.ts`, dipakai bersama oleh logger dan audit trail), dan propagasi correlation ID via `X-Correlation-ID` di `src/middleware.ts` untuk setiap request.
- `GET /logs/audit` (bearer session, permission `logging.audit_trail.read`) untuk membaca audit trail, dengan filter `?resourceType=`/`?action=`/`?severity=`.
- Endpoint lifecycle profil tipis: `DELETE /profiles/{id}` (soft delete), `POST /profiles/{id}/restore`, `POST /profiles/{id}/purge` (hard delete, hanya setelah soft delete, ditolak `409 PURGE_BLOCKED_BY_DEPENDENTS` bila masih direferensikan tabel lain) — mendemonstrasikan audit trail end-to-end secara nyata, bukan hanya diklaim. Manajemen profil penuh (create/update/list) tetap backlog.
- Vocabulary `AccessAction` diperluas dengan `restore`/`purge` sebagai high-risk action (sesuai doc 10 §ABAC guard).

## [0.11.1] - 2026-07-05

### Fixed

- `POST /sync/push` (Issue 6.1) melakukan `JSON.stringify` sebelum bind ke kolom `payload_json` (jsonb) — Bun.SQL sudah menyerialisasi value yang di-bind ke kolom jsonb sendiri, sehingga stringify tambahan menghasilkan jsonb string scalar (teks JSON dalam tanda kutip), bukan objek jsonb nyata. Ditemukan saat membangun audit trail Issue 10.1 (kelas bug yang sama sempat muncul di kode baru dan tertangkap sebelum ship). Diperbaiki dengan bind `event.payload` langsung.

## [0.11.0] - 2026-07-05

### Added

- Management Reporting Views (Issue 9.1, `sql/010_awcms_mini_management_reporting_permission_schema.sql`): modul `reporting` baru dengan empat view agregasi baca generik (tenant activity, access/audit summary, sync health, module usage) via `GET /api/v1/reports/*` (bearer session, dijaga satu permission baru `reporting.dashboard.read`) — tidak ada tabel baru, murni agregasi atas tabel yang sudah ada.
- Dashboard admin (`/admin`, sebelumnya placeholder) kini menampilkan data nyata dari keempat view, dengan panel "Akses ditolak" bila user tidak punya permission `reporting.dashboard.read`.
- `<SyncIndicator />` di topbar (sebelumnya stub `active={false}` tetap) kini menampilkan status sync nyata (node aktif, konflik terbuka, objek gagal).

## [0.10.0] - 2026-07-05

### Added

- Admin Layout Shell (Issue 8.1): design token (`src/styles/tokens.css`) dan theming light/dark/system tanpa flash; `src/layouts/AdminLayout.astro` SSR (topbar, sidebar navigasi permission-aware, breadcrumb); komponen stub `TenantSwitcher`, `SyncIndicator` (belum ada data live — menunggu Issue 9.1), `ThemeToggle`; halaman `/login`, `/admin`, `/admin/settings`.
- Helper `resolveSsrContext` (`src/lib/auth/ssr-session.ts`), dipakai `src/middleware.ts` untuk menjaga rute `/admin/*`.
- Cookie sesi httpOnly + SameSite=Lax additive pada `POST /auth/login`/`POST /auth/logout` (body JSON tidak berubah, tetap kompatibel dengan klien bearer-token yang sudah ada) agar SSR shell dapat autentikasi tanpa mengekspos token mentah ke client-side JavaScript.

## [0.9.0] - 2026-07-05

### Added

- Antrean sinkron objek R2 (Issue 6.3, `sql/009_awcms_mini_object_sync_queue_schema.sql`): `awcms_mini_object_sync_queue` dengan enqueue upsert per `objectKey`, tracking checksum/ukuran byte, dan evaluasi retry backoff eksponensial.
- Endpoint baru `POST /sync/objects` (enqueue), `GET /sync/objects/status` — HMAC node-auth, sama seperti push/pull/status.
- `R2_ENABLED` hanya menentukan kolom `requires_upload`; tidak ada pemanggilan R2/Cloudflare SDK nyata di base ini (dispatcher upload tetap backlog, sama seperti `awcms_mini_message_outbox`). Epic M5 (Sync Storage, Issue 6.1-6.3) tuntas.

## [0.8.0] - 2026-07-05

### Added

- Sync conflict tracking dan resolution (Issue 6.2, `sql/008_awcms_mini_sync_storage_conflict_schema.sql`): `awcms_mini_sync_aggregate_versions` (versi per aggregate) dan `awcms_mini_sync_conflicts` (immutable, dua tipe generik: `missing_base_version`, `version_mismatch`).
- `POST /sync/push` menerima `baseVersion?` opsional per event; event konflik dicatat, bukan diterapkan; response menambah `conflicted`.
- Endpoint `GET /sync/conflicts`, `POST /sync/conflicts/{id}/resolve` — bearer session (bukan HMAC), di-guard permission `sync_storage.conflict_resolution.read`/`.approve` (diseed di migration ini).

### Fixed

- Kolom `bigint` (`current_version`, `sequence`, `last_pull_sequence`) dikembalikan Bun.SQL sebagai string, menyebabkan `baseVersion` yang benar salah terdeteksi sebagai konflik — ditemukan saat verifikasi live, diperbaiki dengan `Number(...)` eksplisit di `push.ts`/`pull.ts`/`status.ts` (bug laten sejak Issue 6.1).

## [0.7.0] - 2026-07-05

### Added

- Sync outbox/inbox (Issue 6.1, `sql/007_awcms_mini_sync_storage_outbox_inbox_schema.sql`): `awcms_mini_sync_nodes` (registrasi node per tenant, checkpoint cursor), `awcms_mini_sync_outbox` (event lokal siap di-pull), `awcms_mini_sync_inbox` (event diterima via push), `awcms_mini_sync_push_batches` (ledger idempotency).
- Endpoint `POST /sync/push`, `POST /sync/pull`, `GET /sync/status` — autentikasi HMAC (bukan bearer token), node auto-registrasi saat kontak pertama, menolak jika `AWCMS_MINI_SYNC_ENABLED` bukan `true`.
- Domain logic murni `computeSyncSignature`/`verifySyncSignature`/`isTimestampWithinSkew` (`src/modules/sync-storage/domain/sync-hmac.ts`) dan `validateSyncPushRequestBody`. Modul `sync-storage` didaftarkan.

### Fixed

- `GET /sync/status` tidak mengecek status node aktif (hanya cek node ada), tidak konsisten dengan `push`/`pull` — ditemukan saat verifikasi live, diperbaiki agar ketiganya konsisten menolak (403) node inactive.

## [0.6.0] - 2026-07-05

### Added

- Setup wizard awal (Issue 12.1, `sql/006_awcms_mini_setup_wizard_schema.sql`): `awcms_mini_setup_state` (singleton global, RLS-free) mengunci setup secara permanen. `GET /setup/status` dan `POST /setup/initialize` (keduanya public — belum ada identity untuk login sebelum tenant pertama dibuat).
- `initialize` adalah satu transaksi atomik: klaim lock (aman dari race condition), buat tenant, office, profile/identity/tenant_user owner, role `owner` berisi seluruh permission katalog, assignment owner→role, lalu kunci setup. Validasi input murni `validateSetupInitializeInput` (field wajib + password minimum 8 karakter).

## [0.5.0] - 2026-07-05

### Added

- RBAC dan ABAC access control (Issue 2.4, `sql/005_awcms_mini_abac_access_control_schema.sql`): `awcms_mini_permissions` (katalog global, diseed 17 entri generik untuk modul base), `awcms_mini_roles`, `awcms_mini_role_permissions`, `awcms_mini_access_assignments`, `awcms_mini_abac_policies`, dan `awcms_mini_abac_decision_logs` (append-only).
- Evaluator murni `evaluateAccess` (default deny, deny overrides allow — ADR-0004) memakai tipe `TenantContext`/`AccessRequest`/`AccessDecision` persis sesuai doc 10 §ABAC guard, dengan aturan ABAC generik (tenant isolation, self-approval deny).
- Endpoint `GET /access/modules`, `POST /access/evaluate`, `POST /access/assignments` (idempotent), `GET /access/decision-logs` — OpenAPI diperbarui.

## [0.4.0] - 2026-07-05

### Added

- Identity login and tenant user membership (Issue 2.3, `sql/004_awcms_mini_identity_login_schema.sql`): `awcms_mini_identities` (login per tenant, `password_hash` argon2id via `Bun.password`, lockout `failed_login_count`/`locked_until`), `awcms_mini_tenant_users` (status keanggotaan tenant), `awcms_mini_sessions` (token sesi opaque — hanya `token_hash` disimpan, mendukung logout nyata).
- Endpoint live pertama yang menyentuh database: `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/me` (OpenAPI diperbarui, kode error baru `AUTH_INVALID_CREDENTIALS`).
- Infrastruktur akses data bersama: `src/lib/database/client.ts` (`Bun.SQL`), `src/lib/database/tenant-context.ts` (`assertUuid` + `withTenant`, transaction wrapper `SET LOCAL app.current_tenant_id` sesuai doc 16), `src/lib/auth/password.ts`, `src/lib/auth/session-token.ts`. Domain logic murni `evaluateLoginAttempt` di `src/modules/identity-access/domain/login-policy.ts` (anti user-enumeration, lockout otomatis). Modul `identity-access` didaftarkan.

## [0.3.0] - 2026-07-05

### Added

- Central profile schema (Issue 2.2, `sql/003_awcms_mini_central_profile_management_schema.sql`): `awcms_mini_profiles` (kanonik person/organization, soft delete), `awcms_mini_profile_identifiers` (email/phone/whatsapp/national_id/tax_id/external_code — digenerikkan dari NPWP/NIK/"customer code" doc 03 — dedup via `value_hash` unique parsial per tenant+type, `masked_value` aman), `awcms_mini_profile_channels`, `awcms_mini_profile_addresses`, `awcms_mini_profile_entity_links`, `awcms_mini_profile_merge_requests` (`CHECK source_profile_id <> target_profile_id`), dan `awcms_mini_profile_audit_logs` (append-only). Domain logic murni di `src/modules/profile-identity/domain/` (`normalizeIdentifier`, `hashIdentifier`, `maskIdentifier`, `assertMergeRequestIsValid`). Modul `profile-identity` didaftarkan (dependency: `tenant-admin`).

## [0.2.0] - 2026-07-05

### Added

- Tenant and office schema (Issue 2.1, `sql/002_awcms_mini_tenant_office_schema.sql`): `awcms_mini_tenants` (root tenant, unique `tenant_code`, lifecycle `status`), `awcms_mini_offices` (hierarki kantor per tenant, unique parsial `(tenant_id, office_code) WHERE deleted_at IS NULL`, RLS, soft delete), `awcms_mini_physical_locations` (alamat per office, RLS, soft delete), dan `awcms_mini_tenant_settings` (konfigurasi 1:1 per tenant, RLS). Modul `tenant-admin` didaftarkan di registry modul.

### Fixed

- Sprint sequencing di doc 06: Issue 12.1 (Setup Wizard) membutuhkan skema tenant/identity/RBAC yang dimiliki Issue 2.1/2.3/2.4 (Sprint 2/3), tetapi sebelumnya ditempatkan di Sprint 1 sejajar 0.1–0.3. Dipindah ke Sprint 3 (setelah 2.4). Label GitHub disesuaikan: `#376`/`#377`/`#378` (2.1/2.2/2.3) `status:blocked` → `status:ready`; `#407` (12.1) `status:ready` → `status:blocked`.

## [0.1.1] - 2026-07-05

### Fixed

- Tipe `SoftDeleteColumns.deletedAt`/`deletedBy`/`deleteReason` di `src/modules/_shared/soft-delete.ts` disamakan ke `string | null` opsional sesuai doc 10 (sebelumnya `deletedAt: Date | null` wajib).
- `.env.example` dan doc 11 §Minimal `.env.example` mewarisi nama provider spesifik-domain retail/POS (`STARSENDER_ENABLED`, `MAILKETING_ENABLED`, `AI_ANALYST_ENABLED`) dari contoh doc 18; dihapus dari file konfigurasi base dan diganti komentar generik untuk aplikasi turunan.

### Added

- Doc 13 §Repository artifact checklist ditambah subbagian "Folder standar" yang mengindeks `README.md` di `src/lib/`, `src/modules/_shared/`, `openapi/`, `asyncapi/`, `deploy/`, `fixtures/`.

## [0.1.0] - 2026-07-05

Rilis bertag pertama — Foundation (Sprint 1) sesuai `docs/awcms-mini/09_roadmap_repository_commit.md`.

### Added

- Foundation skeleton Issue 0.1: Astro 7 SSR via Bun (`@astrojs/node` adapter, mode standalone — pengecualian Bun-only tersanksi per ADR-0002), health endpoint `/api/v1/health`, module contract/registry, shared API response helper (envelope `{ success, data, meta }` / `{ success: false, error, meta }`, sesuai doc 05/10), soft-delete convention, `.env.example`, foundation SQL schema, dan folder standar (`src/`, `sql/`, `openapi/`, `asyncapi/`, `deploy/`, `fixtures/`).
- SQL migration runner Issue 0.2: `bun run db:migrate` menggunakan `Bun.SQL`, memvalidasi `sql/*.sql` terurut, menyimpan checksum SHA-256, melewati migration yang sudah diterapkan, menolak drift checksum, membungkus eksekusi dalam transaksi, dan mendokumentasikan alur operasionalnya.
- OpenAPI dan AsyncAPI baseline Issue 0.3: kontrak OpenAPI publik, kontrak AsyncAPI domain-event, skema respons/error bersama, pola soft-delete, header sync HMAC, dan validator `api:spec:check`.

### Changed

- `bun run check` kini mencakup `bun run build`, dan CI menjalankan build Astro foundation.
- `bun run check` kini mencakup `bun run api:spec:check`.
- `package.json` kini menyediakan `db:migrate` untuk migration runner PostgreSQL Bun-native.
- Snapshot dokumentasi GitHub direfresh mengikuti penyelesaian #371, #372, #373 (Epic 0).

### Fixed

- **Arsitektur SSR**: `astro.config.mjs` semula `output: "static"` dan `/api/v1/health` memakai `export const prerender = true`, sehingga endpoint ter-generate sekali saat build (bukan berjalan per-request) — bertentangan dengan RLS multi-tenant (ADR-0003) yang mensyaratkan `SET LOCAL app.current_tenant_id` per transaksi live. Diperbaiki ke `output: "server"` + adapter `@astrojs/node` (mode standalone); diverifikasi dengan menjalankan `dist/server/entry.mjs` dan memanggil `/api/v1/health` dua kali (nilai `generatedAt` berbeda tiap panggilan, membuktikan eksekusi per-request).
- **Envelope respons API**: helper `ok()`/`fail()` di `src/modules/_shared/api-response.ts`, skema `ApiSuccess`/`ApiError` di `openapi/awcms-mini-public-api.openapi.yaml`, test, dan README modul `_shared` memakai field `ok`, padahal doc 05 dan doc 10 menetapkan `success` sebagai field envelope standar. Field disamakan ke `success` di seluruh berkas tersebut.
- Pin `oven-sh/setup-bun` di CI ke commit SHA immutable untuk menyelesaikan CodeQL `actions/unpinned-tag` (#7), dan hapus referensi proyek lama terakhir dari snapshot label/milestone.
- Clean up `tsconfig.json` after foundation skeleton: remove the stale docs-only note and use the directly declared Bun type package.

## [0.0.3] - 2026-07-04

### Fixed

- **Audit menyeluruh GitHub issues vs doc 06**: membandingkan setiap field (Problem/Scope/Out of Scope/Acceptance Criteria/Security Notes/Testing/Reference Docs) tiap issue open terhadap `docs/awcms-mini/06_github_issues_detail.md`, plus label & milestone terhadap tabel rekomendasi. Ditemukan 14/18 issue drift:
  - **2 konflik konten nyata** — leftover bahasa domain dari genericization sebelumnya yang belum lengkap: `#371` (Out of Scope masih "POS, inventory, provider eksternal") dan `#377` (Acceptance Criteria masih "user/customer/tax/CRM").
  - **12 issue dengan Reference Docs basi** — dibuat sebelum `docs/adr/` dan doc 20 ada: `#371`-`#373` (Epic 0), `#376`-`#378` (Epic 2), `#391`-`#393` (Epic 6), `#403`-`#404` (Epic 10), `#406` (Epic 11).
  - Tidak ada perubahan jumlah/label/milestone (tetap 18 open/20 closed/98 label/24 milestone) — seluruh label doc 06 terverifikasi ada di GitHub, seluruh milestone issue terverifikasi cocok tabel rekomendasi.
- Snapshot `docs/awcms-mini/github/` (README, issues-open-001, issues-closed-001, labels-milestones) di-refresh; `AUDIT_STANDAR_PENGEMBANGAN_2026-07-04.md` dilengkapi entri yang sebelumnya belum tercatat (tsconfig.json/typecheck 0.0.1, unit testing 0.0.2).

## [0.0.2] - 2026-07-05

### Added

- **Unit testing** (`bun test` / `bun:test`) di `tests/`: `tests/docs-checks.test.mjs` (23 kasus untuk mermaid, slug/anchor, penamaan, ekstraksi/klasifikasi tautan) + `tests/check-docs-integration.test.mjs` (menjalankan pemeriksa docs penuh atas repo nyata).
- Script `test` + `test:coverage`; `bun test` dimasukkan ke `bun run check` dan gate CI (`.github/workflows/ci.yml`).

### Changed

- Refaktor `scripts/check-docs.mjs` → lib logika-murni bebas I/O (`scripts/lib/docs-checks.mjs`, ter-export) + CLI tipis dengan guard `import.meta.main` (agar dapat diimpor test tanpa efek samping).
- Doc 07 (§Testing Strategy), 10, 13, 20, `AGENTS.md`, `CONTRIBUTING.md`, `README.md` diselaraskan dengan keberadaan test + runner `bun test`.

### Fixed

- Bug fidelity `slugify`: GitHub **tidak** menggabungkan whitespace beruntun saat membuat slug heading (`"a & b"` → `"a--b"`); sebelumnya keliru meng-collapse (`\s+`), berpotensi false-negative pada validasi anchor lintas-berkas.

## [0.0.1] - 2026-07-05

Baseline paket dokumentasi, standar profesional repo publik, & tooling. Belum ada kode aplikasi; rilis bertag berikutnya direncanakan **0.1.0** (Foundation) sesuai `docs/awcms-mini/09_roadmap_repository_commit.md`.

### Added

- Paket dokumen master **01–20** (`docs/awcms-mini/`): perencanaan (01–03), kontrak (04–05), eksekusi (06–13), desain teknis implementasi (14–18), glossary (19), **threat model & arsitektur keamanan (20)**.
- **Architecture Decision Records** di `docs/adr/` (template + ADR 0001–0007: modular monolith, Bun-only, PostgreSQL+RLS, RBAC/ABAC default-deny, soft delete/immutability, offline-first/outbox, OpenAPI/AsyncAPI).
- Berkas komunitas & tata kelola repo publik: `LICENSE` (MIT), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `GOVERNANCE.md`, `SUPPORT.md`, `.github/CODEOWNERS`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/ISSUE_TEMPLATE/` (bug/feature/documentation/config).
- Konfigurasi kualitas: `.editorconfig`, `.gitattributes`, `.prettierrc.json`, `.prettierignore`, **`tsconfig.json`** (strict, ES2024, Bun+Node types — anchor sebelum Issue 0.1, mengikuti konvensi tsconfig repo AhliWeb lain).
- `typescript`, `@types/bun`, `@types/node` sebagai devDependency; script `typecheck` (`tsc --noEmit`), digabung ke `bun run check`.
- CI kualitas dokumentasi & hygiene (`.github/workflows/ci.yml`): prettier check, pemeriksa docs Bun-native (`scripts/check-docs.mjs` — mermaid, tautan internal, penamaan), **typecheck**, gate Bun-only + no-`.env`.
- `AGENTS.md` — kontrak kerja coding agent.
- 17 **skill proyek** Claude Code di `.claude/skills/`.
- Audit standar pengembangan software (`docs/awcms-mini/AUDIT_STANDAR_PENGEMBANGAN_2026-07-04.md`).
- Snapshot dokumentasi GitHub di `docs/awcms-mini/github/` (open/closed terpisah, batas 100 issue/file, label/milestone/security + proses refresh).
- GitHub Security baseline: `SECURITY.md` (diperluas: scope, safe harbor, target response time), `.github/dependabot.yml`, `.github/workflows/codeql.yml`.
- Diagram Mermaid di seluruh dokumen kunci.
- Versioning (SemVer) + **Changesets** + `CHANGELOG.md` + `package.json` (metadata lengkap) + `bun.lock` + `.gitignore`.

### Changed

- **Lisensi** `UNLICENSED` → **MIT**; `package.json` dilengkapi metadata (repository, bugs, homepage, keywords, engines) dan script `lint`/`format`/`check:docs`/`typecheck`/`check`.
- Backlog issue & dokumen entry (01, 06, 09, `AGENTS.md`) digenerikkan: konten domain POS/retail dikeluarkan dari base; dokumen teknis 02–19 ditandai sebagai **contoh domain ilustratif**.
- `README.md` dirapikan menjadi front door repo publik: badge, daftar isi, tautan tata kelola/keamanan/ADR, diagram arsitektur generik.

### Removed

- Berkas cruft `init` (1 byte, kosong) yang ter-track sejak sebelum standar ini.

### Fixed

- Regresi penamaan `awcms-mini_*`/`AWCMS-Mini_*` → `awcms_mini_*`/`AWCMS_MINI_*` (identifier SQL/env) yang tersisa di `.claude/skills/`.
- Referensi jumlah dokumen `01–19` → `01–20` dan penambahan doc 20 + ADR ke indeks (`AGENTS.md`, doc 13, doc 06, docs index). Issue GitHub `#405`/`#379` diselaraskan merujuk doc 20 + ADR.
- Implicit-`any` di `scripts/check-docs.mjs` (JSDoc types) agar lolos `tsc --strict` + `checkJs`.

## Peta versi rencana (base, dari doc 09)

| Versi   | Isi                                                                                 |
| ------- | ----------------------------------------------------------------------------------- |
| `0.1.0` | Foundation skeleton (SSR, module contract, migration runner, API contract baseline) |
| `0.2.0` | Tenant, identity, profile                                                           |
| `0.3.0` | RBAC/ABAC evaluator + assignment                                                    |
| `0.4.0` | Logging, pooling, security readiness                                                |
| `0.5.0` | Sync storage (outbox/inbox, conflict, R2 queue)                                     |
| `0.6.0` | UI shell, management reporting                                                      |
| `0.7.0` | Workflow approval, deployment profile                                               |
| `1.0.0` | Base production-ready                                                               |

Aplikasi turunan (mis. AWPOS) memakai peta versinya sendiri di atas base ini.

Nomor versi naik progresif per rilis, bukan hanya saat satu slot epic selesai penuh: rilis `0.2.0`-`0.4.0` berisi Issue 2.1 (tenant/office), 2.2 (central profile), dan 2.3 (identity/login) dari slot "Tenant, identity, profile" (tuntas); rilis `0.5.0` berisi Issue 2.4 (RBAC/ABAC) dari slot "RBAC/ABAC evaluator + assignment" (tuntas). Epic M2 (2.1–2.4) selesai penuh. Rilis `0.6.0` berisi Issue 12.1 (Setup Wizard) dan rilis `0.7.0` berisi Issue 6.1 (Sync Outbox/Inbox) — keduanya tidak punya slot eksplisit sendiri di tabel peta versi doc 09 (12.1 ditempatkan setelah M2, 6.1 dimulai dari slot "Sync storage" `v0.4.0` yang sebelumnya ditarget jauh lebih lambat dari realisasi progresif ini). Rilis `0.8.0` berisi Issue 6.2 (Sync Conflict Tracking/Resolution), lanjutan langsung dari slot "Sync storage" yang sama dengan 6.1. Rilis `0.9.0` berisi Issue 6.3 (R2 Object Sync Queue), menuntaskan epic M5 (Sync Storage) sepenuhnya. Rilis `0.10.0` berisi Issue 8.1 (Admin Layout Shell), issue pertama epic M7 (UI/UX & Reporting) dan issue frontend pertama di repo ini. Rilis `0.11.0` berisi Issue 9.1 (Management Reporting Views), menuntaskan epic M7 sepenuhnya. Rilis `0.11.1` adalah patch (bug fix jsonb double-encoding pada sync push, bukan issue baru). Rilis `0.12.0` berisi Issue 10.1 (Structured Logging and Audit Trail), issue pertama epic M8 (Security, Performance, Production). Rilis `0.13.0` berisi Issue 10.2 (Database Connection Pooling and Backpressure) — tidak ada migration baru, murni infrastruktur aplikasi. Rilis `0.14.0` berisi Issue 10.3 (Production Security Readiness Checklist) — juga tidak ada migration baru, murni tooling CLI yang memverifikasi kontrol yang sudah dibangun sebelumnya. Rilis `0.15.0` berisi Issue 11.1 (Workflow Approval Engine), mendarat lebih awal dari rencana semula (slot 015) karena mengikuti tepat setelah 10.3 yang tidak butuh migration. Rilis `0.16.0` berisi Issue 12.2 (Offline/LAN Deployment Profile) — tidak ada migration baru, murni aset deployment — menuntaskan epic M8 sekaligus seluruh backlog base generik (18 issue doc06).

[Unreleased]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.23.5...HEAD
[0.23.5]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.23.4...awcms-mini@0.23.5
[0.23.4]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.23.3...awcms-mini@0.23.4
[0.23.3]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.23.2...awcms-mini@0.23.3
[0.23.2]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.23.1...awcms-mini@0.23.2
[0.23.1]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.23.0...awcms-mini@0.23.1
[0.23.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.22.0...awcms-mini@0.23.0
[0.22.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.21.0...awcms-mini@0.22.0
[0.21.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.20.0...awcms-mini@0.21.0
[0.20.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.19.0...awcms-mini@0.20.0
[0.19.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.18.0...awcms-mini@0.19.0
[0.18.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.17.0...awcms-mini@0.18.0
[0.17.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.16.0...awcms-mini@0.17.0
[0.16.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.15.0...awcms-mini@0.16.0
[0.15.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.14.0...awcms-mini@0.15.0
[0.14.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.13.0...awcms-mini@0.14.0
[0.13.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.12.0...awcms-mini@0.13.0
[0.12.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.11.1...awcms-mini@0.12.0
[0.11.1]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.11.0...awcms-mini@0.11.1
[0.11.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.10.0...awcms-mini@0.11.0
[0.10.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.9.0...awcms-mini@0.10.0
[0.9.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.8.0...awcms-mini@0.9.0
[0.8.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.7.0...awcms-mini@0.8.0
[0.7.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.6.0...awcms-mini@0.7.0
[0.6.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.5.0...awcms-mini@0.6.0
[0.5.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.4.0...awcms-mini@0.5.0
[0.4.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.3.0...awcms-mini@0.4.0
[0.3.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.2.0...awcms-mini@0.3.0
[0.2.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.1.1...awcms-mini@0.2.0
[0.1.1]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.1.0...awcms-mini@0.1.1
[0.1.0]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.0.3...awcms-mini@0.1.0
[0.0.3]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.0.2...awcms-mini@0.0.3
[0.0.2]: https://github.com/ahliweb/awcms-mini/compare/awcms-mini@0.0.1...awcms-mini@0.0.2
[0.0.1]: https://github.com/ahliweb/awcms-mini/commits/main
