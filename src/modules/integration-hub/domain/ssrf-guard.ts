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

/**
 * Expands a syntactically-valid IPv6 literal (already confirmed by
 * `isIP() === 6` before this is ever called, by every caller in this
 * file) into its 16 raw bytes. Handles `::` zero-compression and a
 * trailing dotted-decimal IPv4 form (e.g. `::ffff:127.0.0.1`, which this
 * file's own pre-existing test suite already exercises directly) by
 * rewriting it into two equivalent 16-bit hex groups first, so the rest
 * of the function only ever deals with plain hex groups. Returns `null`
 * only if the input somehow isn't parseable despite passing `isIP()`
 * (defensive; should not happen in practice) — callers fail closed on
 * `null` the same way they already fail closed on "not a valid IP at
 * all" elsewhere in this file.
 */
function parseIPv6ToBytes(address: string): number[] | null {
  let text = address;
  const lastColonIndex = text.lastIndexOf(":");
  const tail = text.slice(lastColonIndex + 1);

  if (tail.includes(".")) {
    const octets = tail.split(".").map((part) => Number(part));

    if (
      octets.length !== 4 ||
      octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
    ) {
      return null;
    }

    const high = ((octets[0]! << 8) | octets[1]!).toString(16);
    const low = ((octets[2]! << 8) | octets[3]!).toString(16);
    text = `${text.slice(0, lastColonIndex + 1)}${high}:${low}`;
  }

  if ((text.match(/::/g) ?? []).length > 1) {
    return null;
  }

  const doubleColonIndex = text.indexOf("::");
  const hasDoubleColon = doubleColonIndex !== -1;
  const headPart = hasDoubleColon ? text.slice(0, doubleColonIndex) : text;
  const tailPart = hasDoubleColon ? text.slice(doubleColonIndex + 2) : "";

  const headGroups = headPart.length > 0 ? headPart.split(":") : [];
  const tailGroups = tailPart.length > 0 ? tailPart.split(":") : [];

  if (!hasDoubleColon && headGroups.length !== 8) {
    return null;
  }

  if (hasDoubleColon && headGroups.length + tailGroups.length > 8) {
    return null;
  }

  const missingGroups = 8 - headGroups.length - tailGroups.length;
  const groups = hasDoubleColon
    ? [...headGroups, ...new Array(missingGroups).fill("0"), ...tailGroups]
    : headGroups;

  if (groups.length !== 8) {
    return null;
  }

  const bytes: number[] = [];

  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) {
      return null;
    }

    const value = Number.parseInt(group, 16);
    bytes.push((value >>> 8) & 0xff, value & 0xff);
  }

  return bytes;
}

function isZeroRange(bytes: number[], from: number, to: number): boolean {
  for (let i = from; i < to; i += 1) {
    if (bytes[i] !== 0) {
      return false;
    }
  }

  return true;
}

/**
 * The actual bug CLASS (security-auditor round-3 Critical finding, PR
 * #784): "an IPv6 address with an embedded IPv4 payload in a known
 * translation prefix" — not a growing list of one-off regexes, one per
 * encoding discovered. Every known embedded-IPv4 form is enumerated here
 * explicitly, each one extracting the 32-bit IPv4 payload from its
 * RFC-defined bit position and re-running the EXISTING, already-reviewed
 * `isPrivateOrReservedIPv4` check against it — never a second,
 * reimplemented IPv4 classification.
 */
