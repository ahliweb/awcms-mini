import crypto from "node:crypto";

function normalizeBaseUrl(value) {
  if (typeof value !== "string") {
    return null;
  }

  const next = value.trim();
  return next.length > 0 ? next.replace(/\/$/, "") : null;
}

function createHttpProvider(config, endpointPath, fetchImpl = fetch) {
  return {
    async send(input) {
      const baseUrl = normalizeBaseUrl(config.baseUrl);
      const apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";

      if (!baseUrl || !apiKey) {
        throw new Error("Provider configuration is incomplete.");
      }

      const response = await fetchImpl(`${baseUrl}${endpointPath}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(input),
      });

      const bodyText = await response.text();
      let body = null;

      try {
        body = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        body = { raw: bodyText };
      }

      return {
        ok: response.ok,
        status: response.status,
        body,
        messageId: body?.id ?? body?.messageId ?? null,
      };
    },
  };
}

export function createMailketingProvider(config, fetchImpl = fetch) {
  return createHttpProvider(config, "/send", fetchImpl);
}

export function createStarsenderProvider(config, fetchImpl = fetch) {
  return createHttpProvider(config, "/send", fetchImpl);
}

export function verifyWebhookSignature({ payload, signature, secret }) {
  if (!secret) {
    return true;
  }

  const computed = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return signature === computed;
}
