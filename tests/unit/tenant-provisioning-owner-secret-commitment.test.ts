/**
 * Unit tests for the tenant_provisioning owner-secret commitment and the
 * `inputs_hash` it feeds (CodeQL alerts #63/#64, epic #868).
 *
 * The property under test is NOT "a hash is produced" — the pre-fix code
 * produced one too. It is that the persisted `inputs_hash` is no longer an
 * offline password-cracking oracle: every other field feeding it is readable by
 * anyone who can read `awcms_mini_tenant_provisioning_requests`, so before the
 * fix a database reader could confirm password guesses at two unsalted SHA-256
 * per guess.
 *
 * The decisive assertion is the PEPPER-DEPENDENCE test: compute the hash, swap
 * `AUTH_JWT_SECRET`, and require the result to change. That fails for any
 * unkeyed derivation AND for dropping the password outright, regardless of how
 * the JSON field is named. All three mutations (unkeyed digest, password
 * dropped, silent empty-key fallback) were verified red against this file.
 *
 * An earlier draft also reproduced the pre-fix formula here and asserted
 * inequality against it. That assertion was removed: it was never sufficient
 * on its own (it also passes when only the JSON field name changes), and
 * reproducing the vulnerable derivation raised its own
 * `js/insufficient-password-hash` alert on the test file — a fixture that
 * re-creates the exact bug being fixed is not worth a permanent exception.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

/**
 * Explicit try/catch rather than `expect(...).rejects.toThrow()`: that matcher
 * has hung indefinitely against some promise types in this repo, and a hung
 * test is far worse than a verbose one.
 */
async function expectRejection(
  fn: () => Promise<unknown>,
  pattern: RegExp
): Promise<void> {
  let message: string | undefined;
  try {
    await fn();
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message ?? "(did not throw)").toMatch(pattern);
}

import { commitOwnerSecret } from "../../src/modules/tenant-provisioning/application/owner-secret-commitment";
import { computeProvisioningInputsHash } from "../../src/modules/tenant-provisioning/application/provisioning-orchestrator";
import { pseudonymizeUniqueDimension } from "../../src/modules/usage-metering/application/unique-dimension-pseudonym";
import { hashClientIp } from "../../src/lib/security/client-fingerprint";
import { findConfigVarEntry } from "../../src/lib/config/registry";
import type { ProvisioningRequestInput } from "../../src/modules/tenant-provisioning/domain/request-validation";

const SECRET = "fixture_owner_secret_commitment_key_not_a_real_secret";
const OWNER_PASSWORD = "fixture_owner_password_not_a_real_secret";

function buildInput(
  overrides: Partial<ProvisioningRequestInput> = {}
): ProvisioningRequestInput {
  return {
    planKey: "standard_tenant",
    planVersion: 1,
    tenantCode: "acme",
    tenantName: "Acme Corp",
    legalName: "Acme Corporation Ltd",
    owner: {
      displayName: "Acme Owner",
      loginIdentifier: "owner@acme.example.com",
      password: OWNER_PASSWORD
    },
    officeCode: "hq",
    officeName: "Head Office",
    options: {
      defaultLocale: "id-ID",
      defaultTheme: null,
      timezone: "Asia/Jakarta",
      subdomain: null,
      presetKey: null,
      offerPlanKey: null,
      offerVersion: null
    },
    ...overrides
  };
}

