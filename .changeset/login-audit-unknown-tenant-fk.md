---
"awcms-mini": patch
---

Perbaiki regresi yang diperkenalkan Issue #821: audit `login_failed` /
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
