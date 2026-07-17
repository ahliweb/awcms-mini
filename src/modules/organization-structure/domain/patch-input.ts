/**
 * Partial-`PATCH` parse + merge for every `organization_structure` resource
 * (Issue #837, spin-off of #822). Before this, each route rebuilt its full
 * update input with `typeof body.x === "string" ? body.x : <default>`, so a
 * `PATCH` that omitted a field silently RESET it — `name` -> `""`,
 * `effectiveFrom` -> `new Date()`, `effectiveTo`/FKs -> `null`. For the
 * effective-dated units/legal-entities that back `BusinessScopeHierarchyPort`
 * (#786) that truncated the validity history of a record on any one-field edit.
 *
 * Normative `PATCH` semantics instead (same contract `reference-data`'s
 * `code-patch.ts` established): **absent = keep**, **`null` = clear** a nullable
 * field, any other value = replace. `name`/`effectiveFrom` are `NOT NULL`, so
 * an explicit `null` for either is rejected (400) rather than defaulted.
 *
 * Parse (body -> sparse patch) and merge (stored values + patch -> full update
 * input) are kept separate so each is unit-testable in isolation. VALUE-level
 * validation stays in the sibling `validateUpdate*` validators, run once on the
 * merged result by the application layer — this file only decides
 * absent/null/replace and coerces the raw JSON type.
 */
import type { PatchFieldError } from "../../_shared/partial-patch";
import {
  readNullableDatePatch,
  readNullableNumberPatch,
  readNullableStringPatch,
  readRequiredDatePatch,
  readRequiredStringPatch
} from "../../_shared/partial-patch";
import type { UpdateOrganizationUnitInput } from "./organization-unit";
import type { UpdateLegalEntityInput } from "./legal-entity";
import type { UpdateOperationalLocationInput } from "./operational-location";
import type { UpdateOrganizationUnitTypeInput } from "./organization-unit-type";

export type OrganizationUnitPatch = {
  name?: string;
  legalEntityId?: string | null;
  unitTypeId?: string | null;
  effectiveFrom?: Date;
  effectiveTo?: Date | null;
};

export type LegalEntityPatch = {
  name?: string;
  registrationIdentifier?: string | null;
  registrationIdentifierLabel?: string | null;
  effectiveFrom?: Date;
  effectiveTo?: Date | null;
};

export type OperationalLocationPatch = {
  name?: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  countryCode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

export type OrganizationUnitTypePatch = {
  name?: string;
  description?: string | null;
};

export type ParsePatchResult<TPatch> =
  { ok: true; patch: TPatch } | { ok: false; errors: PatchFieldError[] };

export function parseOrganizationUnitPatch(
  body: Record<string, unknown>
): ParsePatchResult<OrganizationUnitPatch> {
  const errors: PatchFieldError[] = [];
  const patch: OrganizationUnitPatch = {};

  const name = readRequiredStringPatch(body, "name", errors);
  if (name !== undefined) patch.name = name;

  const legalEntityId = readNullableStringPatch(body, "legalEntityId", errors);
  if (legalEntityId !== undefined) patch.legalEntityId = legalEntityId;

  const unitTypeId = readNullableStringPatch(body, "unitTypeId", errors);
  if (unitTypeId !== undefined) patch.unitTypeId = unitTypeId;

  const effectiveFrom = readRequiredDatePatch(body, "effectiveFrom", errors);
  if (effectiveFrom !== undefined) patch.effectiveFrom = effectiveFrom;

  const effectiveTo = readNullableDatePatch(body, "effectiveTo", errors);
  if (effectiveTo !== undefined) patch.effectiveTo = effectiveTo;

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, patch };
}

export function mergeOrganizationUnitPatch(
  existing: UpdateOrganizationUnitInput,
  patch: OrganizationUnitPatch
): UpdateOrganizationUnitInput {
  return {
    name: patch.name === undefined ? existing.name : patch.name,
    legalEntityId:
      patch.legalEntityId === undefined
        ? existing.legalEntityId
        : patch.legalEntityId,
    unitTypeId:
      patch.unitTypeId === undefined ? existing.unitTypeId : patch.unitTypeId,
    effectiveFrom:
      patch.effectiveFrom === undefined
        ? existing.effectiveFrom
        : patch.effectiveFrom,
    effectiveTo:
      patch.effectiveTo === undefined ? existing.effectiveTo : patch.effectiveTo
  };
}

