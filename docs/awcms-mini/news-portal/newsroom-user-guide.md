# News Portal — Newsroom User Guide

Panduan untuk editor/jurnalis yang mengunggah gambar berita di admin
AWCMS-Mini, mode **full-online R2-only** (lihat
[`full-online-r2-architecture.md`](full-online-r2-architecture.md) §1 —
panduan ini berlaku ketika deployment tenant Anda menggunakan mode ini;
tanyakan ke administrator sistem bila tidak yakin). Dokumen ini
menjelaskan **apa yang dialami editor**, bukan detail implementasi —
untuk SOP teknis lihat [`r2-upload-sop.md`](r2-upload-sop.md).

> **Catatan status**: layar upload gambar itu sendiri belum
> diimplementasikan pada saat dokumen ini ditulis (Issue #631,
> docs-only) — panduan ini menjelaskan **perilaku target** yang akan
> berlaku setelah Issue #632-#634 selesai. Bagian yang bergantung pada
> UI konkret ditandai jelas di bawah.

## 1. Mengapa gambar berita disimpan berbeda

Semua gambar berita di mode ini disimpan di **Cloudflare R2**, bukan di
server aplikasi. Bagi editor, ini berarti:

- Upload gambar sedikit berbeda dari "attach file biasa" — ada langkah
  tambahan di balik layar (upload langsung ke penyimpanan, lalu
  konfirmasi), tapi dari sisi UI tetap satu aksi "pilih file → upload".
- Setelah gambar berhasil diunggah dan dikonfirmasi, gambar tersebut
  **tidak bisa diganti isinya** — mengganti gambar berarti mengunggah
  file baru dan memilihnya ulang, bukan "menimpa" file lama.
- Tidak ada opsi "simpan ke folder lokal server" — bila upload ke R2
  gagal (mis. jaringan/penyimpanan sedang bermasalah), sistem akan
  menampilkan error dengan jelas, bukan diam-diam menyimpan ke tempat
  lain.

## 2. Cara mengunggah gambar berita (alur target)

1. Buka editor post/halaman/iklan yang mendukung gambar (featured image,
   galeri, iklan, thumbnail video).
2. Pilih "Unggah gambar" → pilih file dari perangkat Anda.
3. Sistem memvalidasi format dan ukuran file **sebelum** upload selesai
   — Anda akan melihat pesan error langsung bila file tidak didukung.
4. Tunggu hingga progres upload selesai dan status berubah menjadi
   "Terkonfirmasi"/"Confirmed". Gambar yang belum terkonfirmasi
   **belum** akan tampil di halaman publik.
5. Isi teks alternatif (`alt text`)/keterangan gambar — wajib untuk
   aksesibilitas dan SEO (lihat §5 di bawah).

## 3. Format dan ukuran file yang didukung

- Format yang didukung: **JPEG, PNG, WebP, GIF**.
- **SVG tidak didukung** untuk gambar berita — ini bukan keterbatasan
  sementara, tapi keputusan keamanan (file SVG bisa menyembunyikan
  kode berbahaya). Bila Anda punya logo/ilustrasi vektor, konversi ke
  PNG/WebP terlebih dahulu sebelum mengunggah.
- Ukuran maksimum per file: **10 MB** (default — administrator sistem
  Anda bisa mengubah batas ini; tanyakan bila Anda rutin bekerja dengan
  file lebih besar, mis. foto resolusi sangat tinggi).

## 4. Pesan error umum dan artinya

| Pesan/gejala                                                 | Artinya                                                                                               | Yang harus dilakukan                                                                              |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| "Format file tidak didukung"                                 | File bukan JPEG/PNG/WebP/GIF, atau namanya berekstensi gambar tapi isinya bukan gambar sungguhan.     | Pastikan file benar-benar gambar dengan salah satu format yang didukung, ekspor ulang bila perlu. |
| "Ukuran file terlalu besar"                                  | File melebihi batas maksimum (§3).                                                                    | Kompres/resize gambar sebelum mengunggah ulang.                                                   |
| "Link unggah kedaluwarsa"/upload gagal setelah lama menunggu | Proses upload memakan waktu lebih lama dari batas waktu link unggah (biasanya karena koneksi lambat). | Coba unggah ulang dari awal — link unggah tidak bisa "dilanjutkan", harus mengulang.              |
| Gambar sukses terunggah tapi tidak muncul di artikel         | Kemungkinan status belum "Terkonfirmasi" — proses konfirmasi gagal/belum selesai.                     | Tunggu sebentar dan refresh; bila tetap tidak muncul, hubungi administrator sistem.               |

## 5. Praktik terbaik untuk editor

- **Selalu isi `alt text`/teks alternatif** — pembaca yang memakai
  pembaca layar dan mesin pencari sama-sama bergantung pada teks ini,
  bukan gambar itu sendiri.
- **Perhatikan privasi subjek foto** — sebelum mengunggah foto yang
  memuat wajah/individu yang bisa dikenali, pastikan sudah sesuai
  kebijakan editorial redaksi Anda soal consent/privasi (sistem tidak
  secara otomatis memfilter ini — ini keputusan editorial, bukan
  teknis).
- **Beri atribusi/kredit foto** sesuai kebijakan redaksi (mis. di
  keterangan gambar) — sistem tidak memaksakan format kredit tertentu.
- **Jangan gunakan nama file yang mengandung informasi sensitif**
  (mis. nama lengkap narasumber di nama file) — meskipun sistem tidak
  memakai nama file asli untuk penyimpanan (§6 dokumen arsitektur), nama
  file tetap terlihat oleh sesama editor di daftar unggahan.
- **Gambar yang sudah dipublikasikan idealnya tidak dihapus** —
  konsisten dengan sifat berita sebagai arsip publik; bila gambar perlu
  diganti karena kesalahan, unggah gambar baru dan perbarui artikel,
  daripada menghapus riwayat.

## 6. Ke mana gambar Anda akan tampil

Satu gambar yang diunggah bisa dipakai di berbagai tempat, tergantung
bagaimana Anda memasangnya di editor:

- **Featured image** — gambar utama artikel, tampil di halaman detail
  dan daftar artikel.
- **Galeri** — beberapa gambar dalam satu blok galeri di dalam artikel.
- **Thumbnail video** — gambar sampul untuk blok video berita.
- **Gambar iklan** — dipasang oleh admin/pengelola iklan, mengikuti
  aturan validasi yang sama.
- **Gambar preview media sosial (SEO/Open Graph)** — gambar yang tampil
  saat artikel dibagikan ke media sosial/aplikasi chat.

Setiap penggunaan di atas melewati validasi yang sama (§3) — tidak ada
"jalur pintas" untuk salah satu jenis penggunaan.

## 7. Bila Anda mencurigai sesuatu yang tidak beres

Bila Anda melihat gambar yang jelas tidak diunggah oleh siapa pun di
redaksi Anda, gambar yang tampil sebelum seharusnya dipublikasikan,
atau menerima link unggah yang terasa mencurigakan — laporkan ke
administrator sistem Anda segera. Administrator sistem mengikuti
prosedur di [`r2-incident-response.md`](r2-incident-response.md).

## 8. Referensi untuk administrator sistem

- `full-online-r2-architecture.md` — arsitektur lengkap.
- `r2-upload-sop.md` — SOP teknis alur upload.
- `r2-security-checklist.md` — checklist keamanan.
- `r2-incident-response.md` — respons insiden.
