---
"awcms-mini": patch
---

Collapse the module health fan-out from O(modules) to O(1) (Issue #824).

`fetchModuleMatrix` and `admin/modules.astro` resolved health by calling
`fetchModuleHealthReport` once per registered module, and each call ran its own
registry lookup, migration scan, permission-catalog query and settings lookup —
94 queries to render one admin screen at 23 modules, growing with every module
added. Those four inputs are now prefetched once per render
(`prepareModuleHealthContext`) and shared across modules, and multi-module
callers use the new `fetchModuleHealthReports` batch entry point.

Separately, `readYamlCached` populated its cache only after awaiting, so the 22
modules declaring the same ~1 MB `openapi.yaml` each read and parsed that file
concurrently on a cold render. It now caches the in-flight promise, so
concurrent callers join one parse; `listMigrationFileNames` is cached the same
way (it was re-`readdir`-ing on every signal).

Measured per render at 23 modules: 94 → 6 queries, ~3.8s → ~0.36s cold, ~10ms →
~6ms warm. No behaviour change — the same signals, order, statuses and generic
(never raw) error details. `includeHealth: false` still runs zero health work.
