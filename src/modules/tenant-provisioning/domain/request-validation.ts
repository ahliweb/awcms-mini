/**
 * Provisioning request input types + value validation (Issue #872). Shape/type
 * coercion is the parser's job (`application/request-parsing.ts`, fail-closed
 * tri-state); this file validates VALUE VALIDITY (formats, bounds, known plan)
 * and runs after parsing. Pure — no I/O. The owner password is the ONLY secret
 * in the input; it is never stored raw (hashed by `createTenantOwner`) and
 * never included verbatim in the idempotency hash or any log (ADR-0022 §6/§8).
 */
import { getProvisioningPlan } from "./provisioning-plan";

export type ProvisioningOwnerInput = {
  displayName: string;
  loginIdentifier: string;
  password: string;
};

export type ProvisioningOptionsInput = {
  defaultLocale: string | null;
  defaultTheme: string | null;
  timezone: string | null;
  /** Optional subdomain to request via the provider step (LAN/offline: absent → step skipped). */
  subdomain: string | null;
  /** Optional module activation preset key. */
  presetKey: string | null;
  /** Optional entitlement offer to assign (plan key + version in the service catalog). */
  offerPlanKey: string | null;
  offerVersion: number | null;
};

export type ProvisioningRequestInput = {
  planKey: string;
  planVersion: number;
  tenantCode: string;
  tenantName: string;
  legalName: string | null;
  owner: ProvisioningOwnerInput;
  officeCode: string;
  officeName: string;
  options: ProvisioningOptionsInput;
};

export type ProvisioningValidationError = { field: string; message: string };

const TENANT_CODE_RE = /^[a-z0-9][a-z0-9_-]*$/;
const CODE_RE = /^[a-z0-9][a-z0-9_-]*$/;
const KEY_RE = /^[a-z][a-z0-9_]*$/;
const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

function isNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= max;
}

export function validateProvisioningRequest(
  input: ProvisioningRequestInput
): ProvisioningValidationError[] {
  const errors: ProvisioningValidationError[] = [];

  if (!KEY_RE.test(input.planKey) || input.planKey.length > 100) {
    errors.push({ field: "planKey", message: "must be a lower_snake key" });
  }
  if (!Number.isInteger(input.planVersion) || input.planVersion < 1) {
    errors.push({
      field: "planVersion",
      message: "must be a positive integer"
    });
  }
  if (
    KEY_RE.test(input.planKey) &&
    Number.isInteger(input.planVersion) &&
    input.planVersion >= 1 &&
    !getProvisioningPlan(input.planKey, input.planVersion)
  ) {
    errors.push({
      field: "planKey",
      message: `no registered provisioning plan "${input.planKey}" v${input.planVersion}`
    });
  }

  if (!TENANT_CODE_RE.test(input.tenantCode) || input.tenantCode.length > 100) {
    errors.push({
      field: "tenantCode",
      message: "must match ^[a-z0-9][a-z0-9_-]* and be <= 100 chars"
    });
  }
  if (!isNonEmptyString(input.tenantName, 200)) {
    errors.push({ field: "tenantName", message: "required (1..200 chars)" });
  }
  if (input.legalName !== null && !isNonEmptyString(input.legalName, 200)) {
    errors.push({ field: "legalName", message: "must be a string (1..200)" });
  }

  if (!isNonEmptyString(input.owner.displayName, 200)) {
    errors.push({
      field: "owner.displayName",
      message: "required (1..200 chars)"
    });
  }
  if (!isNonEmptyString(input.owner.loginIdentifier, 320)) {
    errors.push({
      field: "owner.loginIdentifier",
      message: "required (1..320 chars)"
    });
  }
  if (
    typeof input.owner.password !== "string" ||
    input.owner.password.length < 8 ||
    input.owner.password.length > 200
  ) {
    errors.push({
      field: "owner.password",
      message: "required (8..200 chars)"
    });
  }

  if (!CODE_RE.test(input.officeCode) || input.officeCode.length > 100) {
    errors.push({ field: "officeCode", message: "must be a code" });
  }
  if (!isNonEmptyString(input.officeName, 200)) {
    errors.push({ field: "officeName", message: "required (1..200 chars)" });
  }

  const o = input.options;
  if (o.defaultLocale !== null && !LOCALE_RE.test(o.defaultLocale)) {
    errors.push({
      field: "options.defaultLocale",
      message: "must be a locale like en or id-ID"
    });
  }
  if (
    o.defaultTheme !== null &&
    !["light", "dark", "system"].includes(o.defaultTheme)
  ) {
    errors.push({
      field: "options.defaultTheme",
      message: "must be light/dark/system"
    });
  }
  if (o.timezone !== null && !isNonEmptyString(o.timezone, 64)) {
    errors.push({ field: "options.timezone", message: "must be a string" });
  }
  if (
    o.subdomain !== null &&
    (!SUBDOMAIN_RE.test(o.subdomain) || o.subdomain.length > 63)
  ) {
    errors.push({
      field: "options.subdomain",
      message: "must be a DNS label (<= 63 chars)"
    });
  }
  if (
    o.presetKey !== null &&
    (!KEY_RE.test(o.presetKey) || o.presetKey.length > 100)
  ) {
    errors.push({ field: "options.presetKey", message: "must be a key" });
  }
  // Entitlement offer: both or neither.
  if ((o.offerPlanKey === null) !== (o.offerVersion === null)) {
    errors.push({
      field: "options.offerPlanKey",
      message: "offerPlanKey and offerVersion must be provided together"
    });
  }
  if (
    o.offerPlanKey !== null &&
    (!KEY_RE.test(o.offerPlanKey) || o.offerPlanKey.length > 100)
  ) {
    errors.push({ field: "options.offerPlanKey", message: "must be a key" });
  }
  if (
    o.offerVersion !== null &&
    (!Number.isInteger(o.offerVersion) || o.offerVersion < 1)
  ) {
    errors.push({
      field: "options.offerVersion",
      message: "must be a positive integer"
    });
  }

  return errors;
}
