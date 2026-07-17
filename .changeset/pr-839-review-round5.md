---
"awcms-mini": patch
---

Perbaiki temuan review PR #839 ronde 5: replay idempotent pada
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
