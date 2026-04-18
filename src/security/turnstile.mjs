import { randomUUID } from "node:crypto";

import { getRuntimeConfig } from "../config/runtime.mjs";

export class TurnstileValidationError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = "TurnstileValidationError";
    this.code = code;
    this.metadata = metadata;
  }
}

function createSiteverifyFormData({ secretKey, token, remoteIp, idempotencyKey }) {
  const formData = new FormData();
  formData.append("secret", secretKey);
  formData.append("response", token);

  if (remoteIp) {
    formData.append("remoteip", remoteIp);
  }

  if (idempotencyKey) {
    formData.append("idempotency_key", idempotencyKey);
  }

  return formData;
}

function normalizeErrorCodes(result) {
  return Array.isArray(result?.["error-codes"])
    ? result["error-codes"].map((value) => String(value))
    : [];
}

export async function validateTurnstileToken(input, options = {}) {
  const runtimeConfig = options.runtimeConfig ?? getRuntimeConfig();
  const turnstileConfig = runtimeConfig.turnstile ?? {};

  if (!turnstileConfig.enabled || !turnstileConfig.secretKey) {
    return { enabled: false, success: true };
  }

  const token = typeof input?.token === "string" ? input.token.trim() : "";

  if (!token) {
    throw new TurnstileValidationError("TURNSTILE_REQUIRED", "Turnstile token is required.");
  }

  if (token.length > 2048) {
    throw new TurnstileValidationError("TURNSTILE_INVALID", "Turnstile token is not valid.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  try {
    const response = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: createSiteverifyFormData({
        secretKey: turnstileConfig.secretKey,
        token,
        remoteIp: input.remoteIp ?? null,
        idempotencyKey: options.idempotencyKey ?? randomUUID(),
      }),
      signal: controller.signal,
    });

    const result = await response.json();
    const errorCodes = normalizeErrorCodes(result);

    if (!result?.success) {
      throw new TurnstileValidationError("TURNSTILE_INVALID", "Turnstile validation failed.", { errorCodes });
    }

    if (input.expectedAction && result.action !== input.expectedAction) {
      throw new TurnstileValidationError("TURNSTILE_ACTION_MISMATCH", "Turnstile action mismatch.", {
        expectedAction: input.expectedAction,
        receivedAction: result.action ?? null,
      });
    }

    if (turnstileConfig.expectedHostname && result.hostname !== turnstileConfig.expectedHostname) {
      throw new TurnstileValidationError("TURNSTILE_HOSTNAME_MISMATCH", "Turnstile hostname mismatch.", {
        expectedHostname: turnstileConfig.expectedHostname,
        receivedHostname: result.hostname ?? null,
      });
    }

    return {
      enabled: true,
      success: true,
      hostname: result.hostname ?? null,
      action: result.action ?? null,
      challengeTs: result.challenge_ts ?? null,
    };
  } catch (error) {
    if (error instanceof TurnstileValidationError) {
      throw error;
    }

    if (error?.name === "AbortError") {
      throw new TurnstileValidationError("TURNSTILE_UNAVAILABLE", "Turnstile validation timed out.");
    }

    throw new TurnstileValidationError("TURNSTILE_UNAVAILABLE", "Turnstile validation failed.");
  } finally {
    clearTimeout(timeout);
  }
}
