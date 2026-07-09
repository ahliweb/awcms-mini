import { describe, expect, test } from "bun:test";

import {
  buildOAuthStateParam,
  generateOAuthState,
  generateOidcNonce,
  hashOAuthState,
  parseOAuthStateParam
} from "../../src/lib/auth/oauth-state-token";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";

describe("generateOAuthState/hashOAuthState", () => {
  test("generates a base64url token and a stable sha256 hash", () => {
    const state = generateOAuthState();
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);

    const hash = hashOAuthState(state);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashOAuthState(state)).toBe(hash);
  });

  test("different tokens hash differently", () => {
    const a = generateOAuthState();
    const b = generateOAuthState();
    expect(hashOAuthState(a)).not.toBe(hashOAuthState(b));
  });
});

describe("generateOidcNonce", () => {
  test("generates a base64url nonce, distinct across calls", () => {
    const a = generateOidcNonce();
    const b = generateOidcNonce();
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
  });
});

describe("buildOAuthStateParam/parseOAuthStateParam", () => {
  test("round-trips a tenant id and raw token", () => {
    const rawToken = generateOAuthState();
    const stateParam = buildOAuthStateParam(TENANT_ID, rawToken);
    const parsed = parseOAuthStateParam(stateParam);

    expect(parsed).toEqual({ tenantId: TENANT_ID, token: rawToken });
  });

  test("returns null when there's no separator", () => {
    expect(parseOAuthStateParam("no-separator-here")).toBeNull();
  });

  test("returns null when the tenant id prefix isn't a valid UUID", () => {
    expect(parseOAuthStateParam("not-a-uuid.some-token")).toBeNull();
  });

  test("returns null when the token portion is empty", () => {
    expect(parseOAuthStateParam(`${TENANT_ID}.`)).toBeNull();
  });

  test("tolerates a token portion that itself contains dots (base64url never produces one, but defensive)", () => {
    const parsed = parseOAuthStateParam(`${TENANT_ID}.abc.def`);
    expect(parsed).toEqual({ tenantId: TENANT_ID, token: "abc.def" });
  });
});
