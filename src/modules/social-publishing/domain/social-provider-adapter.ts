import type { SocialAccountType } from "./social-account-validation";

/**
 * Pluggable provider-adapter interface (Issue #643). This is the ONE seam
 * future issues #644 (Meta/Facebook+Instagram), #645 (LinkedIn), and #646
 * (Telegram) implement — this foundation issue ships ZERO real adapters
 * (see `infrastructure/social-provider-registry.ts`, which starts with an
 * empty registry) and makes NO real HTTP calls to any social platform.
 *
 * Deliberately provider-neutral: no field here assumes OAuth vs bot-token
 * auth, no field assumes image support, no field assumes a specific
 * character limit — those are per-provider concerns the adapter itself
 * handles internally (rejecting/truncating/adapting as needed before or
 * during `publish`). The dispatcher (`application/social-publish-dispatch.ts`)
 * only ever depends on this interface, never a concrete provider's SDK/API
 * shape.
 */

export type SocialPublishContentSnapshot = {
  title: string;
  /** Excerpt or a template-rendered caption — whichever the job snapshot resolved to at creation time (see `create-social-publish-jobs.ts`). */
  excerptOrCaption: string;
  canonicalUrl: string;
  /** Verified R2 public image URL, or `null` when the article has none / the provider adapter doesn't need one. */
  imageUrl: string | null;
};

export type SocialProviderPublishRequest = {
  tenantId: string;
  providerAccountId: string;
  /**
   * The account's `token_reference` (never a raw token — see
   * `social-account-validation.ts`'s header comment). A real adapter
   * resolves this to actual credentials via its own secret-storage
   * integration; this foundation never does that resolution itself.
   */
  tokenReference: string;
  /** Deterministic per (tenant, article, account, action) key — pass through to the provider's own idempotency mechanism where one exists (e.g. an `Idempotency-Key`-style header), so a dispatcher-level retry after a provider-side timeout cannot double-post. */
  idempotencyKey: string;
  content: SocialPublishContentSnapshot;
  correlationId?: string;
};

export type SocialProviderPublishSuccess = {
  outcome: "published";
  externalPostId: string;
  externalPostUrl: string;
};

export type SocialProviderPublishFailure = {
  outcome: "failed" | "rate_limited" | "needs_reauth";
  /** Sanitized, safe-to-log/audit code — NEVER a raw provider error body that could embed a token/secret. */
  errorCode: string;
  /** Sanitized, safe-to-log/audit message. */
  errorMessage: string;
  /** Whether the dispatcher's retry/backoff should retry this job again. `needs_reauth` outcomes are never retryable by backoff alone (a human must reconnect the account first). */
  retryable: boolean;
  /** Provider-supplied hint (e.g. a rate-limit `Retry-After`) for `outcome: "rate_limited"`. */
  retryAfterSeconds?: number;
};

export type SocialProviderPublishResult =
  SocialProviderPublishSuccess | SocialProviderPublishFailure;

export type SocialProviderCredentialCheck = {
  valid: boolean;
  reason?: string;
};

export type SocialProviderAdapter = {
  /** Must match the `provider_key` format check (`^[a-z][a-z0-9_]{1,49}$`) and the value stored on connected accounts using this adapter. */
  providerKey: string;
  /** Deployment env vars this provider needs configured to be usable — consumed by the readiness check (`scripts/security-readiness.ts`'s `checkSocialPublishingProviderReadiness`), NOT enforced by this file itself. */
  requiredEnvVars: readonly string[];
  /**
   * Optional (Issue #644) — `awcms_mini_social_accounts.provider_account_type`
   * values this adapter can actually publish to (e.g. Meta's Page/Instagram
   * adapters only ever support `"page"` — a linked Instagram professional
   * account is still connected as a `"page"`-type row here, since Meta's
   * Graph API always publishes through a Page access token; a `"profile"`
   * connection would mean a personal profile, explicitly out of scope for
   * every Meta adapter action). Omitted entirely (`undefined`) means "no
   * per-type restriction is modeled for this adapter" — callers (readiness
   * checks, the `verifyCredentials` HTTP action) must treat `undefined` as
   * "any type is acceptable," never as "no type is acceptable." Kept
   * separate from `verifyCredentials`'s signature (which has no account-row
   * context) so this stays a simple, synchronous, no-I/O field any caller
   * that already has the account row in hand can check directly.
   */
  supportedAccountTypes?: readonly SocialAccountType[];
  /** Performs the actual external publish call. Must apply its own timeout — the dispatcher additionally wraps this in `withTimeout`/a circuit breaker (`social-publish-dispatch.ts`), but a well-behaved adapter should not rely solely on the caller's outer timeout. Never throws for an ordinary provider-rejected outcome (rate limit, expired token, content policy violation) — those are `SocialProviderPublishFailure` values; throwing is reserved for genuinely unexpected conditions (network error, bug), which the dispatcher catches and treats as a retryable `"failed"` outcome. */
  publish(
    request: SocialProviderPublishRequest
  ): Promise<SocialProviderPublishResult>;
  /** Best-effort credential/scope check (e.g. for the readiness gate or a manual "verify connection" admin action) — never throws, returns `{valid:false, reason}` on any failure. */
  verifyCredentials(
    tokenReference: string,
    scopesJson: unknown,
    env?: NodeJS.ProcessEnv
  ): Promise<SocialProviderCredentialCheck>;
};
