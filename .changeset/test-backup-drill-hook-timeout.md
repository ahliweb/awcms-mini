---
"awcms-mini": patch
---

test: give the backup/restore drill integration hooks a realistic timeout

The suite's `afterAll` drops the databases created by the restore scripts.
`DROP DATABASE` forces a checkpoint, which on a busy runner exceeded the 5s
default hook timeout and failed an otherwise green run. Only the hooks get the
larger budget; test bodies and assertions are unchanged.
