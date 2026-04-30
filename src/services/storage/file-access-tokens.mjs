import { SignJWT, jwtVerify } from "jose";

import { getRuntimeConfig } from "../../config/runtime.mjs";

const encoder = new TextEncoder();

function resolveSecret(runtimeConfig) {
  const secret = runtimeConfig.appSecret || runtimeConfig.edgeApi?.jwt?.secret;

  if (!secret) {
    throw new Error("File access token signing secret is not configured.");
  }

  return encoder.encode(secret);
}

export function createFileAccessTokenService(options = {}) {
  const runtimeConfig = options.runtimeConfig ?? getRuntimeConfig();
  const issuer = options.issuer ?? "awcms-mini-files";
  const audience = options.audience ?? "awcms-mini-files";
  const ttlSeconds = Number(options.ttlSeconds ?? 300);
  const key = options.key ?? resolveSecret(runtimeConfig);

  return {
    async signUploadToken(input) {
      return new SignJWT({
        typ: "upload",
        file_id: input.fileId,
        storage_key: input.storageKey,
      })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject(String(input.actorId ?? "system"))
        .setIssuedAt()
        .setExpirationTime(`${ttlSeconds}s`)
        .sign(key);
    },

    async signDownloadToken(input) {
      return new SignJWT({
        typ: "download",
        file_id: input.fileId,
        storage_key: input.storageKey,
      })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject(String(input.actorId ?? "system"))
        .setIssuedAt()
        .setExpirationTime(`${ttlSeconds}s`)
        .sign(key);
    },

    async verify(token, expectedType) {
      const verified = await jwtVerify(token, key, {
        issuer,
        audience,
        algorithms: ["HS256"],
      });

      const payload = verified.payload ?? {};

      if (payload.typ !== expectedType) {
        throw new Error("Token type mismatch.");
      }

      if (!payload.file_id || !payload.storage_key) {
        throw new Error("Token payload is invalid.");
      }

      return payload;
    },
  };
}
