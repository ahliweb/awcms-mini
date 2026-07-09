import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";

import {
  findJwk,
  parseJwt,
  verifyJwtRs256,
  type Jwk
} from "../../src/lib/auth/jwt-verify";

function base64Url(input: Buffer | string): string {
  const buffer = typeof input === "string" ? Buffer.from(input) : input;
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Builds a real, correctly-signed RS256 JWT from a fresh keypair — the same construction Google's own ID tokens use, so `parseJwt`/`verifyJwtRs256` are tested against a genuine signature, not a mock. */
function buildSignedJwt(
  payload: Record<string, unknown>,
  kid = "test-key-1"
): { token: string; jwk: Jwk } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048
  });
  const jwk = { ...(publicKey.export({ format: "jwk" }) as Jwk), kid };

  const header = { alg: "RS256", typ: "JWT", kid };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = cryptoSign(
    "RSA-SHA256",
    Buffer.from(signingInput),
    privateKey
  );
  const token = `${signingInput}.${base64Url(signature)}`;

  return { token, jwk };
}

describe("parseJwt", () => {
  test("parses a well-formed JWT into header/payload/signingInput/signature", () => {
    const { token } = buildSignedJwt({ sub: "user-123", aud: "client-abc" });
    const parsed = parseJwt(token);

    expect(parsed.header.alg).toBe("RS256");
    expect(parsed.header.kid).toBe("test-key-1");
    expect(parsed.payload.sub).toBe("user-123");
    expect(parsed.signingInput).toBe(token.split(".").slice(0, 2).join("."));
    expect(parsed.signature.length).toBeGreaterThan(0);
  });

  test("throws on a token with the wrong number of segments", () => {
    expect(() => parseJwt("only.two")).toThrow();
    expect(() => parseJwt("a.b.c.d")).toThrow();
  });

  test("throws on a token whose header/payload isn't valid base64url JSON", () => {
    expect(() => parseJwt("not-json.not-json.sig")).toThrow();
  });
});

describe("findJwk", () => {
  const keys: Jwk[] = [
    { kty: "RSA", kid: "key-a", n: "a", e: "AQAB" },
    { kty: "RSA", kid: "key-b", n: "b", e: "AQAB" }
  ];

  test("finds the matching key by kid", () => {
    expect(findJwk({ keys }, "key-b")).toEqual(keys[1]!);
  });

  test("returns null when no key matches", () => {
    expect(findJwk({ keys }, "key-c")).toBeNull();
  });
});

describe("verifyJwtRs256", () => {
  test("verifies a genuinely signed token against its own public JWK", async () => {
    const { token, jwk } = buildSignedJwt({ sub: "user-123" });
    const parsed = parseJwt(token);

    const valid = await verifyJwtRs256(
      parsed.signingInput,
      parsed.signature,
      jwk
    );
    expect(valid).toBe(true);
  });

  test("rejects a token verified against a DIFFERENT key's JWK", async () => {
    const { token } = buildSignedJwt({ sub: "user-123" });
    const { jwk: otherJwk } = buildSignedJwt({ sub: "someone-else" });
    const parsed = parseJwt(token);

    const valid = await verifyJwtRs256(
      parsed.signingInput,
      parsed.signature,
      otherJwk
    );
    expect(valid).toBe(false);
  });

  test("rejects a tampered payload (signature no longer matches)", async () => {
    const { token, jwk } = buildSignedJwt({ sub: "user-123", admin: false });
    const parsed = parseJwt(token);

    // Tamper: flip a claim in the payload without re-signing.
    const tamperedPayloadB64 = base64Url(
      JSON.stringify({ ...parsed.payload, admin: true })
    );
    const tamperedSigningInput = `${token.split(".")[0]}.${tamperedPayloadB64}`;

    const valid = await verifyJwtRs256(
      tamperedSigningInput,
      parsed.signature,
      jwk
    );
    expect(valid).toBe(false);
  });

  test("returns false (never throws) for a non-RSA key type", async () => {
    const { token } = buildSignedJwt({ sub: "user-123" });
    const parsed = parseJwt(token);

    const valid = await verifyJwtRs256(parsed.signingInput, parsed.signature, {
      kty: "EC"
    } as Jwk);
    expect(valid).toBe(false);
  });

  test("returns false (never throws) for a malformed JWK", async () => {
    const { token } = buildSignedJwt({ sub: "user-123" });
    const parsed = parseJwt(token);

    const valid = await verifyJwtRs256(parsed.signingInput, parsed.signature, {
      kty: "RSA",
      n: "not-valid-base64url!!!",
      e: "AQAB"
    });
    expect(valid).toBe(false);
  });
});
