/**
 * Fail-closed defensive parsing of the untrusted provisioning-request body
 * (Issue #872, epic pattern #6). Same discipline the `service_catalog` /
 * `tenant_entitlement` parsers prove:
 *   - ABSENT scalar/number field -> its neutral default (NaN for a required
 *     number so the validator rejects it, never a silent 0);
 *   - PRESENT field -> kept VERBATIM so the domain validator rejects a wrong
 *     type/value (400) — NEVER coerced to a valid default;
 *   - nullable field -> tri-state: absent -> null; present -> verbatim (a wrong
 *     type is rejected by the validator, never coerced to null = silent clear);
 *   - PRESENT-but-not-an-object `owner`/`options` -> `{}` so the validator's
 *     required-field checks fail (never a partial silent default).
 * Parsing only shapes/coerces types; VALUE validity is `domain/request-
 * validation.ts`. The owner password is passed through untouched and never
 * logged.
 */
import type {
  ProvisioningOptionsInput,
  ProvisioningOwnerInput,
  ProvisioningRequestInput
} from "../domain/request-validation";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumberVerbatim(value: unknown): number {
  return typeof value === "number" ? value : NaN;
}

/** Tri-state nullable: absent -> null; present -> verbatim (validator rejects a wrong type; never coerced to null). */
function nullable(record: Record<string, unknown>, key: string): unknown {
  return key in record ? record[key] : null;
}

function parseOwner(value: unknown): ProvisioningOwnerInput {
  const record = asRecord(value);
  return {
    displayName: asString(record.displayName),
    loginIdentifier: asString(record.loginIdentifier),
    // Kept verbatim (never coerced/logged) — the validator enforces length.
    password: typeof record.password === "string" ? record.password : ""
  };
}

function parseOptions(value: unknown): ProvisioningOptionsInput {
  const record = asRecord(value);
  return {
    defaultLocale: nullable(record, "defaultLocale") as string | null,
    defaultTheme: nullable(record, "defaultTheme") as string | null,
    timezone: nullable(record, "timezone") as string | null,
    subdomain: nullable(record, "subdomain") as string | null,
    presetKey: nullable(record, "presetKey") as string | null,
    offerPlanKey: nullable(record, "offerPlanKey") as string | null,
    offerVersion:
      "offerVersion" in record ? (record.offerVersion as number | null) : null
  };
}

export function parseProvisioningRequestBody(
  body: unknown
): ProvisioningRequestInput {
  const record = asRecord(body);
  return {
    planKey: asString(record.planKey),
    planVersion: asNumberVerbatim(record.planVersion),
    tenantCode: asString(record.tenantCode),
    tenantName: asString(record.tenantName),
    legalName: nullable(record, "legalName") as string | null,
    owner: parseOwner(record.owner),
    officeCode: asString(record.officeCode),
    officeName: asString(record.officeName),
    options: parseOptions(record.options)
  };
}

/** Optional `{ reason }` body for cancel — nullable, fail-closed. */
export function parseCancelBody(body: unknown): { reason: string | null } {
  const record = asRecord(body);
  return { reason: nullable(record, "reason") as string | null };
}
