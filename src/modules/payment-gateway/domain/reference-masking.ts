/**
 * Provider-reference masking for operator surfaces (Issue #878, epic #868).
 *
 * Issue #878 requires sensitive provider references masked BY DEFAULT. The
 * values this applies to — `provider_account_ref` (the merchant/account id at
 * the provider) and `provider_session_ref` (the hosted-checkout session) — are
 * not secrets in the credential sense (a signing secret is an `env:` pointer
 * and is never returned by any endpoint, ADR-0022 §6), but they identify a
 * tenant's real commercial account at a third party. An operator screen that
 * prints them in full puts them into screenshots, shared screens, and support
 * tickets, which is exactly what "masked by default" exists to prevent.
 *
 * This lives in `domain/` rather than inline in the admin page for one
 * concrete reason: logic inside an `.astro` file is not reachable by unit
 * tests and is not covered by `tsc --noEmit` (see the repository's own note
 * about `.astro` escaping typecheck), so a masking rule written there could
 * silently regress to showing the full value. `tests/unit/
 * payment-gateway-reference-masking.test.ts` pins the behaviour, and the admin
 * page's client script imports this module.
 */

/** What a masked reference shows when there is nothing to show. */
export const EMPTY_REFERENCE_PLACEHOLDER = "—";

/** How many trailing characters stay visible — enough to correlate a row with a provider dashboard, not enough to reconstruct the reference. */
export const VISIBLE_SUFFIX_LENGTH = 4;

/**
 * Masks a provider reference to its last {@link VISIBLE_SUFFIX_LENGTH}
 * characters.
 *
 * A value too short to mask meaningfully is replaced ENTIRELY rather than
 * shown in full: "mask by default" must not quietly become "show it if it is
 * short", which is how a masking helper usually fails open. `null`/`undefined`
 * /empty render as a placeholder, never as the string `"null"`.
 */
export function maskProviderReference(value: unknown): string {
  if (value === null || value === undefined) {
    return EMPTY_REFERENCE_PLACEHOLDER;
  }

  const raw = String(value);
  if (raw.length === 0) {
    return EMPTY_REFERENCE_PLACEHOLDER;
  }
  if (raw.length <= VISIBLE_SUFFIX_LENGTH) {
    return "••••";
  }

  return `••••${raw.slice(-VISIBLE_SUFFIX_LENGTH)}`;
}
