/**
 * Composition root for the LinkedIn organization-page adapter (Issue #645).
 * Importing this module for its side effect registers the adapter into the
 * shared `social-provider-registry.ts` singleton for this process — matches
 * the sibling `telegram-provider-registration.ts` (Issue #646) convention
 * this repo settled on: one small, additive side-effect-import file per
 * adapter, imported at every process that can reach
 * `getSocialProviderAdapter("linkedin_organization")`.
 *
 * Unlike Telegram's registration (deliberately UNCONDITIONAL — see that
 * file's own header comment), this one stays CONDITIONAL on
 * `LINKEDIN_PROVIDER_ENABLED` (`registerLinkedInProviderAdapterIfEnabled`'s
 * existing behavior, unchanged) — a documented, different tradeoff, not an
 * oversight: see `.claude/skills/awcms-mini-social-publishing/SKILL.md`'s
 * §645 section for the reasoning already recorded there before Telegram's
 * unconditional approach existed to compare against.
 *
 * Every process that can reach `getSocialProviderAdapter("linkedin_organization")`
 * should import this module (for its side effect) at startup:
 *
 *   - `scripts/social-publish-dispatch.ts` (the outbox dispatcher) —
 *     currently wired via a direct `registerLinkedInProviderAdapterIfEnabled()`
 *     call instead of importing this file; both are equivalent, this file
 *     exists so NEW call sites (like the one below) can follow the same
 *     side-effect-import convention `telegram-provider-registration.ts`
 *     established.
 *   - `scripts/security-readiness.ts` (readiness scans connected accounts'
 *     provider keys against the registry) — same direct-call wiring as
 *     above.
 *   - `src/pages/api/v1/social-publishing/accounts/[id]/verify.ts` (the
 *     admin "verify connection" endpoint, Issue #646) — imports this file.
 */
import { registerLinkedInProviderAdapterIfEnabled } from "./linkedin-provider-adapter";

registerLinkedInProviderAdapterIfEnabled();
