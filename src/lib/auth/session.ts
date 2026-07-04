/**
 * Session token (JWT HS256 via jose) — dipakai modul identity-access.
 * Secret hanya dari environment (AUTH_JWT_SECRET); TTL dari config.
 */
import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import { getConfig } from "../config";
import { apiError } from "../../modules/_shared/api-error";

export type SessionClaims = {
  identityId: string;
  tenantId: string;
  tenantUserId: string;
  roles: string[];
};

function secretKey(): Uint8Array {
  return new TextEncoder().encode(getConfig().auth.jwtSecret);
}

export async function issueSessionToken(claims: SessionClaims): Promise<string> {
  const ttlMin = getConfig().auth.sessionTtlMin;
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer("awcms-mini")
    .setExpirationTime(`${ttlMin}m`)
    .sign(secretKey());
}

export async function verifySessionToken(token: string): Promise<SessionClaims> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { issuer: "awcms-mini" });
    const { identityId, tenantId, tenantUserId, roles } = payload as Record<string, unknown>;
    if (
      typeof identityId !== "string" ||
      typeof tenantId !== "string" ||
      typeof tenantUserId !== "string" ||
      !Array.isArray(roles)
    ) {
      throw apiError("AUTH_REQUIRED", "Token sesi tidak valid.");
    }
    return {
      identityId,
      tenantId,
      tenantUserId,
      roles: roles.filter((role): role is string => typeof role === "string")
    };
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) {
      throw apiError("TOKEN_EXPIRED", "Token sesi kadaluarsa.");
    }
    throw apiError("AUTH_REQUIRED", "Token sesi tidak valid.");
  }
}
