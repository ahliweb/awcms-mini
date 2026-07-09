/**
 * Minimal RS256 JWT verification for OIDC ID tokens (Issue #590, epic:
 * full-online auth hardening). Deliberately dependency-free (Bun-only rule:
 * no `jose`/`jsonwebtoken`) — signature verification itself is delegated to
 * the platform's own WebCrypto (`crypto.subtle`, available natively in Bun),
 * so this file only handles JWT framing (base64url, header/payload parsing)
 * and JWKS-key selection, never hand-rolled RSA math.
 *
 * Scope is intentionally narrow: RS256 only (the only algorithm Google's ID
 * tokens use), and claim *extraction* only — issuer/audience/expiry/nonce
 * *policy* decisions live in `../../modules/identity-access/domain/
 * google-oidc-policy.ts` (pure, testable without a network/JWKS call).
 */
function base64UrlDecode(segment: string): Buffer {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(padLength), "base64");
}

export type JwtHeader = { alg?: string; kid?: string; typ?: string };
export type JwtPayload = Record<string, unknown>;

export type ParsedJwt = {
  header: JwtHeader;
  payload: JwtPayload;
  signingInput: string;
  signature: Buffer;
};

/** Splits and base64url-decodes a compact JWT — throws on any structural malformation. Never verifies the signature (see `verifyJwtRs256`). */
export function parseJwt(token: string): ParsedJwt {
  const parts = token.split(".");

  if (parts.length !== 3) {
    throw new Error("Malformed JWT: expected exactly 3 dot-separated parts.");
  }

  const [headerPart, payloadPart, signaturePart] = parts;
  const header = JSON.parse(
    base64UrlDecode(headerPart!).toString("utf8")
  ) as JwtHeader;
  const payload = JSON.parse(
    base64UrlDecode(payloadPart!).toString("utf8")
  ) as JwtPayload;

  return {
    header,
    payload,
    signingInput: `${headerPart}.${payloadPart}`,
    signature: base64UrlDecode(signaturePart!)
  };
}

export type Jwk = {
  kty: string;
  kid?: string;
  alg?: string;
  n?: string;
  e?: string;
  use?: string;
};

/** Finds the JWKS entry matching `kid` — Google rotates signing keys, so the ID token's `kid` header always identifies which of several published keys was used. */
export function findJwk(jwks: { keys: Jwk[] }, kid: string): Jwk | null {
  return jwks.keys.find((key) => key.kid === kid) ?? null;
}

/**
 * Verifies an RS256 signature over `signingInput` using an RSA public JWK,
 * via WebCrypto (`crypto.subtle`) — never a hand-rolled implementation.
 * Returns `false` (never throws) for a malformed/unusable key, so a bad JWKS
 * response degrades to "verification failed", not a crash.
 */
export async function verifyJwtRs256(
  signingInput: string,
  signature: Buffer,
  jwk: Jwk
): Promise<boolean> {
  if (jwk.kty !== "RSA") {
    return false;
  }

  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );

    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      new Uint8Array(signature),
      new TextEncoder().encode(signingInput)
    );
  } catch {
    return false;
  }
}
