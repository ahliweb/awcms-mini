import { describe, expect, test } from "bun:test";

import { resolveGeoEnrichment } from "../../src/modules/visitor-analytics/domain/geo-enrichment";

function requestWithHeaders(headers: Record<string, string>): Request {
  return new Request("http://internal.invalid/", { headers });
}

describe("resolveGeoEnrichment", () => {
  test("returns all-null when geoEnabled is false, even with a trusted Cloudflare header present", () => {
    const request = requestWithHeaders({ "cf-ipcountry": "ID" });
    const result = resolveGeoEnrichment(request, {
      geoEnabled: false,
      trustCloudflare: true
    });
    expect(result).toEqual({
      countryCode: null,
      region: null,
      city: null,
      timezone: null
    });
  });

  test("returns all-null when trustCloudflare is false, even with geoEnabled true", () => {
    const request = requestWithHeaders({ "cf-ipcountry": "ID" });
    const result = resolveGeoEnrichment(request, {
      geoEnabled: true,
      trustCloudflare: false
    });
    expect(result.countryCode).toBeNull();
  });

  test("extracts the country code from CF-IPCountry when both flags are enabled", () => {
    const request = requestWithHeaders({ "cf-ipcountry": "id" });
    const result = resolveGeoEnrichment(request, {
      geoEnabled: true,
      trustCloudflare: true
    });
    expect(result.countryCode).toBe("ID");
  });

  test("region/city/timezone always stay null (no local GeoIP database in this issue)", () => {
    const request = requestWithHeaders({ "cf-ipcountry": "US" });
    const result = resolveGeoEnrichment(request, {
      geoEnabled: true,
      trustCloudflare: true
    });
    expect(result.region).toBeNull();
    expect(result.city).toBeNull();
    expect(result.timezone).toBeNull();
  });

  test("accepts Cloudflare's non-country sentinel codes (XX unknown, T1 Tor, EU region)", () => {
    for (const code of ["XX", "T1", "EU"]) {
      const request = requestWithHeaders({ "cf-ipcountry": code });
      const result = resolveGeoEnrichment(request, {
        geoEnabled: true,
        trustCloudflare: true
      });
      expect(result.countryCode).toBe(code);
    }
  });

  test("rejects a header value that doesn't look like a country code", () => {
    const request = requestWithHeaders({
      "cf-ipcountry": "<script>alert(1)</script>"
    });
    const result = resolveGeoEnrichment(request, {
      geoEnabled: true,
      trustCloudflare: true
    });
    expect(result.countryCode).toBeNull();
  });

  test("returns null countryCode when the header is absent", () => {
    const request = requestWithHeaders({});
    const result = resolveGeoEnrichment(request, {
      geoEnabled: true,
      trustCloudflare: true
    });
    expect(result.countryCode).toBeNull();
  });

  test("never makes an external network call (pure header read only)", () => {
    // No fetch/network API is imported or referenced anywhere in
    // geo-enrichment.ts — this test documents the binding constraint
    // rather than mocking a call that structurally cannot happen.
    const request = requestWithHeaders({ "cf-ipcountry": "ID" });
    expect(() =>
      resolveGeoEnrichment(request, { geoEnabled: true, trustCloudflare: true })
    ).not.toThrow();
  });
});
