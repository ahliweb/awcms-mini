---
"awcms-mini": patch
---

chore: remove sensitive references and stop publishing agent memory

The generated agent-memory snapshot, its sync script, the related package
scripts and its unit test are removed. Local paths in docs are replaced with
placeholders, an internal reference in the deploy skill is made generic, and one
changelog entry is redacted. No runtime behaviour changes.
