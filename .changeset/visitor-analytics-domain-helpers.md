---
"awcms-mini": minor
---

Add visitor identity, user-agent parsing, human/bot classification, path
sanitization, and referrer extraction helpers (Issue #619, epic: visitor
analytics #617-#624) under `src/modules/visitor-analytics/domain/`. Pure,
unit-tested functions (visitor-key, user-agent, human-classifier,
path-sanitizer, referrer) — not wired into any request path yet; the
middleware collector lands in Issue #620.
