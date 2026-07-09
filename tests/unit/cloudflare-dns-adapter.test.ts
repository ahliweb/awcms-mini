import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resetProviderCircuitBreakersForTests } from "../../src/lib/database/circuit-breaker";
import {
  createCloudflareDnsProvider,
  resolveTenantDomainDnsProvider,
  validateDnsRecordInput
} from "../../src/modules/tenant-domain/infrastructure/cloudflare-dns-adapter";
import {
  DEFAULT_TENANT_DOMAIN_CLOUDFLARE_TIMEOUT_MS,
  resolveTenantDomainCloudflareTimeoutMs
} from "../../src/modules/tenant-domain/domain/tenant-domain-dns-config";

const ROOT_DOMAIN = "platform.example";

describe("validateDnsRecordInput", () => {
  test("accepts a TXT record at the platform root domain itself", () => {
    expect(
      validateDnsRecordInput(
        {
          recordType: "TXT",
          recordName: "platform.example",
          recordValue: "awcms-verify=abc123"
        },
        ROOT_DOMAIN
      )
    ).toBeNull();
  });

  test("accepts a TXT record on a subdomain of the platform root domain", () => {
    expect(
      validateDnsRecordInput(
        {
          recordType: "TXT",
          recordName: "_awcms-verify.tenant1.platform.example",
          recordValue: "awcms-verify=abc123"
        },
        ROOT_DOMAIN
      )
    ).toBeNull();
  });

  test("accepts a CNAME record whose value is a valid hostname", () => {
    expect(
      validateDnsRecordInput(
        {
          recordType: "CNAME",
          recordName: "tenant1.platform.example",
          recordValue: "edge.awcms-mini.example"
        },
        ROOT_DOMAIN
      )
    ).toBeNull();
  });

  test("rejects an unknown recordType", () => {
    expect(
      validateDnsRecordInput(
        {
          recordType: "A",
          recordName: "tenant1.platform.example",
          recordValue: "1.2.3.4"
        },
        ROOT_DOMAIN
      )
    ).toMatch(/recordType/);
  });

  test("rejects a recordName outside the platform root domain", () => {
    expect(
      validateDnsRecordInput(
        {
          recordType: "TXT",
          recordName: "evil.other-domain.example",
          recordValue: "awcms-verify=abc123"
        },
        ROOT_DOMAIN
      )
    ).toMatch(/platform root domain/i);
  });

  test("rejects a recordName that only shares a suffix, not a subdomain relationship", () => {
    // "notplatform.example" ends with "platform.example" as a raw string
    // suffix but is NOT a subdomain of it — must be rejected.
    expect(
      validateDnsRecordInput(
        {
          recordType: "TXT",
          recordName: "notplatform.example",
          recordValue: "awcms-verify=abc123"
        },
        ROOT_DOMAIN
      )
    ).toMatch(/platform root domain/i);
  });

  test("rejects a TXT value containing a newline (injection defense)", () => {
    expect(
      validateDnsRecordInput(
        {
          recordType: "TXT",
          recordName: "tenant1.platform.example",
          recordValue: "abc\ninjected"
        },
        ROOT_DOMAIN
      )
    ).toMatch(/recordValue/);
  });

  test("rejects a TXT value longer than the Cloudflare content limit", () => {
    expect(
      validateDnsRecordInput(
        {
          recordType: "TXT",
          recordName: "tenant1.platform.example",
          recordValue: "a".repeat(2049)
        },
        ROOT_DOMAIN
      )
    ).toMatch(/recordValue/);
  });

  test("rejects a CNAME value that is not a plausible hostname", () => {
    expect(
      validateDnsRecordInput(
        {
          recordType: "CNAME",
          recordName: "tenant1.platform.example",
          recordValue: "not a hostname"
        },
        ROOT_DOMAIN
      )
    ).toMatch(/recordValue/);
  });

  test("rejects an empty recordValue", () => {
    expect(
      validateDnsRecordInput(
        {
          recordType: "TXT",
          recordName: "tenant1.platform.example",
          recordValue: ""
        },
        ROOT_DOMAIN
      )
    ).toMatch(/recordValue/);
  });
});

type ServerBehavior =
  | "empty-list-then-create-ok"
  | "existing-match"
  | "create-provider-error"
  | "list-provider-error"
  | "slow";

