import { isIP } from "node:net";

/**
 * SSRF protection for outbound subscription delivery targets (Issue #754
 * acceptance criterion: "SSRF protection rejects private/link-local/
 * metadata/unapproved destinations in the generic HTTP fixture"). Pure,
 * no I/O — `validateOutboundUrlShape` checks the URL's literal syntax/host
 * form; `isBlockedIpAddress` is reused separately by the outbound HTTP
 * client (`infrastructure/outbound-http-client.ts`) to ALSO validate every
 * DNS-resolved address at actual dispatch time (defense in depth against a
 * hostname that resolves to a private address even though it isn't a
 * literal IP in the URL).
 *
 * `allowPrivateTargets` is the "explicit trusted deployment policy" escape
 * hatch the issue's own wording allows — AWCMS-Mini is LAN-first (ADR-0006):
 * a legitimate LAN deployment MAY want to deliver a webhook to another
 * system on the same private network. Default is `false` (blocked); an
 * operator opts in per-deployment via `INTEGRATION_HUB_ALLOW_PRIVATE_
 * TARGETS=true` (doc 18), never per-request/tenant-controlled.
 *
 * An HTTP redirect `Location` header is validated through this exact same
 * function too — see `infrastructure/outbound-http-client.ts`'s
 * `followBoundedRedirects`, which calls `validateOutboundDestination`
 * (which itself calls `validateOutboundUrlShape` below) on every hop
 * before following it. This file has no redirect-awareness of its own;
 * the HTTP client layer is what guarantees every URL ever actually
 * connected to — original or redirected — passes through here first.
 *
 * Known limitation (documented, not silently claimed as solved): this
 * validates the URL's literal host/IP shape and (via
 * `infrastructure/outbound-http-client.ts`) the DNS-resolved address at
 * dispatch time — it does NOT pin the resolved IP for the actual `fetch()`
 * call itself (Bun's `fetch()` re-resolves DNS independently), so a
 * classic TOCTOU DNS-rebinding attack (a public hostname that resolves to
 * a public IP at validation time, then to a private IP milliseconds later
 * at request time) is not fully closed. Closing that residual gap would
 * require a custom low-level socket/connect-with-pinned-IP implementation,
 * out of this issue's scope — the literal-IP and resolved-IP checks here
 * are still real, effective protection against the overwhelmingly common
 * case (a private/link-local/metadata IP literal or a hostname that
 * simply always resolves to one, e.g. `localhost`/`*.internal`).
 */

export type OutboundUrlValidationResult =
  { ok: true; hostname: string } | { ok: false; reason: string };

const BLOCKED_HOSTNAME_LITERALS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.internal",
  "instance-data"
]);

function ipv4ToInt(octets: number[]): number {
  return (
    ((octets[0]! << 24) |
      (octets[1]! << 16) |
      (octets[2]! << 8) |
      octets[3]!) >>>
    0
  );
}

function isPrivateOrReservedIPv4(address: string): boolean {
  const octets = address.split(".").map((part) => Number(part));

  if (
    octets.length !== 4 ||
    octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return true; // Malformed — fail closed.
  }

  const value = ipv4ToInt(octets);

  const inRange = (baseOctets: number[], prefixLength: number): boolean => {
    const base = ipv4ToInt(baseOctets);
    const mask =
      prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
    return (value & mask) === (base & mask);
  };

  return (
    inRange([0, 0, 0, 0], 8) || // "this network"
    inRange([10, 0, 0, 0], 8) || // RFC1918
    inRange([100, 64, 0, 0], 10) || // CGNAT
    inRange([127, 0, 0, 0], 8) || // loopback
    inRange([169, 254, 0, 0], 16) || // link-local incl. cloud metadata 169.254.169.254
    inRange([172, 16, 0, 0], 12) || // RFC1918
    inRange([192, 0, 0, 0], 24) || // IETF protocol assignments
    inRange([192, 0, 2, 0], 24) || // TEST-NET-1
    inRange([192, 88, 99, 0], 24) || // 6to4 relay anycast
    inRange([192, 168, 0, 0], 16) || // RFC1918
    inRange([198, 18, 0, 0], 15) || // benchmarking
    inRange([198, 51, 100, 0], 24) || // TEST-NET-2
    inRange([203, 0, 113, 0], 24) || // TEST-NET-3
    inRange([224, 0, 0, 0], 4) || // multicast
    inRange([240, 0, 0, 0], 4) // reserved incl. 255.255.255.255 broadcast
  );
}

