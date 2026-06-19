import test from "node:test";
import assert from "node:assert/strict";

import {
  validateSsoProviderConfig,
  SSO_PROVIDER_KINDS,
  DEFAULT_OIDC_SCOPES,
} from "../../src/auth/sso/provider-config.mjs";

const validOidc = {
  kind: "oidc",
  display_name: "Keycloak",
  issuer: "https://idp.example.com/realms/awcms",
  client_id: "awcms-mini",
};

test("sso config: konstanta kind & default scopes", () => {
  assert.deepEqual([...SSO_PROVIDER_KINDS], ["oidc", "saml"]);
  assert.deepEqual([...DEFAULT_OIDC_SCOPES], ["openid", "email", "profile"]);
});

test("sso config: OIDC valid ternormalkan + scopes default", () => {
  const out = validateSsoProviderConfig(validOidc);
  assert.equal(out.kind, "oidc");
  assert.equal(out.issuer, "https://idp.example.com/realms/awcms");
  assert.deepEqual(out.scopes, ["openid", "email", "profile"]);
  assert.equal(out.allow_jit, false);
  assert.equal(out.enabled, true);
  assert.deepEqual(out.claim_mappings, {});
});

test("sso config: tolak input non-objek", () => {
  assert.throws(() => validateSsoProviderConfig(null), /harus berupa objek/);
  assert.throws(() => validateSsoProviderConfig("x"), /harus berupa objek/);
});

test("sso config: tolak kind tidak dikenal", () => {
  assert.throws(() => validateSsoProviderConfig({ ...validOidc, kind: "ldap" }), /kind tidak valid/);
});

test("sso config: field wajib", () => {
  assert.throws(() => validateSsoProviderConfig({ ...validOidc, display_name: "" }), /display_name/);
  assert.throws(() => validateSsoProviderConfig({ ...validOidc, issuer: "" }), /issuer/);
  assert.throws(() => validateSsoProviderConfig({ ...validOidc, client_id: "" }), /client_id/);
});

test("sso config: issuer OIDC wajib HTTPS", () => {
  assert.throws(
    () => validateSsoProviderConfig({ ...validOidc, issuer: "http://insecure.example.com" }),
    /HTTPS/,
  );
});

test("sso config: endpoint non-HTTPS ditolak bila diisi", () => {
  assert.throws(
    () => validateSsoProviderConfig({ ...validOidc, jwks_uri: "http://x/jwks" }),
    /jwks_uri harus URL HTTPS/,
  );
});

test("sso config: scopes & domain dinormalkan (lowercase, unik)", () => {
  const out = validateSsoProviderConfig({
    ...validOidc,
    scopes: ["OpenID", "openid", "Email"],
    allowed_email_domains: ["Example.COM", "example.com"],
  });
  assert.deepEqual(out.scopes, ["openid", "email"]);
  assert.deepEqual(out.allowed_email_domains, ["example.com"]);
});

test("sso config: claim_mappings non-objek ditolak", () => {
  assert.throws(
    () => validateSsoProviderConfig({ ...validOidc, claim_mappings: ["x"] }),
    /claim_mappings harus objek/,
  );
});

test("sso config: TIDAK meneruskan secret mentah", () => {
  const out = validateSsoProviderConfig({ ...validOidc, client_secret: "PLAINTEXT-SECRET" });
  assert.ok(!("client_secret" in out), "kontrak tidak boleh meneruskan client_secret mentah");
  assert.ok(!("client_secret_enc" in out), "enkripsi ditangani di lapisan persistensi, bukan kontrak");
});
