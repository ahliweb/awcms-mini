---
"awcms-mini": patch
---

fix(data-exchange): tutup empat cacat raw-value guard pada preview import (#820) dan klamp `offset` (#831)

`GET /api/v1/data-exchange/imports/{id}/preview` mengembalikan nilai staged mentah hanya bila descriptor pemiliknya menyatakannya, dan hanya kepada pemegang izin yang **descriptor itu sendiri** sebutkan. Empat cacat yang saling menguat (laten — belum ada modul yang mendaftarkan descriptor sensitif; ini perangkap untuk turunan pertama):

- **Default-allow dibalik jadi default-deny**: `sensitiveFields` kini **wajib** (registry gate menolak descriptor tanpanya — nyatakan `{ fieldNames: [] }` bila memang tak ada yang sensitif). Descriptor tanpa policy kini di-mask seluruhnya dan tak ada izin yang membukanya; sebelumnya lalai mendeklarasikan justru **membuka** semua nilai tanpa cek izin sama sekali.
- **`sensitiveFields.rawValuePermission` kini benar-benar ditegakkan**: sebelumnya divalidasi saat registrasi tapi nol enforcement site — route memakai konstanta hardcoded `data_exchange.preview_errors.read` yang jauh lebih luas, sehingga deklarasi izin sempit descriptor (mis. `profile_identity.identifiers.reveal_raw`) diabaikan diam-diam.
- **Descriptor tak terselesaikan kini fail-closed**: `authorizeExchangeDescriptorPermission` tidak lagi menerima `null` (fail-open yang bertentangan dengan komentarnya sendiri). Batch yang modul pemiliknya di-disable setelah staging kini ditolak `409 INVALID_STATE` pada preview/commit/retry/download — sebelumnya batch justru menjadi **lebih terbuka** setelah modulnya dimatikan.
- **`naturalKey` ikut di-mask** bila `sensitiveFields.naturalKeyField` menyebut field yang sensitif — kunci dedup import profil lazimnya justru email/NIK.

Perubahan perilaku untuk aplikasi turunan: `ExchangeDescriptor.sensitiveFields` wajib; `ExchangeSensitiveFieldPolicy` menerima `naturalKeyField` opsional; `authorizeExchangeDescriptorPermission` menerima `ExchangeDescriptor` non-nullable.

`offset` preview kini diklamp atas ke `PREVIEW_OFFSET_MAX` (= `MAX_EXCHANGE_ROW_COUNT`, sehingga tak menyembunyikan baris yang bisa dijangkau) — sebelumnya hanya dicek `>= 0` sementara `limit` tepat di baris berikutnya sudah diklamp, jadi `?offset=5000000` diteruskan apa adanya ke Postgres.
