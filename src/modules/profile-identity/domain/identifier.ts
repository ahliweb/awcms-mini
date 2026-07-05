import { createHash } from "node:crypto";

export type IdentifierType =
  | "email"
  | "phone"
  | "whatsapp"
  | "national_id"
  | "tax_id"
  | "external_code"
  | "other";

const PHONE_LIKE_TYPES: ReadonlySet<IdentifierType> = new Set([
  "phone",
  "whatsapp"
]);

export function normalizeIdentifier(
  type: IdentifierType,
  rawValue: string
): string {
  const trimmed = rawValue.trim();

  if (type === "email") {
    return trimmed.toLowerCase();
  }

  if (PHONE_LIKE_TYPES.has(type)) {
    return trimmed.replace(/(?!^\+)[^\d]/g, "");
  }

  return trimmed;
}

export function hashIdentifier(normalizedValue: string): string {
  return `sha256:${createHash("sha256").update(normalizedValue).digest("hex")}`;
}

export function maskIdentifier(
  type: IdentifierType,
  normalizedValue: string
): string {
  if (type === "email") {
    const atIndex = normalizedValue.indexOf("@");

    if (atIndex <= 0) {
      return maskTail(normalizedValue);
    }

    const localPart = normalizedValue.slice(0, atIndex);
    const domainPart = normalizedValue.slice(atIndex);

    return `${localPart[0]}${"*".repeat(Math.max(localPart.length - 1, 1))}${domainPart}`;
  }

  return maskTail(normalizedValue);
}

function maskTail(value: string, visibleTailLength = 4): string {
  if (value.length <= visibleTailLength) {
    return "*".repeat(value.length);
  }

  const tail = value.slice(-visibleTailLength);

  return `${"*".repeat(value.length - visibleTailLength)}${tail}`;
}
