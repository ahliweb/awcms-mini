---
"awcms-mini": patch
---

docs(skills): skill untuk 5 modul aktif yang belum punya + gate anti-drift modul↔skill (Issue #829)

Menulis skill proyek untuk lima modul aktif yang sebelumnya **tidak punya
panduan konvensi tertulis sama sekali**, padahal 18 modul lain punya:
`awcms-mini-data-exchange`, `awcms-mini-reference-data`,
`awcms-mini-domain-event-runtime`, `awcms-mini-organization-structure`, dan
`awcms-mini-reporting`. Kelimanya disambungkan ke dua katalog discoverability
(`AGENTS.md` + `.claude/skills/README.md`), dan jumlah skill di doc 13
dikoreksi (39 → 50; sudah salah sejak beberapa epic lalu).

**Akar drift-nya, dan kenapa menambal 5 skill saja tidak cukup.** Ini
kemunculan **keenam** dari kelas skill/doc drift (lih. #805 dan
pendahulunya). Penyebabnya bukan "lima kali lupa": tidak ada satu pun gate
yang membandingkan registry modul dengan direktori skill. Registry tahu ada
23 modul; tidak ada yang mengecek angka itu terhadap `.claude/skills/`.
Konvensi "skill baru wajib disambungkan ke katalog" pun hanya konvensi tertulis,
tanpa penegakan — persis celah yang membuat 4 skill baru di PR #806 lolos tanpa
satu pun baris katalog. Empat dari lima modul tanpa skill justru muncul sebagai
SUMBER temuan di audit #818 (#820, #822, #826, #786) — kebetulan yang bukan
kebetulan: modul tanpa konvensi tertulis adalah modul yang konvensinya melenceng.

Karena itu inti perubahan ini adalah **gate**-nya, bukan kelima file skill:
`tests/unit/module-skill-coverage.test.ts` (jalan lewat `bun test`, sudah bagian
`bun run check`) mewajibkan setiap modul di base registry (`listBaseModules()`)
tercatat EKSPLISIT di tepat satu dari dua map — punya skill dedikasi, atau
masuk **allow-list eksplisit** yang menyebut skill lintas-potong yang menanggung
panduannya plus alasannya (dan skill itu wajib benar-benar ada, supaya alasannya
tidak bisa diam-diam jadi bohong). Modul yang tidak ada di keduanya gagal
keras dengan instruksi remediasi. Gate ini juga menegakkan bahwa setiap skill
dedikasi benar-benar ada di disk, nama frontmatter-nya cocok dengan direktorinya,
dan **tersambung di KEDUA katalog** — file SKILL.md yang tidak ditunjuk apa pun
tidak dianggap selesai.

Gate-nya langsung membuktikan diri pada run pertama: menemukan bahwa key modul
yang terdaftar sebenarnya `workflow`, bukan `workflow_approval` seperti yang
tertulis di direktori dan seluruh dokumentasinya (dicatat inline; rename key
di luar scope karena memindahkan seluruh namespace permission `workflow.*`).
