/**
 * Client IP resolution for visitor analytics (Issue #620, epic: visitor
 * analytics #617-#624). Pure — a distinct, more conservative sibling of
 * `lib/security/rate-limit.ts`'s `resolveClientIp` (which trusts
 * `X-Forwarded-For` unconditionally for rate-limit-key purposes). This
 * one only ever trusts a forwarded header when the deployment has
 * explicitly opted in via `VISITOR_ANALYTICS_TRUST_PROXY`/
 * `VISITOR_ANALYTICS_TRUST_CLOUDFLARE` (Issue #617's config gate) — same
 * principle as `PUBLIC_TRUST_PROXY` in the tenant-domain-routing epic:
 * never trust a spoofable client-supplied header without a trusted proxy
 * in front that actually overwrites it.
 *
 * Returns `null` (never a fake "unknown" placeholder) when no IP is
 * resolvable — `null` correctly hashes to nothing and stores as SQL
 * `NULL` in `ip_hash`/`ip_address`, rather than a meaningless-but-real-
 * looking hash of the literal string `"unknown"`.
 */
export function resolveAnalyticsClientIp(
  request: Request,
  clientAddress: string | undefined,
  trustConfig: { trustProxy: boolean; trustCloudflare: boolean }
): string | null {
  if (trustConfig.trustCloudflare) {
    const cfIp = request.headers.get("cf-connecting-ip")?.trim();
    if (cfIp) return cfIp;
  }

  if (trustConfig.trustProxy) {
    const forwardedFor = request.headers.get("x-forwarded-for");
    const first = forwardedFor?.split(",")[0]?.trim();
    if (first) return first;
  }

  return clientAddress?.trim() || null;
}
