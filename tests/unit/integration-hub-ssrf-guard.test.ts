/**
 * Issue #754 (integration_hub) — SSRF guard unit tests. Acceptance
 * criterion: "SSRF protection rejects private/link-local/metadata/
 * unapproved destinations in the generic HTTP fixture."
 */
import { describe, expect, test } from "bun:test";
import {
  isBlockedIpAddress,
  validateOutboundUrlShape
} from "../../src/modules/integration-hub/domain/ssrf-guard";

describe("isBlockedIpAddress", () => {
  test.each([
    ["10.0.0.5", true],
    ["172.16.0.1", true],
    ["192.168.1.1", true],
    ["127.0.0.1", true],
    ["169.254.169.254", true], // cloud metadata endpoint
    ["0.0.0.0", true],
    ["100.64.0.1", true], // CGNAT
    ["192.0.2.1", true], // TEST-NET-1
    ["255.255.255.255", true],
    ["8.8.8.8", false],
    ["1.1.1.1", false],
    ["93.184.216.34", false]
  ])("IPv4 %s -> blocked=%s", (address, expected) => {
    expect(isBlockedIpAddress(address)).toBe(expected);
  });

  test.each([
    ["::1", true],
    ["fe80::1", true],
    ["fc00::1", true],
    ["fd12:3456:789a::1", true],
    ["ff02::1", true],
    ["::ffff:127.0.0.1", true],
    ["2001:4860:4860::8888", false] // Google public DNS
  ])("IPv6 %s -> blocked=%s", (address, expected) => {
    expect(isBlockedIpAddress(address)).toBe(expected);
  });

  test("a malformed/non-IP string is treated as blocked (fail closed)", () => {
    expect(isBlockedIpAddress("not-an-ip")).toBe(true);
  });

  // Security-auditor Critical finding (PR #784): isBlockedIpAddress itself
  // strips a bracketed IPv6 literal's brackets before classifying, so it
  // is safe by construction for any caller — this is the single point of
  // truth every write-time/dispatch-time/redirect-hop call site relies on.
  test.each([
    ["[::1]", true],
    ["[fe80::1]", true],
    ["[fc00::1234]", true],
    ["[::ffff:169.254.169.254]", true], // dotted-decimal mapped form, bracketed
    ["[::ffff:a9fe:a9fe]", true], // hex-group mapped form (what URL.hostname actually produces), bracketed
    ["[2001:4860:4860::8888]", false] // public, bracketed
  ])("bracketed IPv6 %s -> blocked=%s", (address, expected) => {
    expect(isBlockedIpAddress(address)).toBe(expected);
  });

  test.each([
    ["::ffff:a9fe:a9fe", true], // hex-group mapped cloud metadata, unbracketed
    ["::ffff:808:808", false] // hex-group mapped 8.8.8.8, unbracketed
  ])("IPv6 hex-group IPv4-mapped %s -> blocked=%s", (address, expected) => {
    expect(isBlockedIpAddress(address)).toBe(expected);
  });
});

describe("validateOutboundUrlShape", () => {
  test("rejects a private IP literal by default", () => {
    const result = validateOutboundUrlShape("http://10.0.0.5/webhook", {
      allowPrivateTargets: false
    });
    expect(result.ok).toBe(false);
  });

  test("rejects the cloud metadata IP literal by default", () => {
    const result = validateOutboundUrlShape(
      "http://169.254.169.254/latest/meta-data",
      {
        allowPrivateTargets: false
      }
    );
    expect(result.ok).toBe(false);
  });

  test("rejects localhost by default", () => {
    const result = validateOutboundUrlShape("http://localhost:3000/hook", {
      allowPrivateTargets: false
    });
    expect(result.ok).toBe(false);
  });

  test("rejects a .internal hostname by default", () => {
    const result = validateOutboundUrlShape("https://metadata.internal/token", {
      allowPrivateTargets: false
    });
    expect(result.ok).toBe(false);
  });

  test("accepts a public https URL by default", () => {
    const result = validateOutboundUrlShape("https://example.com/webhook", {
      allowPrivateTargets: false
    });
    expect(result.ok).toBe(true);
  });

  test("rejects a non-http(s) protocol", () => {
    const result = validateOutboundUrlShape("ftp://example.com/webhook", {
      allowPrivateTargets: false
    });
    expect(result.ok).toBe(false);
  });

  test("rejects a malformed URL", () => {
    const result = validateOutboundUrlShape("not a url", {
      allowPrivateTargets: false
    });
    expect(result.ok).toBe(false);
  });

  test("allowPrivateTargets=true bypasses the private-IP check (explicit trusted-deployment opt-in)", () => {
    const result = validateOutboundUrlShape("http://10.0.0.5/webhook", {
      allowPrivateTargets: true
    });
    expect(result.ok).toBe(true);
  });

  // Security-auditor Critical finding (PR #784): `URL.hostname` returns an
  // IPv6 literal WITH its surrounding brackets (`[::1]`, not `::1`) —
  // `isIP()` returns 0 for a bracketed string, so a naive
  // `isIP(hostname) !== 0` gate never even calls the private/loopback/
  // link-local/ULA classification for ANY IPv6 literal target. These
  // exercise the REAL caller (`validateOutboundUrlShape`), not
  // `isBlockedIpAddress` directly — that alone was already covered but
  // never proven reachable through its actual entry point.
  test.each([
    ["http://[::1]/", "loopback"],
    ["http://[fc00::1234]:9999/internal", "unique-local (ULA, fc00::/7)"],
    ["http://[fe80::1]/", "link-local (fe80::/10)"],
    [
      "http://[::ffff:169.254.169.254]/",
      "IPv4-mapped cloud metadata address (WHATWG URL normalizes this to the hex-group form ::ffff:a9fe:a9fe, never the dotted-decimal form)"
    ]
  ])("rejects the bracketed IPv6 literal %s (%s)", (url) => {
    const result = validateOutboundUrlShape(url, {
      allowPrivateTargets: false
    });
    expect(result.ok).toBe(false);
  });

  test("accepts a public bracketed IPv6 literal (Google public DNS)", () => {
    const result = validateOutboundUrlShape("http://[2001:4860:4860::8888]/", {
      allowPrivateTargets: false
    });
    expect(result.ok).toBe(true);
  });
});