describe("createCloudflareDnsProvider", () => {
  let requestCount = 0;
  let requests: { method: string; pathname: string; body?: string }[] = [];
  let behavior: ServerBehavior = "empty-list-then-create-ok";
  let server: ReturnType<typeof Bun.serve>;

  beforeEach(() => {
    resetProviderCircuitBreakersForTests();
    requestCount = 0;
    requests = [];
    behavior = "empty-list-then-create-ok";

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestCount += 1;
        const url = new URL(request.url);
        const bodyText = await request.text().catch(() => "");
        requests.push({
          method: request.method,
          pathname: url.pathname,
          body: bodyText || undefined
        });

        if (behavior === "slow") {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return Response.json({ success: true, errors: [], result: [] });
        }

        if (request.method === "GET") {
          if (behavior === "existing-match") {
            return Response.json({
              success: true,
              errors: [],
              result: [
                {
                  id: "existing-record-id",
                  type: url.searchParams.get("type"),
                  name: url.searchParams.get("name"),
                  content: "awcms-verify=abc123"
                }
              ]
            });
          }

          if (behavior === "list-provider-error") {
            return Response.json(
              {
                success: false,
                errors: [
                  {
                    code: 9109,
                    message: "Invalid access token: super-secret-token-value"
                  }
                ]
              },
              { status: 400 }
            );
          }

          return Response.json({ success: true, errors: [], result: [] });
        }

        // POST /dns_records
        if (behavior === "create-provider-error") {
          return Response.json(
            {
              success: false,
              errors: [
                {
                  code: 1004,
                  message:
                    "DNS Validation Error (zone super-secret-zone-value not eligible)."
                }
              ]
            },
            { status: 400 }
          );
        }

        return Response.json({
          success: true,
          errors: [],
          result: { id: "new-record-id" }
        });
      }
    });
  });

  afterEach(() => {
    server.stop(true);
    resetProviderCircuitBreakersForTests();
  });

  function makeProvider(timeoutMs = 5000) {
    return createCloudflareDnsProvider({
      zoneId: "super-secret-zone-value",
      apiToken: "super-secret-token-value",
      platformRootDomain: ROOT_DOMAIN,
      baseUrl: `http://127.0.0.1:${server.port}`,
      timeoutMs
    });
  }

  test("creates a new verification record via a real GET-then-POST round trip", async () => {
    const provider = makeProvider();
    const result = await provider.createVerificationRecord({
      recordType: "TXT",
      recordName: "tenant1.platform.example",
      recordValue: "awcms-verify=abc123"
    });

    expect(result).toEqual({
      ok: true,
      providerRecordId: "new-record-id",
      alreadyExists: false
    });
    expect(requestCount).toBe(2);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[1]?.method).toBe("POST");
  });

  test("is idempotent: returns alreadyExists without a second write when a matching record exists", async () => {
    behavior = "existing-match";
    const provider = makeProvider();
    const result = await provider.createVerificationRecord({
      recordType: "TXT",
      recordName: "tenant1.platform.example",
      recordValue: "awcms-verify=abc123"
    });

    expect(result).toEqual({
      ok: true,
      providerRecordId: "existing-record-id",
      alreadyExists: true
    });
    // Only the GET lookup ran — no POST was issued for an already-present record.
    expect(requestCount).toBe(1);
    expect(requests[0]?.method).toBe("GET");
  });

  test("rejects invalid input without ever calling the network", async () => {
    const provider = makeProvider();
    const result = await provider.createVerificationRecord({
      recordType: "TXT",
      recordName: "evil.other-domain.example",
      recordValue: "awcms-verify=abc123"
    });

    expect(result.ok).toBe(false);
    expect((result as { retryable: boolean }).retryable).toBe(false);
    expect(requestCount).toBe(0);
  });

  test("surfaces a provider error without leaking the token or zone id", async () => {
    behavior = "create-provider-error";
    const provider = makeProvider();
    const result = await provider.createVerificationRecord({
      recordType: "TXT",
      recordName: "tenant1.platform.example",
      recordValue: "awcms-verify=abc123"
    });

    expect(result.ok).toBe(false);
    const error = (result as { error: string }).error;
    expect(error).not.toContain("super-secret-token-value");
    expect(error).not.toContain("super-secret-zone-value");
    // Only the numeric Cloudflare error code is surfaced, never `.message`.
    expect(error).toContain("1004");
    expect(error).not.toContain("DNS Validation Error");
  });

  test("checkVerificationStatus surfaces a provider error without leaking the token", async () => {
    behavior = "list-provider-error";
    const provider = makeProvider();
    const result = await provider.checkVerificationStatus({
      recordType: "TXT",
      recordName: "tenant1.platform.example",
      expectedValue: "awcms-verify=abc123"
    });

    expect(result.ok).toBe(false);
    const error = (result as { error: string }).error;
    expect(error).not.toContain("super-secret-token-value");
    expect(error).not.toContain("super-secret-zone-value");
  });

  test("times out a wedged provider instead of hanging forever, without leaking secrets", async () => {
    behavior = "slow";
    const provider = makeProvider(20);
    const result = await provider.createVerificationRecord({
      recordType: "TXT",
      recordName: "tenant1.platform.example",
      recordValue: "awcms-verify=abc123"
    });

    expect(result.ok).toBe(false);
    const error = (result as { error: string }).error;
    expect(error).toMatch(/timed out/i);
    expect(error).not.toContain("super-secret-token-value");
    expect(error).not.toContain("super-secret-zone-value");
  });

  test("checkVerificationStatus reports verified=true when a matching record exists", async () => {
    behavior = "existing-match";
    const provider = makeProvider();
    const result = await provider.checkVerificationStatus({
      recordType: "TXT",
      recordName: "tenant1.platform.example",
      expectedValue: "awcms-verify=abc123"
    });

    expect(result).toEqual({ ok: true, verified: true });
  });

  test("checkVerificationStatus reports verified=false when no record matches", async () => {
    const provider = makeProvider();
    const result = await provider.checkVerificationStatus({
      recordType: "TXT",
      recordName: "tenant1.platform.example",
      expectedValue: "awcms-verify=does-not-match"
    });

    expect(result).toEqual({ ok: true, verified: false });
  });

  test("checkVerificationStatus normalizes CNAME comparison (trailing dot, case)", async () => {
    // A fresh server/provider pair whose GET response echoes a CNAME value
    // with different case and a trailing dot, to prove comparison
    // normalizes both before matching.
    server.stop(true);
    server = Bun.serve({
      port: 0,
      fetch(request) {
        if (request.method === "GET") {
          return Response.json({
            success: true,
            errors: [],
            result: [
              {
                id: "r1",
                type: "CNAME",
                name: "tenant1.platform.example",
                content: "Edge.AWCMS-Mini.Example."
              }
            ]
          });
        }
        return Response.json({ success: true, errors: [], result: {} });
      }
    });

    const cnameProvider = createCloudflareDnsProvider({
      zoneId: "super-secret-zone-value",
      apiToken: "super-secret-token-value",
      platformRootDomain: ROOT_DOMAIN,
      baseUrl: `http://127.0.0.1:${server.port}`
    });

    const result = await cnameProvider.checkVerificationStatus({
      recordType: "CNAME",
      recordName: "tenant1.platform.example",
      expectedValue: "edge.awcms-mini.example"
    });

    expect(result).toEqual({ ok: true, verified: true });
  });

  test("opens the circuit breaker after consecutive failures and short-circuits without calling the network", async () => {
    behavior = "create-provider-error";
    const provider = makeProvider();

    for (let i = 0; i < 5; i += 1) {
      const result = await provider.createVerificationRecord({
        recordType: "TXT",
        recordName: "tenant1.platform.example",
        recordValue: `awcms-verify=attempt-${i}`
      });
      expect(result.ok).toBe(false);
    }

    const countBeforeSixth = requestCount;

    const sixth = await provider.createVerificationRecord({
      recordType: "TXT",
      recordName: "tenant1.platform.example",
      recordValue: "awcms-verify=attempt-6"
    });

    expect(sixth.ok).toBe(false);
    expect((sixth as { error: string }).error).toMatch(/circuit breaker/i);
    expect(requestCount).toBe(countBeforeSixth);
  });
});

