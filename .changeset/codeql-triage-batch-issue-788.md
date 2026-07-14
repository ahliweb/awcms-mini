---
"awcms-mini": patch
---

Triage 15 open CodeQL code-scanning alerts (Issue #788): remove genuinely
dead test imports, close 3 real test-coverage gaps the alerts incidentally
surfaced (news-media R2 deletion assertion, social-publishing rule-list
tenant-isolation test, LinkedIn API version resolver unit tests), and
dismiss 2 confirmed false positives (Bun.SQL tagged-template parameter
binding misread as implicit string coercion) plus 1 won't-fix (a
build-time extension-seam conditional that's genuinely trivial in this
base repo by design). No production behavior change.
