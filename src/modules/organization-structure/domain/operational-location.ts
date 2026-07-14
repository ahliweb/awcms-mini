/**
 * Operational-location domain rules (Issue #749, epic #738
 * platform-evolution Wave 2, ADR-0016). Pure functions only — no I/O.
 *
 * Address fields are fully optional free text; latitude/longitude are
 * fully optional and, when present, validated to [-90,90]/[-180,180] —
 * mirroring the DB CHECK constraints in migration 063 so the caller gets a
 * clean 400 instead of a raw constraint violation.
 */

const MAX_NAME_LENGTH = 200;
const MAX_ADDRESS_FIELD_LENGTH = 300;
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

export type OperationalLocationValidationError = {
  field: string;
  message: string;
};

export type LocationAddressInput = {
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  countryCode: string | null;
  latitude: number | null;
  longitude: number | null;
};

export type CreateOperationalLocationInput = LocationAddressInput & {
  name: string;
};

export type UpdateOperationalLocationInput = LocationAddressInput & {
  name: string;
};

function validateAddress(
  input: LocationAddressInput,
  errors: OperationalLocationValidationError[]
): void {
  const textFields: [string, string | null][] = [
    ["addressLine1", input.addressLine1],
    ["addressLine2", input.addressLine2],
    ["city", input.city],
    ["region", input.region],
    ["postalCode", input.postalCode]
  ];

  for (const [field, value] of textFields) {
    if (value !== null && value.length > MAX_ADDRESS_FIELD_LENGTH) {
      errors.push({
        field,
        message: `${field} must be at most ${MAX_ADDRESS_FIELD_LENGTH} characters.`
      });
    }
  }

  if (
    input.countryCode !== null &&
    !COUNTRY_CODE_PATTERN.test(input.countryCode)
  ) {
    errors.push({
      field: "countryCode",
      message: "countryCode must be a 2-letter uppercase ISO 3166-1 code."
    });
  }

  if ((input.latitude === null) !== (input.longitude === null)) {
    errors.push({
      field: "longitude",
      message: "latitude and longitude must both be set or both be omitted."
    });
  }

  if (
    input.latitude !== null &&
    (Number.isNaN(input.latitude) ||
      input.latitude < -90 ||
      input.latitude > 90)
  ) {
    errors.push({
      field: "latitude",
      message: "latitude must be between -90 and 90."
    });
  }

  if (
    input.longitude !== null &&
    (Number.isNaN(input.longitude) ||
      input.longitude < -180 ||
      input.longitude > 180)
  ) {
    errors.push({
      field: "longitude",
      message: "longitude must be between -180 and 180."
    });
  }
}

export function validateCreateOperationalLocationInput(
  input: CreateOperationalLocationInput
): OperationalLocationValidationError[] {
  const errors: OperationalLocationValidationError[] = [];

  if (!input.name || input.name.trim().length === 0) {
    errors.push({ field: "name", message: "name is required." });
  } else if (input.name.length > MAX_NAME_LENGTH) {
    errors.push({
      field: "name",
      message: `name must be at most ${MAX_NAME_LENGTH} characters.`
    });
  }

  validateAddress(input, errors);

  return errors;
}

export function validateUpdateOperationalLocationInput(
  input: UpdateOperationalLocationInput
): OperationalLocationValidationError[] {
  const errors: OperationalLocationValidationError[] = [];

  if (!input.name || input.name.trim().length === 0) {
    errors.push({ field: "name", message: "name is required." });
  } else if (input.name.length > MAX_NAME_LENGTH) {
    errors.push({
      field: "name",
      message: `name must be at most ${MAX_NAME_LENGTH} characters.`
    });
  }

  validateAddress(input, errors);

  return errors;
}