describe("resolveTenantDomainDnsProvider (missing env behavior)", () => {
  afterEach(() => {
    resetProviderCircuitBreakersForTests();
  });

  test("defaults to a safe manual-mode stub when TENANT_DOMAIN_DNS_PROVIDER is unset", async () => {
    const provider = resolveTenantDomainDnsProvider({} as NodeJS.ProcessEnv);
    const result = await provider.createVerificationRecord({
      recordType: "TXT",
      recordName: "tenant1.platform.example",
      recordValue: "awcms-verify=abc123"
    });

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/manual/i);
  });

  test("returns a safe stub for an unknown provider value", async () => {
    const provider = resolveTenantDomainDnsProvider({
      TENANT_DOMAIN_DNS_PROVIDER: "route53"
    } as NodeJS.ProcessEnv);
    const result = await provider.checkVerificationStatus({
      recordType: "TXT",
      recordName: "tenant1.platform.example",
      expectedValue: "awcms-verify=abc123"
    });

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(
      /not a known provider/i
    );
  });

  test("returns a safe stub when cloudflare is selected but required vars are missing", async () => {
    const provider = resolveTenantDomainDnsProvider({
      TENANT_DOMAIN_DNS_PROVIDER: "cloudflare"
    } as NodeJS.ProcessEnv);
    const result = await provider.createVerificationRecord({
      recordType: "TXT",
      recordName: "tenant1.platform.example",
      recordValue: "awcms-verify=abc123"
    });

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(
      /TENANT_DOMAIN_PLATFORM_ROOT_DOMAIN/
    );
  });

  test("reaches real validation logic (not the misconfigured stub) once cloudflare is fully configured", async () => {
    const provider = resolveTenantDomainDnsProvider({
      TENANT_DOMAIN_DNS_PROVIDER: "cloudflare",
      TENANT_DOMAIN_CLOUDFLARE_ZONE_ID: "zone-abc",
      TENANT_DOMAIN_CLOUDFLARE_API_TOKEN: "token-xyz",
      TENANT_DOMAIN_PLATFORM_ROOT_DOMAIN: "platform.example"
    } as NodeJS.ProcessEnv);

    // No fake server involved — this input fails the pure validation step
    // before any network call would be attempted, proving the resolver
    // wired up the real adapter rather than the "not configured" stub
    // (whose error text never mentions "platform root domain").
    const result = await provider.createVerificationRecord({
      recordType: "TXT",
      recordName: "evil.other-domain.example",
      recordValue: "awcms-verify=abc123"
    });

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(
      /platform root domain/i
    );
  });
});