function isBlockedEmbeddedIPv4(bytes: number[]): boolean {
  // IPv4-mapped, RFC 4291 §2.5.5.2 (`::ffff:a.b.c.d`):
  // 0000:0000:0000:0000:0000:ffff:v4(32).
  if (isZeroRange(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPrivateOrReservedIPv4(bytes.slice(12, 16).join("."));
  }

  // IPv4-translated (`::ffff:0:a.b.c.d`) — the same `ffff` marker one
  // group earlier, with an extra reserved zero group before the IPv4
  // payload. Security-auditor round-3 finding: this bypassed the guard
  // entirely because it is a DIFFERENT bit pattern from the mapped form
  // above (the WHATWG URL parser normalizes it to `::ffff:0:xxxx:yyyy`),
  // not merely a textual variant of it.
  if (
    isZeroRange(bytes, 0, 8) &&
    bytes[8] === 0xff &&
    bytes[9] === 0xff &&
    bytes[10] === 0 &&
    bytes[11] === 0
  ) {
    return isPrivateOrReservedIPv4(bytes.slice(12, 16).join("."));
  }

  // IPv4-compatible, RFC 4291 §2.5.5.1 (deprecated, no `ffff` marker)
  // (`::a.b.c.d`): 0000:0000:0000:0000:0000:0000:v4(32). Round-4
  // security-auditor Medium finding (non-blocking, not currently
  // reachable via this codebase's actual `fetch()`/DNS path — Bun/Linux
  // won't route this deprecated form — but added so this function's own
  // "every known embedded-IPv4 form" claim is literally true). Safe to
  // run AFTER the mapped/translated checks above without an explicit
  // exclusion: both of those require a specific non-zero `0xff` marker
  // byte within `bytes[8..12]`, so a genuinely all-zero `bytes[0..12]`
  // can never match either of them — mutually exclusive by construction.
  // `isPrivateOrReservedIPv6`'s own loopback (`::1`) and unspecified
  // (`::`) checks already run BEFORE this function is ever called, so
  // this never double-classifies those two special cases either.
  if (isZeroRange(bytes, 0, 12)) {
    return isPrivateOrReservedIPv4(bytes.slice(12, 16).join("."));
  }

  // NAT64 Well-Known Prefix, RFC 6052 §2.1/§2.2 (`64:ff9b::/96`):
  // 0064:ff9b:0000:0000:0000:0000:v4(32) — the /96 length embeds the
  // whole IPv4 address in the last 32 bits (no reserved "u" byte; that
  // byte's position, bits 64-71, falls INSIDE the 96-bit prefix here).
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    isZeroRange(bytes, 4, 12)
  ) {
    return isPrivateOrReservedIPv4(bytes.slice(12, 16).join("."));
  }

  // NAT64 Local-Use Prefix, RFC 8215 (`64:ff9b:1::/48`), embedded per RFC
  // 6052 §2.2's PL=48 rule: 48-bit prefix, then IPv4 octets 0-1, then a
  // reserved "u" byte (bits 64-71), then IPv4 octets 2-3, then suffix.
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes[4] === 0x00 &&
    bytes[5] === 0x01
  ) {
    return isPrivateOrReservedIPv4(
      [bytes[6]!, bytes[7]!, bytes[9]!, bytes[10]!].join(".")
    );
  }

  // 6to4, RFC 3056 (`2002:WWXX:YYZZ::/16`): the 32-bit IPv4 address is
  // encoded directly as the next two groups after the `2002::` prefix.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return isPrivateOrReservedIPv4(bytes.slice(2, 6).join("."));
  }

  return false;
}

function isPrivateOrReservedIPv6(address: string): boolean {
  const normalized = address.toLowerCase();

  const bytes = parseIPv6ToBytes(normalized);

  if (!bytes) {
    return true; // Fail closed — should not happen after isIP() already validated syntax.
  }

  // Byte-based, not a string special-case (round-4 security-auditor Low
  // finding, non-blocking) — a non-canonical fully-expanded literal (e.g.
  // `0:0:0:0:0:0:0:1`) is not reachable via either real call site today
  // (both `URL.hostname` and a DNS-resolved address always canonicalize
  // first), but this keeps `isBlockedIpAddress` safe by construction for
  // any future direct caller too, consistent with how the rest of this
  // function already works off `bytes`, not strings.
  if (isZeroRange(bytes, 0, 15) && bytes[15] === 1) {
    return true; // loopback ::1
  }

  if (isZeroRange(bytes, 0, 16)) {
    return true; // unspecified ::
  }

  if (isBlockedEmbeddedIPv4(bytes)) {
    return true;
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
