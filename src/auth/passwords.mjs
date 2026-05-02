import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_PREFIX = "scrypt";
const SCRYPT_KEYLEN = 64;

function toBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function fromBase64Url(value) {
  return Buffer.from(value, "base64url");
}

function normalizePasswordInput(password) {
  const base = String(password ?? "");
  const pepper = typeof process.env.PASSWORD_PEPPER === "string" ? process.env.PASSWORD_PEPPER : "";
  return pepper ? `${base}${pepper}` : base;
}

export function hashPassword(password) {
  const normalizedPassword = normalizePasswordInput(password);
  const salt = randomBytes(16);
  const derived = scryptSync(normalizedPassword, salt, SCRYPT_KEYLEN);
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
  const normalizedPassword = normalizePasswordInput(password);
  const actual = scryptSync(normalizedPassword, salt, expected.length);
  return timingSafeEqual(actual, expected);
}
