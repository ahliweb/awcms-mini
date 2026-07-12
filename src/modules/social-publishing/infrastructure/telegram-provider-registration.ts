/**
 * Composition root for the Telegram channel adapter (Issue #646). Importing
 * this module for its side effect registers
 * `createTelegramChannelProviderAdapter()` into the shared
 * `social-provider-registry.ts` singleton — matching the "registration is a
 * composition-root concern, not a domain/application concern" convention
 * this repo already applies to `setLogSink`/`setAuditExportHook`
 * (`social-provider-registry.ts`'s own header comment).
 *
 * Registration is UNCONDITIONAL (it happens regardless of
 * `TELEGRAM_PROVIDER_ENABLED`) — registering only wires the adapter's code
 * up in this process's registry Map, it makes no network call by itself.
 * The adapter's own `publish()`/`verifyCredentials()` check
 * `TELEGRAM_PROVIDER_ENABLED` before ever calling `api.telegram.org` (see
 * `telegram-provider-adapter.ts`). This split means
 * `checkSocialPublishingProviderReadiness`
 * (`scripts/security-readiness.ts`) never misreports "no adapter
 * registered" for a `telegram_channel` account just because the deployment
 * operator hasn't flipped the Telegram-specific flag on yet — it correctly
 * distinguishes "adapter not registered at all" (a deployment bug) from
 * "adapter registered but the provider is deployment-disabled" (an
 * intentional configuration).
 *
 * Every process that can reach `getSocialProviderAdapter("telegram_channel")`
 * must import this module (for its side effect) at startup:
 *
 *   - `scripts/social-publish-dispatch.ts` (the outbox dispatcher).
 *   - `scripts/security-readiness.ts` (readiness scans connected accounts'
 *     provider keys against the registry).
 *   - `src/pages/api/v1/social-publishing/accounts/[id]/verify.ts` (the
 *     admin "verify connection" endpoint, Issue #646).
 *
 * A future #644 (Meta)/#645 (LinkedIn) adapter should add its own sibling
 * file the same way (e.g. `meta-provider-registration.ts`) and its own
 * import at each of those same three call sites — this repo's convention is
 * one small, additive import per adapter, not a shared "register everything"
 * file, to keep each adapter's PR diff isolated and easy to merge
 * independently of the others landing in parallel.
 */
import { registerSocialProviderAdapter } from "./social-provider-registry";
import { createTelegramChannelProviderAdapter } from "./telegram-provider-adapter";

registerSocialProviderAdapter(createTelegramChannelProviderAdapter());
