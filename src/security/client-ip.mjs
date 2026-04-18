function normalizeHeaderValue(value) {
  if (typeof value !== "string") {
    return null;
  }

  const next = value.trim();
  return next.length > 0 ? next : null;
}

function firstForwardedAddress(value) {
  const header = normalizeHeaderValue(value);
  if (!header) {
    return null;
  }

  return header.split(",")[0]?.trim() || null;
}

function normalizeTrustedProxyMode(value) {
  return ["direct", "cloudflare", "forwarded-chain"].includes(value) ? value : "direct";
}

export function resolveTrustedClientIp(request, options = {}) {
  const headers = request?.headers;
  const trustedProxyMode = normalizeTrustedProxyMode(options.trustedProxyMode ?? process.env.TRUSTED_PROXY_MODE);

  if (trustedProxyMode === "cloudflare") {
    return normalizeHeaderValue(headers?.get?.("cf-connecting-ip")) ?? null;
  }

  if (trustedProxyMode === "forwarded-chain") {
    return firstForwardedAddress(headers?.get?.("x-forwarded-for"));
  }

  return null;
}

export { firstForwardedAddress, normalizeTrustedProxyMode };
