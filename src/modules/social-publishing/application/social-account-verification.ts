/**
 * Orchestrates the "verify connection" admin action (Issue #644 —
 * `verify_meta_connection`, kept provider-neutral in shape even though
 * this issue only registers Meta adapters; #645/#646 can reuse this same
 * orchestrator for their own providers without changes). Composition-root
 * concern that sits between the HTTP route
 * (`pages/api/v1/social-publishing/accounts/[id]/verify.ts`) and the
 * adapter registry.
 *
 * 3-phase, same discipline the outbox dispatcher already established
 * (Keputusan kunci #5, `.claude/skills/awcms-mini-social-publishing/
 * SKILL.md`) — fetch inside a short transaction, call the external
 * provider OUTSIDE any transaction, persist the outcome inside a second
 * short transaction. Never holds a DB transaction open across the network
 * call (AGENTS.md rule #11 / ADR-0006).
 */
import { getProviderCircuitBreaker } from "../../../lib/database/circuit-breaker";
import { withTenant } from "../../../lib/database/tenant-context";
import { withTimeout } from "../../../lib/integration/timeout";
import type { SocialProviderCredentialCheck } from "../domain/social-provider-adapter";
import { getSocialProviderAdapter } from "../infrastructure/social-provider-registry";
import type { SocialAccountView } from "./social-account-directory";
import {
  fetchSocialAccountTokenReferenceForVerification,
  markSocialAccountNeedsReauth,
  recordSocialAccountVerificationSuccess
} from "./social-account-directory";

const VERIFY_CALL_TIMEOUT_MS = 10_000;

export type VerifySocialAccountConnectionOutcome =
  | { status: "not_found" }
  | { status: "provider_not_registered"; providerKey: string }
  | {
      status: "unsupported_account_type";
      providerKey: string;
      providerAccountType: string;
    }
  | { status: "circuit_breaker_open" }
  | { status: "valid"; account: SocialAccountView }
  | { status: "invalid"; reason: string };

export async function verifySocialAccountConnection(
  sql: Bun.SQL,
  tenantId: string,
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
  correlationId?: string
): Promise<VerifySocialAccountConnectionOutcome> {
  const accountInfo = await withTenant(sql, tenantId, (tx) =>
    fetchSocialAccountTokenReferenceForVerification(tx, tenantId, accountId)
  );

  if (!accountInfo) {
    return { status: "not_found" };
  }

  const adapter = getSocialProviderAdapter(accountInfo.providerKey);

  if (!adapter) {
    return {
      status: "provider_not_registered",
      providerKey: accountInfo.providerKey
    };
  }

  if (
    adapter.supportedAccountTypes &&
    !adapter.supportedAccountTypes.includes(accountInfo.providerAccountType)
  ) {
    return {
      status: "unsupported_account_type",
      providerKey: accountInfo.providerKey,
      providerAccountType: accountInfo.providerAccountType
    };
  }

  if (!accountInfo.tokenReference) {
    return { status: "invalid", reason: "missing_token_reference" };
  }

  const now = new Date();
  const breaker = getProviderCircuitBreaker(
    `social-publishing:${accountInfo.providerKey}`
  );

  if (!breaker.canAttempt(now)) {
    return { status: "circuit_breaker_open" };
  }

  let check: SocialProviderCredentialCheck;

  try {
    check = await withTimeout(
      adapter.verifyCredentials(
        accountInfo.tokenReference,
        accountInfo.scopesJson,
        env
      ),
      VERIFY_CALL_TIMEOUT_MS,
      `social-publishing:${accountInfo.providerKey}:verify`
    );
    breaker.recordSuccess(now);
  } catch {
    breaker.recordFailure(now);
    return { status: "invalid", reason: "verification_call_failed" };
  }

  if (check.valid) {
    const account = await withTenant(sql, tenantId, (tx) =>
      recordSocialAccountVerificationSuccess(
        tx,
        tenantId,
        accountId,
        correlationId
      )
    );

    if (!account) {
      return { status: "not_found" };
    }

    return { status: "valid", account };
  }

  await withTenant(sql, tenantId, (tx) =>
    markSocialAccountNeedsReauth(tx, tenantId, accountId, correlationId)
  );

  return { status: "invalid", reason: check.reason ?? "unknown" };
}