export function parseLegalEntityPatch(
  body: Record<string, unknown>
): ParsePatchResult<LegalEntityPatch> {
  const errors: PatchFieldError[] = [];
  const patch: LegalEntityPatch = {};

  const name = readRequiredStringPatch(body, "name", errors);
  if (name !== undefined) patch.name = name;

  const registrationIdentifier = readNullableStringPatch(
    body,
    "registrationIdentifier",
    errors
  );
  if (registrationIdentifier !== undefined) {
    patch.registrationIdentifier = registrationIdentifier;
  }

  const registrationIdentifierLabel = readNullableStringPatch(
    body,
    "registrationIdentifierLabel",
    errors
  );
  if (registrationIdentifierLabel !== undefined) {
    patch.registrationIdentifierLabel = registrationIdentifierLabel;
  }

  const effectiveFrom = readRequiredDatePatch(body, "effectiveFrom", errors);
  if (effectiveFrom !== undefined) patch.effectiveFrom = effectiveFrom;

  const effectiveTo = readNullableDatePatch(body, "effectiveTo", errors);
  if (effectiveTo !== undefined) patch.effectiveTo = effectiveTo;

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, patch };
}

export function mergeLegalEntityPatch(
  existing: UpdateLegalEntityInput,
  patch: LegalEntityPatch
): UpdateLegalEntityInput {
  return {
    name: patch.name === undefined ? existing.name : patch.name,
    registrationIdentifier:
      patch.registrationIdentifier === undefined
        ? existing.registrationIdentifier
        : patch.registrationIdentifier,
    registrationIdentifierLabel:
      patch.registrationIdentifierLabel === undefined
        ? existing.registrationIdentifierLabel
        : patch.registrationIdentifierLabel,
    effectiveFrom:
      patch.effectiveFrom === undefined
        ? existing.effectiveFrom
        : patch.effectiveFrom,
    effectiveTo:
      patch.effectiveTo === undefined ? existing.effectiveTo : patch.effectiveTo
  };
}

export function parseOperationalLocationPatch(
  body: Record<string, unknown>
): ParsePatchResult<OperationalLocationPatch> {
  const errors: PatchFieldError[] = [];
  const patch: OperationalLocationPatch = {};

  const name = readRequiredStringPatch(body, "name", errors);
  if (name !== undefined) patch.name = name;

  const addressLine1 = readNullableStringPatch(body, "addressLine1", errors);
  if (addressLine1 !== undefined) patch.addressLine1 = addressLine1;

  const addressLine2 = readNullableStringPatch(body, "addressLine2", errors);
  if (addressLine2 !== undefined) patch.addressLine2 = addressLine2;

  const city = readNullableStringPatch(body, "city", errors);
  if (city !== undefined) patch.city = city;

  const region = readNullableStringPatch(body, "region", errors);
  if (region !== undefined) patch.region = region;

  const postalCode = readNullableStringPatch(body, "postalCode", errors);
  if (postalCode !== undefined) patch.postalCode = postalCode;

  const countryCode = readNullableStringPatch(body, "countryCode", errors);
  if (countryCode !== undefined) patch.countryCode = countryCode;

  const latitude = readNullableNumberPatch(body, "latitude", errors);
  if (latitude !== undefined) patch.latitude = latitude;

  const longitude = readNullableNumberPatch(body, "longitude", errors);
  if (longitude !== undefined) patch.longitude = longitude;

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, patch };
}

export function mergeOperationalLocationPatch(
  existing: UpdateOperationalLocationInput,
  patch: OperationalLocationPatch
): UpdateOperationalLocationInput {
  return {
    name: patch.name === undefined ? existing.name : patch.name,
    addressLine1:
      patch.addressLine1 === undefined
        ? existing.addressLine1
        : patch.addressLine1,
    addressLine2:
      patch.addressLine2 === undefined
        ? existing.addressLine2
        : patch.addressLine2,
    city: patch.city === undefined ? existing.city : patch.city,
    region: patch.region === undefined ? existing.region : patch.region,
    postalCode:
      patch.postalCode === undefined ? existing.postalCode : patch.postalCode,
    countryCode:
      patch.countryCode === undefined
        ? existing.countryCode
        : patch.countryCode,
    latitude: patch.latitude === undefined ? existing.latitude : patch.latitude,
    longitude:
      patch.longitude === undefined ? existing.longitude : patch.longitude
  };
}

export function parseOrganizationUnitTypePatch(
  body: Record<string, unknown>
): ParsePatchResult<OrganizationUnitTypePatch> {
  const errors: PatchFieldError[] = [];
  const patch: OrganizationUnitTypePatch = {};

  const name = readRequiredStringPatch(body, "name", errors);
  if (name !== undefined) patch.name = name;

  const description = readNullableStringPatch(body, "description", errors);
  if (description !== undefined) patch.description = description;

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, patch };
}

export function mergeOrganizationUnitTypePatch(
  existing: UpdateOrganizationUnitTypeInput,
  patch: OrganizationUnitTypePatch
): UpdateOrganizationUnitTypeInput {
  return {
    name: patch.name === undefined ? existing.name : patch.name,
    description:
      patch.description === undefined ? existing.description : patch.description
  };
}
