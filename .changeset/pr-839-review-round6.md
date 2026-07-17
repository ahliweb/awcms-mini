---
"awcms-mini": patch
---

Perbaiki tiga temuan review PR #839 ronde 6.

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