describe("resolveTenantDomainCloudflareTimeoutMs (security audit follow-up on PR #580 — timeout is now env-tunable, not hardcoded)", () => {
  test("defaults to DEFAULT_TENANT_DOMAIN_CLOUDFLARE_TIMEOUT_MS when unset", () => {
    expect(
      resolveTenantDomainCloudflareTimeoutMs({} as NodeJS.ProcessEnv)
    ).toBe(DEFAULT_TENANT_DOMAIN_CLOUDFLARE_TIMEOUT_MS);
  });

  test("uses a valid positive numeric override", () => {
    expect(
      resolveTenantDomainCloudflareTimeoutMs({
        TENANT_DOMAIN_CLOUDFLARE_TIMEOUT_MS: "3000"
      } as NodeJS.ProcessEnv)
    ).toBe(3000);
  });

  test("falls back to the default for a non-numeric value", () => {
    expect(
      resolveTenantDomainCloudflareTimeoutMs({
        TENANT_DOMAIN_CLOUDFLARE_TIMEOUT_MS: "not-a-number"
      } as NodeJS.ProcessEnv)
    ).toBe(DEFAULT_TENANT_DOMAIN_CLOUDFLARE_TIMEOUT_MS);
  });

  test("falls back to the default for zero or a negative value", () => {
    expect(
      resolveTenantDomainCloudflareTimeoutMs({
        TENANT_DOMAIN_CLOUDFLARE_TIMEOUT_MS: "0"
      } as NodeJS.ProcessEnv)
    ).toBe(DEFAULT_TENANT_DOMAIN_CLOUDFLARE_TIMEOUT_MS);
    expect(
      resolveTenantDomainCloudflareTimeoutMs({
        TENANT_DOMAIN_CLOUDFLARE_TIMEOUT_MS: "-500"
      } as NodeJS.ProcessEnv)
    ).toBe(DEFAULT_TENANT_DOMAIN_CLOUDFLARE_TIMEOUT_MS);
  });

  test("createCloudflareDnsProvider (already tested above for a raw timeoutMs number) enforces a resolved env-sourced value the same way — proves the two functions compose correctly", async () => {
    using server = Bun.serve({
      port: 0,
      async fetch() {
        await Bun.sleep(500);
        return new Response("{}", { status: 200 });
      }
    });

    const provider = createCloudflareDnsProvider({
      zoneId: "zone-abc",
      apiToken: "token-xyz",
      platformRootDomain: "platform.example",
      baseUrl: `http://127.0.0.1:${server.port}`,
      timeoutMs: resolveTenantDomainCloudflareTimeoutMs({
        TENANT_DOMAIN_CLOUDFLARE_TIMEOUT_MS: "20"
      } as NodeJS.ProcessEnv)
    });
    const result = await provider.createVerificationRecord({
      recordType: "TXT",
      recordName: "tenant1.platform.example",
      recordValue: "awcms-verify=abc123"
    });

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/timed out/i);
  });
});
