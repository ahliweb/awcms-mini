import type { ValidationError, ValidationResult } from "./party-validation";

const ADDRESS_TYPES = ["primary", "billing", "shipping", "other"] as const;
export type AddressType = (typeof ADDRESS_TYPES)[number];

const CHANNEL_TYPES = ["email", "phone", "whatsapp", "other"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

function parseOptionalDate(
  raw: unknown,
  field: string,
  errors: ValidationError[]
): Date | null {
  if (raw === undefined || raw === null) {
    return null;
  }

  if (typeof raw !== "string") {
    errors.push({ field, message: `${field} must be an ISO date string.` });
    return null;
  }

  const parsed = new Date(raw);

  if (Number.isNaN(parsed.getTime())) {
    errors.push({
      field,
      message: `${field} must be a valid ISO date string.`
    });
    return null;
  }

  return parsed;
}

export type CreateAddressInput = {
  addressType: AddressType;
  addressLine: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  countryCode: string;
  isDefault: boolean;
  validFrom: Date;
  validUntil: Date | null;
};

export function validateCreateAddressInput(
  body: unknown
): ValidationResult<CreateAddressInput> {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];

  let addressType: AddressType = "primary";

  if (record.addressType !== undefined) {
    if (
      typeof record.addressType !== "string" ||
      !ADDRESS_TYPES.includes(record.addressType as AddressType)
    ) {
      errors.push({
        field: "addressType",
        message: `addressType must be one of: ${ADDRESS_TYPES.join(", ")}.`
      });
    } else {
      addressType = record.addressType as AddressType;
    }
  }

  const countryCode =
    typeof record.countryCode === "string" &&
    record.countryCode.trim().length > 0
      ? record.countryCode.trim().toUpperCase()
      : "ID";

  if (countryCode.length !== 2) {
    errors.push({
      field: "countryCode",
      message: "countryCode must be a 2-letter ISO country code."
    });
  }

  const isDefault =
    typeof record.isDefault === "boolean" ? record.isDefault : false;

  const validFrom = parseOptionalDate(record.validFrom, "validFrom", errors);
  const validUntil = parseOptionalDate(record.validUntil, "validUntil", errors);

  if (validFrom && validUntil && validUntil.getTime() <= validFrom.getTime()) {
    errors.push({
      field: "validUntil",
      message: "validUntil must be after validFrom."
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      addressType,
      addressLine:
        typeof record.addressLine === "string"
          ? record.addressLine.trim() || null
          : null,
      city: typeof record.city === "string" ? record.city.trim() || null : null,
      province:
        typeof record.province === "string"
          ? record.province.trim() || null
          : null,
      postalCode:
        typeof record.postalCode === "string"
          ? record.postalCode.trim() || null
          : null,
      countryCode,
      isDefault,
      validFrom: validFrom ?? new Date(),
      validUntil
    }
  };
}

export type CreateChannelInput = {
  profileIdentifierId: string;
  channelType: ChannelType;
  isOptIn: boolean;
  isDefault: boolean;
  validFrom: Date;
  validUntil: Date | null;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateCreateChannelInput(
  body: unknown
): ValidationResult<CreateChannelInput> {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];

  if (
    typeof record.profileIdentifierId !== "string" ||
    !UUID_PATTERN.test(record.profileIdentifierId)
  ) {
    errors.push({
      field: "profileIdentifierId",
      message: "profileIdentifierId must be a valid identifier id."
    });
  }

  let channelType: ChannelType = "email";

  if (record.channelType !== undefined) {
    if (
      typeof record.channelType !== "string" ||
      !CHANNEL_TYPES.includes(record.channelType as ChannelType)
    ) {
      errors.push({
        field: "channelType",
        message: `channelType must be one of: ${CHANNEL_TYPES.join(", ")}.`
      });
    } else {
      channelType = record.channelType as ChannelType;
    }
  }

  const isOptIn = typeof record.isOptIn === "boolean" ? record.isOptIn : false;
  const isDefault =
    typeof record.isDefault === "boolean" ? record.isDefault : false;

  const validFrom = parseOptionalDate(record.validFrom, "validFrom", errors);
  const validUntil = parseOptionalDate(record.validUntil, "validUntil", errors);

  if (validFrom && validUntil && validUntil.getTime() <= validFrom.getTime()) {
    errors.push({
      field: "validUntil",
      message: "validUntil must be after validFrom."
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      profileIdentifierId: record.profileIdentifierId as string,
      channelType,
      isOptIn,
      isDefault,
      validFrom: validFrom ?? new Date(),
      validUntil
    }
  };
}
