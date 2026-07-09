---
"awcms-mini": patch
---

Close a gap flagged as a non-blocking follow-up during the epic #555
security audit chain: `validateModuleSettingsPatch`
(`src/modules/module-management/domain/module-settings.ts`, the shared
validator behind every `PATCH /api/v1/tenant/modules/{moduleKey}/settings`
call across every module) only rejected secret-*named* keys
(`_shared/redaction.ts`'s `REDACTION_KEYS`). An admin could still paste a
real credential into an innocently-named field — e.g. a JWT or
`Bearer ...` token into `publicLabel` — and have it stored raw in
`awcms_mini_module_settings` and returned as-is via `GET`.

Added `findSecretShapedValues` to `src/modules/_shared/redaction.ts`: a
value-shape complement to the existing key-name check, scanning every
string value (recursively through nested objects/arrays) against a
deliberately conservative pattern set chosen to keep false positives near
zero — a JWT (three base64url segments), a PEM private key block, an AWS
access key id, a raw `Bearer `/`Basic ` header value, or a connection
string with an embedded `user:pass@` credential. Ordinary labels, URLs,
and feature flags never match.

`validateModuleSettingsPatch` now calls this after the existing key-name
check and rejects with a new `SETTINGS_SECRET_SHAPED_VALUE_REJECTED`
(`400`) error code when a match is found — the rejection message names
only the offending key path, never the value itself. The one route file
(`tenant/modules/{moduleKey}/settings.ts`) is already generic over
`ModuleSettingsErrorCode`, so this applies to every module on the
settings framework with zero route changes.

New tests: `tests/audit-log.test.ts`'s `findSecretShapedValues` (unit —
every pattern, plus a case proving ordinary label/URL/flag values are
never flagged) and
`tests/integration/module-settings.integration.test.ts`'s "PATCH rejects
a secret-shaped VALUE under an innocently-named key" (integration,
against the real database).
