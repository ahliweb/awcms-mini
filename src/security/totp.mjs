import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function normalizeBase32(input) {
  return String(input ?? "")
    .toUpperCase()
    .replace(/=+$/g, "")
    .replace(/[^A-Z2-7]/g, "");
}

export function encodeBase32(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

export function decodeBase32(input) {
  const normalized = normalizeBase32(input);
  let bits = 0;
  let value = 0;
  const output = [];

  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);

    if (index < 0) {
      continue;
    }

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(output);
}

export function generateTotpSecret(size = 20) {
  return encodeBase32(randomBytes(size));
}

export function buildOtpAuthUrl({ secret, label, issuer }) {
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

export function generateTotpCode(secret, options = {}) {
  const digits = options.digits ?? 6;
  const period = options.period ?? 30;
  const timestamp = options.timestamp ?? Date.now();
  const counter = Math.floor(timestamp / 1000 / period);
  const secretBuffer = decodeBase32(secret);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secretBuffer).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(code % 10 ** digits).padStart(digits, "0");
}

export function verifyTotpCode(secret, code, options = {}) {
  const normalizedCode = String(code ?? "").trim();
  const window = options.window ?? 1;
  const period = options.period ?? 30;
  const timestamp = options.timestamp ?? Date.now();

  for (let step = -window; step <= window; step += 1) {
    const expected = generateTotpCode(secret, { timestamp: timestamp + step * period * 1000, digits: options.digits ?? 6, period });
    const expectedBuffer = Buffer.from(expected);
    const receivedBuffer = Buffer.from(normalizedCode);

    if (expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer)) {
      return true;
    }
  }

  return false;
}

export function encryptTotpSecret(secret, encryptionKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64url");
}

export function decryptTotpSecret(payload, encryptionKey) {
  const buffer = Buffer.from(payload, "base64url");
  const iv = buffer.subarray(0, 12);
  const authTag = buffer.subarray(12, 28);
  const ciphertext = buffer.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
