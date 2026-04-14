import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_PREFIX = "scrypt";
const SCRYPT_KEYLEN = 64;

function toBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function fromBase64Url(value) {
  return Buffer.from(value, "base64url");
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${SCRYPT_PREFIX}$${toBase64Url(salt)}$${toBase64Url(derived)}`;
}

export function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== "string") {
    return false;
  }

  const [prefix, saltValue, hashValue] = storedHash.split("$");
  if (prefix !== SCRYPT_PREFIX || !saltValue || !hashValue) {
    return false;
  }

  const salt = fromBase64Url(saltValue);
  const expected = fromBase64Url(hashValue);
  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(actual, expected);
}
