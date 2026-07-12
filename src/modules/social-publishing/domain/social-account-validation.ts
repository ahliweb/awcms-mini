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
 * ## Round 1 -> round 2 security-auditor history (PR #731) — read before
 * touching this function again
 *
 * Round 1 found the original catch-all blob check exempted ANY
 * colon-containing string from the entropy rejection (intended to
 * whitelist `provider:id`/`env:VAR_NAME`-shaped references) — which
 * incidentally ALSO whitelisted a real Telegram bot token, since that
 * shape contains a colon too. First fix attempt: added an explicit
 * Telegram-token-shaped rejection pattern, and replaced the blanket
 * "exempt any colon-containing string" with a `KNOWN_SECRET_REFERENCE_
 * PREFIX_PATTERN` allow-list, applied by exempting the WHOLE string from
 * every check whenever it started with a recognized prefix.
 *
 * Round 2 proved that "whole string" exemption was itself a NEW, easier
 * bypass: every shape check here (JWT excepted) is anchored with `^` —
 * they test "does the value START WITH this known-bad shape." Prepending
 * ANY recognized prefix (e.g. `env:` — literally the string this
 * endpoint's own validation error tells a rejected caller to use) makes a
 * real `EAA...`/`ya29....`/`gh_...`/Telegram-shaped token no longer START
 * WITH that shape, so every anchored regex naturally stops matching —
 * concretely reproduced for all four provider shapes prefixed with
 * `env:`/`secretsmanager:`. Only the JWT check survived (it counts
 * dot-separated segments, not a fixed literal prefix).
 *
 * Fixed by NOT exempting the whole string at all: `looksLikeRawSecretToken`
 * strips at most `MAX_REFERENCE_PREFIX_STRIPS` recognized reference
 * prefixes one at a time and re-runs the SAME shape checks
 * (`matchesKnownRawSecretShape`) against whatever remains after each
 * strip — a `env:`/`secretsmanager:`-style prefix only ever exempts a
 * short, low-entropy remainder (an env var name, a short path segment)
 * from the entropy catch-all; it can never exempt a remainder that itself
 * still looks like a raw JWT/EAA/ya29/gh_/Telegram token, no matter how
 * many recognized prefixes are stacked in front of it. Exhausting the
 * strip budget without reaching a clean, non-secret-shaped remainder is
 * itself treated as suspicious (a legitimate reference should never need
 * more than one, maybe two, nested prefixes).
 *
 * Documented as best-effort, NOT foolproof — a sufficiently-determined
 * caller could still smuggle a raw secret past this (e.g. wrapped in some
 * shape this function doesn't yet recognize). It complements, never
 * replaces, "no real secret-storage integration ships in this issue"
 * being a known, documented residual (see this module's README/SKILL.md).
 */
const KNOWN_SECRET_REFERENCE_PREFIX_PATTERN =
  /^(secretsmanager|env|ref|vault|kms|ssm):/i;

/** A legitimate reference should never need more nested prefixes than this — exhausting the budget is itself treated as suspicious (see `looksLikeRawSecretToken`). */
const MAX_REFERENCE_PREFIX_STRIPS = 5;

/**
 * The actual shape checks, applied identically whether `value` is the
 * caller's original, unprefixed input OR the remainder left after
 * stripping one or more recognized reference prefixes. Never applies any
 * prefix-based exemption itself — that logic lives only in
 * `looksLikeRawSecretToken`, which decides WHEN to call this (on the raw
 * value, and again on each successively-stripped remainder).
 */
function matchesKnownRawSecretShape(value: string): boolean {
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
    // Telegram Bot API token shape.
    return true;
  }

  if (/^[A-Za-z0-9+/:_-]{64,}={0,2}$/.test(value)) {
    // Long, high-entropy-looking blob — charset includes `:` so a value
    // is never exempted from this purely for containing one; the only
    // way a colon-containing value avoids this check is via the
    // recognized-prefix-strip-and-recheck flow in
    // `looksLikeRawSecretToken`, never here.
    return true;
  }

  return false;
}

export function looksLikeRawSecretToken(value: string): boolean {
  let remainder = value;

  for (let strips = 0; strips <= MAX_REFERENCE_PREFIX_STRIPS; strips += 1) {
    if (matchesKnownRawSecretShape(remainder)) {
      return true;
    }

    const prefixMatch = remainder.match(KNOWN_SECRET_REFERENCE_PREFIX_PATTERN);

    if (!prefixMatch) {
      return false;
    }

    remainder = remainder.slice(prefixMatch[0].length);
  }

  // Exhausted the strip budget without the remainder ever resolving to
  // either a recognized raw-secret shape or a prefix-free, non-secret-
  // shaped value — too many nested reference prefixes for a legitimate
  // reference to plausibly need. Treat as suspicious.
  return true;
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
