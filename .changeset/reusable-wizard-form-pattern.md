---
"awcms-mini": minor
---

Add a reusable multi-step wizard form pattern for derived-application admin
screens: `WizardStepper`/`WizardPanel`/`WizardActions` Astro components and
a pure `src/lib/ui/wizard-client.ts` state helper (step navigation, per-step
validation, field-error mapping, and idempotency-key generation for the
final submit). No schema or API change — server-side validation, ABAC/RLS,
audit, and idempotency remain the authoritative controls for any domain
module that adopts this pattern. See
`docs/awcms-mini/examples/wizard-form-pattern.md` (Issue #479, PR #480).
