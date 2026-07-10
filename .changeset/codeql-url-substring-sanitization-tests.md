---
"awcms-mini": patch
---

Fix two CodeQL `js/incomplete-url-substring-sanitization` findings (alerts
#19, #20) in test-only mock-fetch matchers introduced by PR #611
(`tests/unit/generic-oidc-client.test.ts`,
`tests/integration/tenant-sso-flow.integration.test.ts`). Both matched a
mock target URL with `url.startsWith("https://attacker.example.com")` to
decide when to simulate a failure response — inverted from the rule's
intended production-code shape (deciding whether to *trust* a URL by
prefix), and both sides of the comparison were fully test-controlled, so
this was not an exploitable issue. Replaced with an exact
`new URL(url).origin === "<origin>"` comparison, which is behaviorally
equivalent for these tests (still matches every path under that origin)
but no longer resembles the substring-sanitization anti-pattern CodeQL
flags. No runtime behavior change outside test files.