function isPrivateOrReservedIPv6(address: string): boolean {
  const normalized = address.toLowerCase();

  if (normalized === "::1" || normalized === "::") {
    return true; // loopback / unspecified
  }

  // IPv4-mapped, dotted-decimal form (::ffff:a.b.c.d) — validate the
  // embedded IPv4 address.
  const dottedMappedMatch = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dottedMappedMatch) {
    return isPrivateOrReservedIPv4(dottedMappedMatch[1]!);
  }

  // IPv4-mapped, hex-group form (::ffff:xxxx:yyyy) — the WHATWG URL
  // parser normalizes an IPv4-mapped literal typed as
  // `[::ffff:169.254.169.254]` into this hex-group shape, NEVER the
  // dotted-decimal form above, so `new URL(...).hostname` for this class
  // of target never matches `dottedMappedMatch` — a second real gap the
  // security-auditor's own reproduction (`[::ffff:169.254.169.254]`)
  // caught (PR #784). Each hex group is 16 bits = 2 IPv4 octets.
  const hexMappedMatch = normalized.match(
    /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/
  );
  if (hexMappedMatch) {
    const high = Number.parseInt(hexMappedMatch[1]!, 16);
    const low = Number.parseInt(hexMappedMatch[2]!, 16);
    const octets = [
      (high >>> 8) & 0xff,
      high & 0xff,
      (low >>> 8) & 0xff,
      low & 0xff
    ];
    return isPrivateOrReservedIPv4(octets.join("."));
  }

  return (
    normalized.startsWith("fe8") || // link-local fe80::/10 (fe8-feb prefix range, approximated by first hextet check below for correctness)
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("fc") || // unique local fc00::/7 (fc00-fdff)
    normalized.startsWith("fd") ||
    normalized.startsWith("ff") // multicast ff00::/8
  );
}

/**
 * `URL.hostname` (and any `Location` redirect target re-parsed the same
 * way) returns an IPv6 literal WITH its surrounding brackets — e.g.
 * `new URL("http://[::1]/").hostname === "[::1]"`. `node:net`'s `isIP()`
 * returns `0` (not recognized) for a bracketed string, so every call site
 * that gates on `isIP(hostname)` before running the private/loopback/
 * link-local/ULA/mapped-IPv4 classification below MUST strip the
 * brackets first, or that classification logic is unreachable dead code
 * for every IPv6 literal target (security-auditor Critical finding on PR
 * #784 — confirmed empirically: `http://[fc00::1234]:9999/` was accepted
 * at write time despite `fc00::/7` being explicitly blocked below).
 * Applied inside `isBlockedIpAddress` itself (not just at the two call
 * sites) so this is a single point of truth — any future caller is safe
 * by construction, not by remembering to unwrap first.
 */
export function unwrapIpv6Literal(hostname: string): string {
  if (
    hostname.length > 2 &&
    hostname.startsWith("[") &&
    hostname.endsWith("]")
  ) {
    return hostname.slice(1, -1);
  }

  return hostname;
}

export function isBlockedIpAddress(address: string): boolean {
  const unwrapped = unwrapIpv6Literal(address);
  const version = isIP(unwrapped);

  if (version === 4) {
    return isPrivateOrReservedIPv4(unwrapped);
  }

  if (version === 6) {
    return isPrivateOrReservedIPv6(unwrapped);
  }

  return true; // Not a valid IP literal at all — caller should treat as invalid, fail closed.
}

export function validateOutboundUrlShape(
  rawUrl: string,
  options: { allowPrivateTargets: boolean }
): OutboundUrlValidationResult {
  let parsed: URL;

  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "unsupported_protocol" };
  }

  const hostname = parsed.hostname.toLowerCase();

  if (options.allowPrivateTargets) {
    return { ok: true, hostname };
  }

  if (
    BLOCKED_HOSTNAME_LITERALS.has(hostname) ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".local")
  ) {
    return { ok: false, reason: "metadata_or_local_hostname" };
  }

  const ipVersion = isIP(unwrapIpv6Literal(hostname));

  if (ipVersion !== 0 && isBlockedIpAddress(hostname)) {
    return { ok: false, reason: "private_or_reserved_address" };
  }

  return { ok: true, hostname };
}
