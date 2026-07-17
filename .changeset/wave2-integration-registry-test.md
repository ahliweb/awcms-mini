---
"awcms-mini": patch
---

Perbaiki test base-registry domain-event yang membaca array yang salah.

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
