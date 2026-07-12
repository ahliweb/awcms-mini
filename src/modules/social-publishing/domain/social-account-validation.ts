export type ValidationError = {
  field: string;
  message: string;
};

export type SocialAccountType =
  "page" | "profile" | "channel" | "group" | "organization";

export const SOCIAL_ACCOUNT_TYPES: readonly SocialAccountType[] = [
  "page",
  "profile",
  "channel",
  "group",
  "organization"
];

const PROVIDER_KEY_PATTERN = /^[a-z][a-z0-9_]{1,49}$/;

export function isValidProviderKey(value: string): boolean {
  return PROVIDER_KEY_PATTERN.test(value);
}

/**
 * Best-effort, defense-in-depth heuristic (Issue #643 §Security notes:
 * "Secret tokens are stored only as references to secret storage, not plain
 * text"). `token_reference` is meant to be an opaque pointer an operator or
 * a real secret manager mints (e.g. `"secretsmanager:social/fb-page-42"`,
 * `"env:SOCIAL_TOKEN_FB_PAGE_42"`, or a random reference id) — this
 * rejects values SHAPED like an actual bearer credential someone
 * accidentally pasted into the wrong field: a 3-segment JWT, a Facebook/
 * Meta `EAA...` graph token prefix, a Google OAuth `ya29.`/`1//` prefix, a
 * GitHub-style `ghp_`/`gho_` token, a Telegram Bot API token
 * (`<bot_id>:<35-char secret>`, e.g.
 * `"110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"` — checked explicitly
 * since Telegram is the next adapter this epic ships, Issue #646, so this
 * is a live gap for the very next provider, not a hypothetical one), or a
 * long (64+) high-entropy-looking hex/base64 blob that isn't shaped like a
 * known secret-storage reference convention.
 *
 * Round 1 security-auditor review (PR #731) found the original catch-all
 * blob check exempted ANY colon-containing string from the entropy
 * rejection (intended to whitelist `provider:id`/`env:VAR_NAME`-shaped
 * references) — which incidentally ALSO whitelisted a real Telegram bot
 * token, since that shape contains a colon too. Fixed two ways: (1) an
 * explicit Telegram-token-shaped rejection pattern below, checked before
 * the reference exemption; (2) the exemption itself narrowed from "any
 * colon-containing string" to `KNOWN_SECRET_REFERENCE_PREFIX_PATTERN`, an
 * explicit allow-list of reference prefixes this codebase's own examples
 * use — a value must actually look like one of those conventions to be
 * exempt, not merely contain a colon anywhere.
 *
 * Documented as best-effort, NOT foolproof — a sufficiently-determined
 * caller could still smuggle a raw secret past this (e.g. wrapped in a
 * plausible-looking reference string). It complements, never replaces,
 * "no real secret-storage integration ships in this issue" being a known,
 * documented residual (see this module's README/SKILL.md).
 */
const KNOWN_SECRET_REFERENCE_PREFIX_PATTERN =
  /^(secretsmanager|env|ref|vault|kms|ssm):/i;

export function looksLikeRawSecretToken(value: string): boolean {
  if (value.split(".").length === 3 && value.length > 40) {
    // JWT-shaped: header.payload.signature, each segment base64url.
    return true;
  }

  if (/^EAA[A-Za-z0-9]{20,}$/.test(value)) {
    return true;
  }

  if (/^(ya29\.|1\/\/)[A-Za-z0-9_-]{20,}$/.test(value)) {
    return true;
  }

  if (/^gh[a-z]_[A-Za-z0-9]{30,}$/.test(value)) {
    return true;
  }

  if (/^\d{6,10}:[A-Za-z0-9_-]{30,45}$/.test(value)) {
    // Telegram Bot API token shape — checked before the reference-prefix
    // exemption below so a real bot token is never exempted just because
    // it happens to contain a colon.
    return true;
  }

  if (
    /^[A-Za-z0-9+/:_-]{64,}={0,2}$/.test(value) &&
    !KNOWN_SECRET_REFERENCE_PREFIX_PATTERN.test(value)
  ) {
    // Charset deliberately INCLUDES `:` (unlike the original check) so a
    // long, colon-containing value is not silently exempted from the
    // entropy rejection purely because it contains a colon — it must
    // actually start with one of `KNOWN_SECRET_REFERENCE_PREFIX_PATTERN`'s
    // recognized prefixes to be exempt.
    return true;
  }

  return false;
}

