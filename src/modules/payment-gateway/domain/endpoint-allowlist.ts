/**
 * SSRF / open-redirect protection for `payment_gateway` (Issue #877, ADR-0022
 * §Security). PURE — no I/O. A provider API endpoint (outbound) and a callback/
 * return URL (open-redirect) are ALLOW-LISTED per provider account by their
 * HOST, and validated with `new URL()` + strict HOST EQUALITY — NEVER a
 * `startsWith` prefix (memory [[linkedin-media-trust-helper-862]]: a prefix
 * check is bypassable, e.g. `https://trusted.example.com.attacker.tld`). Only
 * `https:` is accepted for a provider/callback target by default; a LAN/offline
 * deployment never reaches this path (the module is default-disabled).
 *
 * Fail-closed: an unparseable URL, a non-https scheme, or a host that is not an
 * EXACT match for the allow-listed host is rejected.
 */

export type UrlAllowResult =
  { ok: true; host: string } | { ok: false; reason: string };

/**
 * `allowedHost` is a bare hostname (lower-case, no scheme/port/path), stored on
 * the provider account row. The candidate URL passes iff it parses, is `https:`,
 * and its `URL.host`'s HOSTNAME equals `allowedHost` EXACTLY (case-insensitive).
 *
 * `URL.host` includes the port (`example.com:8443`); we compare on `hostname`
 * (no port) for equality so a provider that publishes on a non-default port
 * still matches its allow-listed host — the security property is that the HOST
 * cannot be spoofed by a prefix/suffix trick, which `hostname` equality gives.
 */
export function isUrlHostAllowed(
  rawUrl: string,
  allowedHost: string,
  options: { allowInsecure?: boolean } = {}
): UrlAllowResult {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return { ok: false, reason: "empty_url" };
  }
  if (typeof allowedHost !== "string" || allowedHost.length === 0) {
    return { ok: false, reason: "no_allowlist" };
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  const insecureOk = options.allowInsecure === true;
  if (
    parsed.protocol !== "https:" &&
    !(insecureOk && parsed.protocol === "http:")
  ) {
    return { ok: false, reason: "unsupported_scheme" };
  }
  // Strict host EQUALITY on hostname (never startsWith/endsWith/includes).
  if (parsed.hostname.toLowerCase() !== allowedHost.toLowerCase()) {
    return { ok: false, reason: "host_not_allowlisted" };
  }
  return { ok: true, host: parsed.hostname.toLowerCase() };
}
