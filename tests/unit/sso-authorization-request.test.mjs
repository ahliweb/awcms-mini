import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  buildAuthorizationRequestUrl,
  createOidcLoginState,
  validateAuthorizationCallback,
} from "../../src/auth/sso/authorization-request.mjs";

const provider = {
  client_id: "mini-client",
  authorization_endpoint: "https://idp.example.com/authorize",
  scopes: ["openid", "email", "profile"],
};

test("createOidcLoginState produces distinct high-entropy values with a correct PKCE S256 challenge", () => {
  const a = createOidcLoginState();
  const b = createOidcLoginState();

  // Anti-forgery values harus acak & berbeda antar percobaan.
  assert.notEqual(a.state, b.state);
  assert.notEqual(a.nonce, b.nonce);
  assert.notEqual(a.codeVerifier, b.codeVerifier);
  for (const v of [a.state, a.nonce, a.codeVerifier]) {
    assert.ok(v.length >= 43, "harus >= 43 char base64url (32 byte)");
    assert.match(v, /^[A-Za-z0-9_-]+$/, "base64url tanpa padding");
  }

  // code_challenge = BASE64URL(SHA256(code_verifier)).
  const expected = createHash("sha256").update(a.codeVerifier).digest("base64url");
  assert.equal(a.codeChallenge, expected);
  assert.equal(a.codeChallengeMethod, "S256");
});

test("buildAuthorizationRequestUrl sets all required OIDC + PKCE parameters", () => {
  const { state, nonce, codeChallenge } = createOidcLoginState();
  const href = buildAuthorizationRequestUrl(provider, {
    redirectUri: "https://app.example.com/auth/sso/callback",
    state,
    nonce,
    codeChallenge,
  });
  const url = new URL(href);

  assert.equal(url.origin + url.pathname, "https://idp.example.com/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "mini-client");
  assert.equal(url.searchParams.get("redirect_uri"), "https://app.example.com/auth/sso/callback");
  assert.equal(url.searchParams.get("scope"), "openid email profile");
  assert.equal(url.searchParams.get("state"), state);
  assert.equal(url.searchParams.get("nonce"), nonce);
  assert.equal(url.searchParams.get("code_challenge"), codeChallenge);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("buildAuthorizationRequestUrl rejects non-HTTPS endpoints and off-allowlist redirects", () => {
  const { state, nonce, codeChallenge } = createOidcLoginState();
  const good = "https://app.example.com/auth/sso/callback";

  assert.throws(
    () => buildAuthorizationRequestUrl({ ...provider, authorization_endpoint: "http://idp/x" }, { redirectUri: good, state, nonce, codeChallenge }),
    /authorization_endpoint/,
  );
  assert.throws(
    () => buildAuthorizationRequestUrl(provider, { redirectUri: "http://app/cb", state, nonce, codeChallenge }),
    /redirect_uri harus URL HTTPS/,
  );
  assert.throws(
    () =>
      buildAuthorizationRequestUrl(provider, {
        redirectUri: "https://evil.example.com/cb",
        state,
        nonce,
        codeChallenge,
        allowedRedirectUris: [good],
      }),
    /allowlist/,
  );
});

test("validateAuthorizationCallback enforces state match, surfaces IdP errors, and requires a code", () => {
  const expectedState = "state-abc";

  assert.deepEqual(
    validateAuthorizationCallback({ params: { code: "auth-code", state: expectedState }, expectedState }),
    { code: "auth-code", state: expectedState },
  );

  // state mismatch → tolak (CSRF).
  assert.throws(
    () => validateAuthorizationCallback({ params: { code: "c", state: "wrong" }, expectedState }),
    /state callback tidak cocok/,
  );
  // IdP error param → tolak.
  assert.throws(
    () => validateAuthorizationCallback({ params: { error: "access_denied", state: expectedState }, expectedState }),
    /IdP mengembalikan error/,
  );
  // code hilang → tolak.
  assert.throws(
    () => validateAuthorizationCallback({ params: { state: expectedState }, expectedState }),
    /authorization code tidak ada/,
  );
  // expectedState hilang → tolak (tak bisa validasi).
  assert.throws(() => validateAuthorizationCallback({ params: { code: "c", state: "x" } }), /expectedState/);
});