describe("tenant_provisioning owner-secret commitment", () => {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.AUTH_JWT_SECRET;
    process.env.AUTH_JWT_SECRET = SECRET;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.AUTH_JWT_SECRET;
    else process.env.AUTH_JWT_SECRET = previous;
  });

  test("is deterministic — the same secret yields the same commitment (idempotent replay still matches)", async () => {
    expect(await commitOwnerSecret(OWNER_PASSWORD)).toBe(
      await commitOwnerSecret(OWNER_PASSWORD)
    );
    expect(await commitOwnerSecret(OWNER_PASSWORD)).not.toBe(
      await commitOwnerSecret(`${OWNER_PASSWORD}x`)
    );
    expect(await commitOwnerSecret(OWNER_PASSWORD)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is keyed: an attacker holding the database but not AUTH_JWT_SECRET cannot reproduce the commitment from a correct guess", async () => {
    const withRealKey = await commitOwnerSecret(OWNER_PASSWORD);
    process.env.AUTH_JWT_SECRET = "fixture_other_process_key_not_a_real_secret";
    // Same password, different pepper -> different digest. Guessing the
    // password is therefore not sufficient to confirm a hit.
    expect(await commitOwnerSecret(OWNER_PASSWORD)).not.toBe(withRealKey);
  });

  test("is domain-separated from the other AUTH_JWT_SECRET-keyed digests", async () => {
    const raw = "shared-input";
    expect(await commitOwnerSecret(raw)).not.toBe(
      createHmac("sha256", SECRET).update(raw).digest("hex")
    );
    expect(await commitOwnerSecret(raw)).not.toBe(hashClientIp(raw));
    expect(await commitOwnerSecret(raw)).not.toBe(
      pseudonymizeUniqueDimension(raw)
    );
  });

  test("fail-closed: throws on a missing or placeholder secret rather than degrading to an unkeyed digest", async () => {
    delete process.env.AUTH_JWT_SECRET;
    await expectRejection(
      () => commitOwnerSecret(OWNER_PASSWORD),
      /AUTH_JWT_SECRET/
    );

    const placeholder = findConfigVarEntry("AUTH_JWT_SECRET")?.default;
    if (placeholder !== undefined) {
      process.env.AUTH_JWT_SECRET = placeholder;
      await expectRejection(
        () => commitOwnerSecret(OWNER_PASSWORD),
        /placeholder/
      );
    }
  });
});

describe("computeProvisioningInputsHash", () => {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.AUTH_JWT_SECRET;
    process.env.AUTH_JWT_SECRET = SECRET;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.AUTH_JWT_SECRET;
    else process.env.AUTH_JWT_SECRET = previous;
  });

  test("depends on the process pepper — a database reader without AUTH_JWT_SECRET cannot recompute it from a guess", async () => {
    // The load-bearing assertion. It holds only if the password reaches the
    // digest through the KEYED commitment: reverting to any unkeyed derivation
    // (or dropping the password outright) makes the hash independent of the
    // pepper and fails here, regardless of how the JSON field is named.
    const input = buildInput();
    const withKeyA = await computeProvisioningInputsHash(input);
    process.env.AUTH_JWT_SECRET =
      "fixture_rotated_process_key_not_a_real_secret";
    expect(await computeProvisioningInputsHash(input)).not.toBe(withKeyA);
  });

  test("still detects a same-key-different-password replay (409 conflict semantics preserved)", async () => {
    // Dropping the password from the hash entirely would ALSO silence the
    // CodeQL alert — and would silently answer a changed-password retry with a
    // replay of the original success. Assert the password still participates.
    const base = buildInput();
    const changed = buildInput({
      owner: {
        ...base.owner,
        password: "fixture_owner_password_variant_not_a_real_secret"
      }
    });
    expect(await computeProvisioningInputsHash(base)).not.toBe(
      await computeProvisioningInputsHash(changed)
    );
  });

  test("is stable across calls for an identical payload (idempotent replay matches)", async () => {
    expect(await computeProvisioningInputsHash(buildInput())).toBe(
      await computeProvisioningInputsHash(buildInput())
    );
  });

  test("still discriminates every non-secret field it binds", async () => {
    const base = await computeProvisioningInputsHash(buildInput());
    const variants: Partial<ProvisioningRequestInput>[] = [
      { planVersion: 2 },
      { tenantCode: "acme2" },
      { tenantName: "Acme Corp 2" },
      { legalName: null },
      { officeCode: "branch" },
      { officeName: "Branch Office" },
      { owner: { ...buildInput().owner, displayName: "Someone Else" } },
      {
        owner: {
          ...buildInput().owner,
          loginIdentifier: "other@acme.example.com"
        }
      },
      { options: { ...buildInput().options, timezone: "UTC" } }
    ];
    for (const override of variants) {
      const label = Object.keys(override)[0]!;
      expect(
        `${label}:${await computeProvisioningInputsHash(buildInput(override))}`
      ).not.toBe(`${label}:${base}`);
    }
  });
});
