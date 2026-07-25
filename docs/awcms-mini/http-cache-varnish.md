# Edge cache (Varnish)

Cache HTTP di depan aplikasi untuk profil **staging** dan **production**,
supaya permintaan berulang tidak selalu berakhir sebagai query ke database.
Tidak ada di profil LAN-first/offline (`docker-compose.yml`): di sana satu
tenant berjalan di satu mesin, sehingga satu hop tambahan tidak membeli apa pun
dan hanya menyulitkan debugging.

Berkas terkait:

- `deploy/varnish/default.vcl` — konfigurasi edge.
- `src/lib/http/cache-policy.ts` — separuh aplikasi: yang MEMUTUSKAN apa yang
  boleh di-cache.
- `docker-compose.prod.yml` service `cache`.
- `bun run varnish:cache:check` — verifikasi perilaku (butuh Docker).

## Aturan tunggal: default deny

Edge **tidak menyimpan apa pun** yang tidak ditandai eksplisit oleh aplikasi.

Sebelum ini aplikasi tidak pernah mengirim header `Cache-Control` sama sekali.
Itu aman selama tidak ada apa pun di depannya — begitu ada shared cache (Varnish,
CDN, proxy korporat), cache itu jatuh ke heuristiknya sendiri, dan untuk GET 200
heuristik itu umumnya berarti "simpan". Pada aplikasi multi-tenant yang
menentukan tenant dari `Host` dan otorisasinya per-sesi, itulah persis cara
halaman satu tenant tersaji ke tenant lain.

Karena itu keputusan cacheability dibuat di **aplikasi**, oleh kode yang tahu
apakah sebuah respons memuat data ber-scope tenant/pengguna. `ensureDefaultCachePolicy`
berjalan di satu chokepoint middleware yang dilewati SETIAP respons, dan
menstempel `private, no-store` pada apa pun yang tidak opt-in. Penulis route yang
tidak tahu apa-apa soal caching otomatis mendapat perilaku aman.

## Dua kelas yang boleh di-cache

| Kelas     | Header yang dikirim aplikasi                                                      | Siapa yang menyimpan    | TTL maks |
| --------- | --------------------------------------------------------------------------------- | ----------------------- | -------- |
| `public`  | `Cache-Control: public, max-age=N`                                                | browser, CDN, edge kita | 300 s    |
| `session` | `Cache-Control: private, no-store` **+** `X-AWCMS-Edge-Cache: session; max-age=N` | **hanya** edge kita     | 60 s     |
| (default) | `Cache-Control: private, no-store`                                                | tidak ada               | —        |

### Kenapa `session` tidak memakai `private, max-age=N`

`private` mengizinkan cache **browser** menyimpan halaman terautentikasi, dan
sebagian intermediary memperlakukannya longgar — sementara ia tidak memberi
instruksi apa pun ke edge kita sendiri. Jadi respons `session` dikirim dengan
`no-store` (hal paling ketat yang dipahami semua cache generik) plus header
terpisah `X-AWCMS-Edge-Cache` yang **hanya** dibaca Varnish kita dan **dihapus
Varnish sebelum dikirim ke klien**. Semua cache selain milik kita diberi tahu
"jangan simpan"; milik kita diberi tahu "simpan, kunci per sesi". Polanya sama
dengan `Surrogate-Control`.

TTL `session` sengaja jauh lebih pendek: respons itu mencerminkan status
otorisasi. Halaman terautentikasi yang basi setelah perubahan role, suspend,
atau entitlement kedaluwarsa adalah **masalah keamanan**, bukan sekadar
kesegaran. Karena itu `grace` dan `keep` juga nol untuk kelas ini — Varnish tidak
boleh menyajikan versi basi walau backend sedang bermasalah.

## Bentuk cache key

`vcl_hash` selalu mencampurkan:

1. **URL**
2. **Host (dinormalisasi lowercase)** — isolasi tenant untuk halaman publik.
3. **Cookie locale** — halaman `id` tidak boleh menjawab permintaan `en`.
4. **Cookie sesi + cookie tenant** — isolasi per-pengguna, ditambahkan setiap
   kali cookie sesi ada.

Komponen sesi ditambahkan **sebelum** kita tahu bagaimana backend akan
mengklasifikasikan respons. Konsekuensinya: pengunjung yang sudah login mendapat
salinannya sendiri untuk halaman yang sebenarnya publik. Duplikasi itu disengaja
— alternatifnya adalah key yang benar HANYA jika klasifikasi backend benar, dan
bug di sana membocorkan halaman satu pengguna ke pengguna lain.

