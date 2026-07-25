---
"awcms-mini": patch
---

chore: refresh the graphify knowledge graph and stop committing `graph.html`

Graph rebuilt incrementally from commit `fed9be22` (was `59405c48`, stale by the
eight PRs of #937–#944): **11.130 node / 38.515 edge / 442 community**, 99%
EXTRACTED. 99 file kode di-ekstrak ulang, 1916 tak berubah, 124 berkas terhapus
dipangkas (123 node). Dijalankan `--code-only` — sama seperti build sebelumnya,
yang `cost.json`-nya mencatat **0 token**; 66 berkas dokumen butuh backend LLM
dan sengaja dilewati agar artefak ini tetap gratis dan deterministik.

**`graph.html` tidak lagi di-commit.** Graph sudah melewati batas visualisasi
default graphify (11.130 node > 5.000), jadi graphify melewatinya diam-diam —
yang berarti berkas 620 KB yang ter-commit sebelumnya kini menggambarkan graph
yang **berbeda** dari `graph.json` di sebelahnya. Visualisasi yang tidak cocok
dengan datanya lebih buruk daripada tidak ada. Menaikkan
`GRAPHIFY_VIZ_NODE_LIMIT` memang menghasilkannya, tapi bundelnya ~16 MB dan
praktis tak bisa dibuka pada ukuran itu, sekaligus menggandakan blob terbesar
repo setiap regenerate. Perintah regenerate lokal dicatat di `.gitignore`.

Ikut di-ignore: direktori backup bertanggal yang ditulis graphify tiap recluster
(masing-masing berisi salinan PENUH `graph.json`, ~21 MB) serta dua turunan run
terakhir (`.graphify_analysis.json`, `.graphify_labels.json.sig`).

Tidak ada perubahan runtime.