export type CreateSocialAccountInput = {
  providerKey: string;
  providerAccountId: string;
  providerAccountName: string;
  providerAccountType: SocialAccountType;
  tokenReference: string;
  scopes: string[];
  expiresAt: Date | null;
  autoPublishEnabled: boolean;
};

export type CreateSocialAccountValidationResult =
  | { valid: true; value: CreateSocialAccountInput }
  | { valid: false; errors: ValidationError[] };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseOptionalDate(
  value: unknown,
  field: string,
  errors: ValidationError[]
): Date | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    errors.push({ field, message: `${field} must be an ISO date string.` });
    return null;
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    errors.push({ field, message: `${field} is not a valid date.` });
    return null;
  }

  return parsed;
}

export function validateCreateSocialAccountInput(
  body: unknown
): CreateSocialAccountValidationResult {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];

  if (
    !isNonEmptyString(record.providerKey) ||
    !isValidProviderKey(record.providerKey)
  ) {
    errors.push({
      field: "providerKey",
      message: "providerKey is required and must match ^[a-z][a-z0-9_]{1,49}$."
    });
  }

  if (!isNonEmptyString(record.providerAccountId)) {
    errors.push({
      field: "providerAccountId",
      message: "providerAccountId is required."
    });
  } else if (record.providerAccountId.length > 200) {
    errors.push({
      field: "providerAccountId",
      message: "providerAccountId must be at most 200 characters."
    });
  }

  if (!isNonEmptyString(record.providerAccountName)) {
    errors.push({
      field: "providerAccountName",
      message: "providerAccountName is required."
    });
  } else if (record.providerAccountName.length > 200) {
    errors.push({
      field: "providerAccountName",
      message: "providerAccountName must be at most 200 characters."
    });
  }

  if (
    typeof record.providerAccountType !== "string" ||
    !SOCIAL_ACCOUNT_TYPES.includes(
      record.providerAccountType as SocialAccountType
    )
  ) {
    errors.push({
      field: "providerAccountType",
      message: `providerAccountType must be one of: ${SOCIAL_ACCOUNT_TYPES.join(", ")}.`
    });
  }

  if (!isNonEmptyString(record.tokenReference)) {
    errors.push({
      field: "tokenReference",
      message: "tokenReference is required."
    });
  } else if (record.tokenReference.length > 500) {
    errors.push({
      field: "tokenReference",
      message: "tokenReference must be at most 500 characters."
    });
  } else if (looksLikeRawSecretToken(record.tokenReference)) {
    errors.push({
      field: "tokenReference",
      message:
        "tokenReference looks like a raw access/refresh token or JWT, not a secret-storage reference. Store the real credential in your secret manager and pass only its reference here."
    });
  }

  let scopes: string[] = [];

  if (record.scopes !== undefined) {
    if (
      !Array.isArray(record.scopes) ||
      !record.scopes.every((scope) => typeof scope === "string")
    ) {
      errors.push({
        field: "scopes",
        message: "scopes must be an array of strings."
      });
    } else {
      scopes = record.scopes;
    }
  }

  const expiresAt = parseOptionalDate(record.expiresAt, "expiresAt", errors);

  const autoPublishEnabled =
    typeof record.autoPublishEnabled === "boolean"
      ? record.autoPublishEnabled
      : false;

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      providerKey: record.providerKey as string,
      providerAccountId: record.providerAccountId as string,
      providerAccountName: record.providerAccountName as string,
      providerAccountType: record.providerAccountType as SocialAccountType,
      tokenReference: record.tokenReference as string,
      scopes,
      expiresAt,
      autoPublishEnabled
    }
  };
}

export type UpdateSocialAccountAutoPublishInput = {
  autoPublishEnabled: boolean;
};

export type UpdateSocialAccountAutoPublishValidationResult =
  | { valid: true; value: UpdateSocialAccountAutoPublishInput }
  | { valid: false; errors: ValidationError[] };

export function validateUpdateSocialAccountAutoPublishInput(
  body: unknown
): UpdateSocialAccountAutoPublishValidationResult {
  const record = (body ?? {}) as Record<string, unknown>;

  if (typeof record.autoPublishEnabled !== "boolean") {
    return {
      valid: false,
      errors: [
        {
          field: "autoPublishEnabled",
          message: "autoPublishEnabled is required and must be a boolean."
        }
      ]
    };
  }

  return {
    valid: true,
    value: { autoPublishEnabled: record.autoPublishEnabled }
  };
}