## Yang tidak pernah di-cache

Ditegakkan di `vcl_recv`, terlepas dari apa kata aplikasi:

- metode selain `GET`/`HEAD`;
- permintaan dengan header `Authorization` (traffic API bertoken);
- `/api/v1/auth/*`, `/login`, `/logout` — respons ter-cache di sini adalah bug
  session-fixation;
- `/api/v1/health`, `/metrics` — instance yang sakit harus terbaca sakit, bukan
  sehat selama satu TTL.

Ditambah, di `vcl_backend_response`: respons dengan `Set-Cookie` **tidak pernah**
disimpan, bahkan bila ditandai cacheable. Aplikasi sudah memaksanya ke
`no-store`; aturan di VCL adalah lapis kedua, karena akibat kelolosan satu kasus
sangat berat (cookie sesi/locale/tenant satu pengunjung tersaji ke pengunjung
berikutnya).

## Invalidasi

Selain TTL pendek, edge menerima metode `BAN`:

```sh
curl -X BAN -H "Host: tenant.example.com" -H "X-Ban-Url: ^/blog/" http://cache/
```

`BAN` di-scope per-Host secara konstruksi — ban untuk satu tenant tidak pernah
bisa mengusir entri tenant lain, seberapa pun luas pola URL-nya. ACL `purgers`
membatasi pemanggilnya ke jaringan container; endpoint ban yang terjangkau dari
internet adalah denial-of-service flush-cache yang trivial.

## Verifikasi

`varnishd -C` hanya membuktikan berkasnya **parse**. Yang penting adalah apakah
cache benar-benar **mengisolasi**, dan itu properti cache yang berjalan:

```sh
bun run varnish:cache:check
```

Skrip itu menjalankan Varnish sungguhan terhadap backend stub lalu membuktikan
sembilan properti lewat HTTP (isolasi tenant/sesi/locale, `no-store` tidak
tersimpan, `Set-Cookie` tidak tersimpan, health/POST tidak di-cache) plus lima
header internal yang wajib terhapus. Jalankan setiap kali `default.vcl` berubah:
VCL tidak punya type checker dan tidak ada peringatan kompiler untuk "key ini
kehilangan satu dimensi", sehingga review yang hanya membaca diff tidak bisa
menangkap satu-satunya bug yang berarti.

Setiap assertion di sana sudah diverifikasi merah: menghapus komponen sesi dari
`vcl_hash` membuat kasus isolasi per-pengguna gagal, dengan user B menerima
halaman ter-cache milik user A.

Skrip ini **bukan** bagian `bun run check` karena butuh Docker dan menarik image
Varnish — alasan yang sama dengan suite Playwright.

## Menandai sebuah route cacheable

```ts
import { applyCachePolicy } from "../../lib/http/cache-policy";

// Halaman publik, sama untuk semua pengunjung host ini.
applyCachePolicy(response, { kind: "public", maxAgeSeconds: 120 });

// Halaman terautentikasi, hanya edge kita, kunci per sesi.
applyCachePolicy(response, { kind: "session", maxAgeSeconds: 30 });
```

TTL yang melebihi plafon kelasnya **di-clamp**, bukan ditolak: permintaan TTL
terlalu panjang berakhir di nilai aman. Melempar error akan mengubah kesalahan
caching menjadi outage, dan menuruti begitu saja akan mengubah salah ketik
menjadi bug otorisasi basi.

## Batasan yang perlu diketahui

- Cache ini mengurangi beban database untuk **pembacaan berulang**. Ia tidak
  membantu jalur tulis, dan tidak menggantikan cache tingkat query
  (`src/lib/redis/cache.ts`) maupun `public-tenant-cache.ts`.
- Pengunjung yang login mendapat entri per-sesi, sehingga hit rate untuk halaman
  publik lebih rendah bagi mereka daripada bagi pengunjung anonim. Itu harga
  isolasi, dan disengaja.
- `docker-compose.prod.yml` tidak lagi mem-publish port `4321` milik `app`.
  Edge adalah satu-satunya ingress; mem-publish keduanya akan membuat permintaan
  bisa melewati edge — persis kelas kesalahan yang membuat cache tampak benar
  saat diuji dan bocor saat produksi.
