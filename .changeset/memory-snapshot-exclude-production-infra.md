---
"awcms-mini": patch
---

security(tooling): jangan terbitkan detail infrastruktur produksi lewat snapshot memory

`docs/awcms-mini/agent-memory.md` terbit ke repo **publik**, tapi `sanitize()` hanya menangani `originSessionId`, homedir, dan placeholder berbentuk-password — detail infrastruktur lolos utuh. Dua memory dikecualikan di level file (`EXCLUDE`): `dinkes-prod-multi-app-coolify-onboarding.md` (IP publik server produksi, alias ssh, username admin + konfigurasi sudo, topologi IP internal pada bridge Docker, detail hardening) dan `pasted-secret-in-chat-treat-as-compromised.md` (menautkan server itu ke insiden kredensial konkret; tidak memuat nilai secret apa pun).

Mengecualikan file saja ternyata setengah jalan: `MEMORY.md` memuat hook satu baris per memory yang **merangkum** isinya, sehingga baris indeks tetap membocorkan hal yang sama — termasuk username admin server tersebut. `dropExcludedIndexLines()` kini membuang baris indeks yang menunjuk memory ter-`EXCLUDE`, beserta heading yang seluruh entrinya terbuang (judul tersisa tanpa entri tidak memberi informasi apa pun tapi tetap menyebut nama servernya). `[[wikilink]]` di tengah prosa sengaja dibiarkan menggantung — perilaku lama yang sudah didokumentasikan.

`main()` kini dijaga `import.meta.main` agar fungsinya bisa diimpor, dan `tests/unit/sync-agent-memory-index-exclusion.test.ts` mengunci perilaku di atas.
