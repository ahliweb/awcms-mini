---
"awcms-mini": patch
---

Percepat deteksi konflik SoD (`detectSoDConflicts`) dengan meng-hoist index
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

| Skenario                                        | Sebelum              | Sesudah  | Speedup |
| ----------------------------------------------- | -------------------- | -------- | ------- |
| Registry apa adanya hari ini (3 rule, P=150, F=1000, S=20) | 0.067 ms (7.203 kunjungan elemen) | 0.056 ms | 1,2x    |
| Registry bertumbuh (50 rule, P=200, F=1000, S=20)          | 1,458 ms (332.391 kunjungan)       | 0,166 ms | 8,8x    |
| Tenant besar (50 rule, P=200, F=5000, S=200)               | 9,564 ms (2.173.191 kunjungan)     | 0,393 ms | 24,4x   |

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
