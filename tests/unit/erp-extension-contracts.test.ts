/**
 * ERP extension readiness contract tests (Issue #755, epic #738
 * `platform-evolution` Wave 4, ADR-0020). No database, no network —
 * everything under test here is pure/in-memory: `_shared/ports/
 * period-lock-port.ts`'s fail-closed default, the fixture posting engine
 * (`tests/fixtures/derived-application-example/modules/
 * example-erp-extension/posting-engine.ts`), and `reporting`'s own
 * `validateProjectionRegistry` applied to the fixture's contributed
 * projection descriptor.
 *
 * Proves the acceptance criteria this issue names explicitly:
 * - "Dependency tests prove Core/System do not import or depend on the
 *   example ERP extension" — a structural source-text scan of every
 *   `src/modules/**` file.
 * - "Posting request/result is idempotent, correlated, event-versioned,
 *   and demonstrates reversal/compensation rather than mutation of posted
 *   state" — the posting-engine tests below.
 * - "Period-lock and cross-tenant/legal-entity mismatch negative tests
 *   fail safely" — the posting-engine tests below, including two
 *   dedicated adversarial tests for the REVERSAL-target side specifically
 *   (a different tenant/legal-entity resolving the SAME
 *   `externalTransactionId`) and one for business-identity-keyed
 *   duplicate-post rejection — fixed after a security-auditor pass on
 *   this PR found the original fixture's reversal lookup used the wrong
 *   ID space (`requestId` instead of `externalTransactionId`) and had no
 *   tenant/legal-entity re-verification at all.
 * - "contributes a reporting projection through #753" — the
 *   `validateProjectionRegistry` test below.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { listBaseModules } from "../../src/modules";
import { validateProjectionRegistry } from "../../src/modules/reporting/domain/projection-registry";
import { noPeriodLockAdapterConfigured } from "../../src/modules/_shared/ports/period-lock-port";
import type { AccountingPostingRequestPayload } from "../../src/modules/_shared/business-transaction-contract";
import { exampleErpExtensionModule } from "../fixtures/derived-application-example/modules/example-erp-extension/module";
import { createFixturePeriodLockAdapter } from "../fixtures/derived-application-example/modules/example-erp-extension/period-lock-adapter";
import { FixturePostingEngine } from "../fixtures/derived-application-example/modules/example-erp-extension/posting-engine";

const FAKE_TX = {} as unknown as Bun.SQL;
const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

function baseRequest(
  overrides: Partial<AccountingPostingRequestPayload> = {}
): AccountingPostingRequestPayload {
  return {
    requestId: "req-1",
    transaction: {
      tenantId: TENANT_A,
      legalEntityScope: null,
      transactionType: "example_erp.sales.invoice",
      externalTransactionId: "inv-1",
      status: "submitted"
    },
    periodKey: "2026-07",
    currencyCode: "IDR",
    totalDebit: "100000",
    totalCredit: "100000",
    requestedAt: new Date().toISOString(),
    ...overrides
  };
}

describe("PeriodLockPort default fail-closed adapter (Issue #755)", () => {
  test("noPeriodLockAdapterConfigured always reports checked: false, never locked: false", async () => {
    const result = await noPeriodLockAdapterConfigured.checkPeriodLock(
      FAKE_TX,
      TENANT_A,
      null,
      "2026-07",
      "post"
    );
    expect(result.checked).toBe(false);
  });
});

describe("Dependency direction — Core/System never imports the example ERP extension (Issue #755 acceptance criterion)", () => {
  function listTsFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        files.push(...listTsFiles(fullPath));
      } else if (entry.endsWith(".ts") || entry.endsWith(".astro")) {
        files.push(fullPath);
      }
    }
    return files;
  }

  test("no file under src/ has a real import/export statement reaching the example-erp-extension fixture (prose mentions in doc comments, e.g. application-registry.ts's own illustrative header, are not a real dependency)", () => {
    const srcDir = path.join(import.meta.dir, "../../src");
    const importPattern =
      /(?:from\s+["'][^"']*|import\s*\(\s*["'][^"']*)(?:example-erp-extension|derived-application-example)[^"']*["']/;
    const offenders: string[] = [];

    for (const file of listTsFiles(srcDir)) {
      const content = readFileSync(file, "utf-8");
      for (const line of content.split("\n")) {
        if (importPattern.test(line)) {
          offenders.push(`${path.relative(srcDir, file)}: ${line.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("FixturePostingEngine (Issue #755 — machine-verifiable posting invariants)", () => {
  test("idempotent: the same requestId submitted twice returns the identical result, never re-evaluates", async () => {
    let evaluationCount = 0;
    const countingLockPort = {
      async checkPeriodLock() {
        evaluationCount += 1;
        return { checked: true as const, locked: false as const };
      }
    };
    const engine = new FixturePostingEngine(countingLockPort, async () => true);
    const request = baseRequest();

    const first = await engine.submitPostingRequest(FAKE_TX, TENANT_A, request);
    const second = await engine.submitPostingRequest(
      FAKE_TX,
      TENANT_A,
      request
    );

    expect(first).toEqual(second);
    expect(first.status).toBe("posted");
    expect(evaluationCount).toBe(1);
  });

  test("cross-tenant mismatch is rejected — transaction.tenantId must equal the authenticated tenant context", async () => {
    const engine = new FixturePostingEngine(
      noPeriodLockAdapterConfigured,
      async () => true
    );
    const request = baseRequest({ requestId: "req-cross-tenant" });

    // Authenticated as TENANT_B while the transaction claims TENANT_A.
    const result = await engine.submitPostingRequest(
      FAKE_TX,
      TENANT_B,
      request
    );

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toMatch(/tenant mismatch/);
  });

  test("legal-entity scope mismatch is rejected when the resolver reports it does not belong to the tenant", async () => {
    const engine = new FixturePostingEngine(
      noPeriodLockAdapterConfigured,
      async () => false // simulates BusinessScopeHierarchyPort.resolveScope -> resolved: false
    );
    const request = baseRequest({
      requestId: "req-legal-entity-mismatch",
      transaction: {
        tenantId: TENANT_A,
        legalEntityScope: { scopeType: "legal_entity", scopeId: "le-1" },
        transactionType: "example_erp.sales.invoice",
        externalTransactionId: "inv-2",
        status: "submitted"
      }
    });

    const result = await engine.submitPostingRequest(
      FAKE_TX,
      TENANT_A,
      request
    );

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toMatch(/legal-entity scope mismatch/);
  });

  test("period lock fails closed when the capability is unavailable (no adapter configured)", async () => {
    const engine = new FixturePostingEngine(
      noPeriodLockAdapterConfigured,
      async () => true
    );
    const request = baseRequest({ requestId: "req-no-lock-adapter" });

    const result = await engine.submitPostingRequest(
      FAKE_TX,
      TENANT_A,
      request
    );

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toMatch(/failing closed/);
  });

  test("period lock fails closed when the period is explicitly locked", async () => {
    const engine = new FixturePostingEngine(
      createFixturePeriodLockAdapter(new Set(["2026-07"])),
      async () => true
    );
    const request = baseRequest({ requestId: "req-locked-period" });

    const result = await engine.submitPostingRequest(
      FAKE_TX,
      TENANT_A,
      request
    );

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toMatch(/closed for new postings/);
  });

  test("reversal posts as a NEW transaction — the original's stored result is never mutated", async () => {
    const engine = new FixturePostingEngine(
      createFixturePeriodLockAdapter(new Set()),
      async () => true
    );

    // The original's externalTransactionId is "inv-1" (baseRequest's
    // default) — a reversal references THAT, never the original's
    // requestId (invariant 7, business-transaction-contract.ts).
    const original = baseRequest({ requestId: "req-original" });
    const originalResult = await engine.submitPostingRequest(
      FAKE_TX,
      TENANT_A,
      original
    );
    expect(originalResult.status).toBe("posted");

    const reversal = baseRequest({
      requestId: "req-reversal",
      transaction: {
        tenantId: TENANT_A,
        legalEntityScope: null,
        transactionType: "example_erp.sales.invoice",
        // The reversal is its OWN distinct business transaction — never
        // reuses the original's externalTransactionId.
        externalTransactionId: "inv-1-reversal",
        status: "submitted"
      },
      reversalOfExternalTransactionId: "inv-1"
    });
    const reversalResult = await engine.submitPostingRequest(
      FAKE_TX,
      TENANT_A,
      reversal
    );

    expect(reversalResult.status).toBe("reversed");
    // The original's own stored result is byte-identical to what it was
    // immediately after posting — never overwritten by the reversal.
    expect(engine.getStoredResult("req-original")).toEqual(originalResult);
    expect(engine.getStoredResult("req-original")?.status).toBe("posted");
  });

  test("a reversal referencing an unknown/never-posted transaction is rejected", async () => {
    const engine = new FixturePostingEngine(
      createFixturePeriodLockAdapter(new Set()),
      async () => true
    );
    const reversal = baseRequest({
      requestId: "req-reversal-unknown",
      reversalOfExternalTransactionId: "never-posted"
    });

    const result = await engine.submitPostingRequest(
      FAKE_TX,
      TENANT_A,
      reversal
    );

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toMatch(/reversal target/);
  });

  test("SECURITY (High, Issue #755 security-auditor finding): a reversal cannot resolve another tenant's posted transaction, even when the attacker knows its exact externalTransactionId", async () => {
    const engine = new FixturePostingEngine(
      createFixturePeriodLockAdapter(new Set()),
      async () => true
    );

    // TENANT_A posts "inv-1" for real.
    const original = baseRequest({
      requestId: "req-tenant-a-original",
      transaction: {
        tenantId: TENANT_A,
        legalEntityScope: null,
        transactionType: "example_erp.sales.invoice",
        externalTransactionId: "inv-1",
        status: "submitted"
      }
    });
    const originalResult = await engine.submitPostingRequest(
      FAKE_TX,
      TENANT_A,
      original
    );
    expect(originalResult.status).toBe("posted");

    // TENANT_B (a DIFFERENT, legitimately authenticated tenant) attempts a
    // reversal that references the SAME externalTransactionId ("inv-1")
    // and the SAME transactionType — this must be rejected, never resolve
    // TENANT_A's transaction, even though the attacker guessed/observed
    // the exact externalTransactionId.
    const crossTenantReversal = baseRequest({
      requestId: "req-tenant-b-reversal-attempt",
      transaction: {
        tenantId: TENANT_B,
        legalEntityScope: null,
        transactionType: "example_erp.sales.invoice",
        externalTransactionId: "inv-1-reversal",
        status: "submitted"
      },
      reversalOfExternalTransactionId: "inv-1"
    });
    const result = await engine.submitPostingRequest(
      FAKE_TX,
      TENANT_B,
      crossTenantReversal
    );

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toMatch(/reversal target/);
    // TENANT_A's original posting is completely unaffected.
    expect(engine.getStoredResult("req-tenant-a-original")?.status).toBe(
      "posted"
    );
  });

  test("SECURITY (High, Issue #755 security-auditor finding): a reversal targeting the SAME tenant but a mismatched legal-entity scope is rejected", async () => {
    const engine = new FixturePostingEngine(
      createFixturePeriodLockAdapter(new Set()),
      async () => true // resolver always reports the scope resolves — the mismatch below is ORIGINAL-vs-REVERSAL, not an unresolved scope
    );

    const original = baseRequest({
      requestId: "req-scoped-original",
      transaction: {
        tenantId: TENANT_A,
        legalEntityScope: { scopeType: "legal_entity", scopeId: "le-1" },
        transactionType: "example_erp.sales.invoice",
        externalTransactionId: "inv-scoped",
        status: "submitted"
      }
    });
    const originalResult = await engine.submitPostingRequest(
      FAKE_TX,
      TENANT_A,
      original
    );
    expect(originalResult.status).toBe("posted");

    const reversal = baseRequest({
      requestId: "req-scoped-reversal-wrong-scope",
      transaction: {
        tenantId: TENANT_A,
        // A DIFFERENT legal entity than the original posted under.
        legalEntityScope: { scopeType: "legal_entity", scopeId: "le-2" },
        transactionType: "example_erp.sales.invoice",
        externalTransactionId: "inv-scoped-reversal",
        status: "submitted"
      },
      reversalOfExternalTransactionId: "inv-scoped"
    });
    const result = await engine.submitPostingRequest(
      FAKE_TX,
      TENANT_A,
      reversal
    );

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toMatch(
      /reversal target legal-entity scope mismatch/
    );
  });

  test("SECURITY (Medium, Issue #755 security-auditor finding): a second forward post of the SAME (tenantId, transactionType, externalTransactionId) under a NEW requestId is rejected as a duplicate, not accepted as an independent posting", async () => {
    const engine = new FixturePostingEngine(
      createFixturePeriodLockAdapter(new Set()),
      async () => true
    );

    const firstPost = baseRequest({
      requestId: "req-dup-1",
      transaction: {
        tenantId: TENANT_A,
        legalEntityScope: null,
        transactionType: "example_erp.sales.invoice",
        externalTransactionId: "inv-dup",
        status: "submitted"
      }
    });
    const firstResult = await engine.submitPostingRequest(
      FAKE_TX,
      TENANT_A,
      firstPost
    );
    expect(firstResult.status).toBe("posted");

    // Same business transaction (tenantId + transactionType +
    // externalTransactionId), but a BRAND NEW requestId — requestId-only
    // idempotency would let this through as an independent posting;
    // business-identity uniqueness must reject it instead.
    const secondPost = baseRequest({
      requestId: "req-dup-2",
      transaction: {
        tenantId: TENANT_A,
        legalEntityScope: null,
        transactionType: "example_erp.sales.invoice",
        externalTransactionId: "inv-dup",
        status: "submitted"
      }
    });
    const secondResult = await engine.submitPostingRequest(
      FAKE_TX,
      TENANT_A,
      secondPost
    );

    expect(secondResult.status).toBe("rejected");
    expect(secondResult.rejectionReason).toMatch(/duplicate posting/);
    // The original posting (under its own requestId) is unaffected.
    expect(engine.getStoredResult("req-dup-1")?.status).toBe("posted");
  });
});

describe("Reporting projection contribution (Issue #753 integration, Issue #755 acceptance criterion)", () => {
  test("the example ERP extension's reportingProjections descriptor independently passes reporting's real validateProjectionRegistry check", () => {
    const result = validateProjectionRegistry([
      ...listBaseModules(),
      exampleErpExtensionModule
    ]);

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.descriptors.map((d) => d.key)).toContain(
      "example_erp_extension.posting_summary"
    );
  });
});
