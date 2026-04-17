function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function isFreshStepUp(identitySession, options = {}) {
  if (!identitySession?.stepUpAuthenticated) {
    return false;
  }

  const maxAgeMs = options.maxAgeMs ?? 5 * 60 * 1000;
  const now = options.now ?? Date.now();
  const stepUpAt = Date.parse(identitySession.stepUpAt ?? "");

  if (!Number.isFinite(stepUpAt)) {
    return false;
  }

  return now - stepUpAt <= maxAgeMs;
}

export async function requireFreshTwoFactor({ session, maxAgeMs, now } = {}) {
  const identitySession = await session?.get("identitySession");

  if (!identitySession?.id) {
    return {
      ok: false,
      response: json({ error: { code: "NOT_AUTHENTICATED", message: "Not authenticated" } }, 401),
    };
  }

  if (!identitySession.twoFactorSatisfied) {
    return {
      ok: false,
      response: json({ error: { code: "STEP_UP_REQUIRED", message: "Fresh two-factor verification is required" } }, 403),
    };
  }

  if (!isFreshStepUp(identitySession, { maxAgeMs, now })) {
    return {
      ok: false,
      response: json({ error: { code: "STEP_UP_REQUIRED", message: "Fresh two-factor verification is required" } }, 403),
    };
  }

  return {
    ok: true,
    identitySession,
  };
}
