---
"awcms-mini": patch
---

chore: commit output knowledge-graph graphify (`graphify-out/`) sebagai artefak repo — `graph.json` (10.940 node / 38.983 edge, dibangun dari commit `59405c48`), `graph.html`, `GRAPH_REPORT.md`, `manifest.json`, `cost.json`, dan `.graphify_labels.json`. Cache inkremental (`graphify-out/cache/`) serta penanda lokal per-mesin (`.graphify_root`, `.graphify_python`) di-ignore, dan `graphify-out/` ditambahkan ke `.prettierignore` supaya `bun run lint` tidak memformat ulang blob 20 MB tiap regenerate. Tidak ada perubahan runtime.
