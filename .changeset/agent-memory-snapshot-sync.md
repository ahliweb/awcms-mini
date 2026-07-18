---
"awcms-mini": patch
---

Tambah snapshot memory agent ke docs supaya konteks pengembangan bisa dimuat
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
