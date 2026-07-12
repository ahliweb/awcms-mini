export type ValidationError = {
  field: string;
  message: string;
};

const PROVIDER_KEY_PATTERN = /^[a-z][a-z0-9_]{1,49}$/;

/**
 * Recognized placeholders a `captionTemplate` may reference — rendered by
 * `social-publish-caption-renderer.ts` from a job's content snapshot
 * (`title`/`excerpt`/`canonicalUrl`). Plain-text substitution only (no
 * HTML, no script evaluation) — a caption is sent to an external social
 * API as plain text/markdown-ish caption content, never rendered as HTML
 * in this application, so there is no XSS surface here the way
 * `ads-directory.ts`'s `renderAdHtml` has to guard against.
 */
export const SOCIAL_PUBLISH_TEMPLATE_PLACEHOLDERS = [
  "{{title}}",
  "{{excerpt}}",
  "{{canonicalUrl}}"
] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export type CreateSocialPublishTemplateInput = {
  providerKey: string | null;
  name: string;
  captionTemplate: string;
  isDefault: boolean;
  isActive: boolean;
};

export type CreateSocialPublishTemplateValidationResult =
  | { valid: true; value: CreateSocialPublishTemplateInput }
  | { valid: false; errors: ValidationError[] };

export function validateCreateSocialPublishTemplateInput(
  body: unknown
): CreateSocialPublishTemplateValidationResult {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];

  let providerKey: string | null = null;

  if (record.providerKey !== undefined && record.providerKey !== null) {
    if (
      typeof record.providerKey !== "string" ||
      !PROVIDER_KEY_PATTERN.test(record.providerKey)
    ) {
      errors.push({
        field: "providerKey",
        message: "providerKey must match ^[a-z][a-z0-9_]{1,49}$ when provided."
      });
    } else {
      providerKey = record.providerKey;
    }
  }

  if (!isNonEmptyString(record.name)) {
    errors.push({ field: "name", message: "name is required." });
  } else if (record.name.length > 200) {
    errors.push({
      field: "name",
      message: "name must be at most 200 characters."
    });
  }

  if (!isNonEmptyString(record.captionTemplate)) {
    errors.push({
      field: "captionTemplate",
      message: "captionTemplate is required."
    });
  } else if (record.captionTemplate.length > 2000) {
    errors.push({
      field: "captionTemplate",
      message: "captionTemplate must be at most 2000 characters."
    });
  }

  const isDefault =
    typeof record.isDefault === "boolean" ? record.isDefault : false;
  const isActive =
    typeof record.isActive === "boolean" ? record.isActive : true;

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      providerKey,
      name: record.name as string,
      captionTemplate: record.captionTemplate as string,
      isDefault,
      isActive
    }
  };
}

export type UpdateSocialPublishTemplateInput = {
  name?: string;
  captionTemplate?: string;
  isDefault?: boolean;
  isActive?: boolean;
};

export type UpdateSocialPublishTemplateValidationResult =
  | { valid: true; value: UpdateSocialPublishTemplateInput }
  | { valid: false; errors: ValidationError[] };

export function validateUpdateSocialPublishTemplateInput(
  body: unknown
): UpdateSocialPublishTemplateValidationResult {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];
  const value: UpdateSocialPublishTemplateInput = {};

  if (record.name !== undefined) {
    if (!isNonEmptyString(record.name) || record.name.length > 200) {
      errors.push({
        field: "name",
        message: "name must be a non-empty string of at most 200 characters."
      });
    } else {
      value.name = record.name;
    }
  }

  if (record.captionTemplate !== undefined) {
    if (
      !isNonEmptyString(record.captionTemplate) ||
      record.captionTemplate.length > 2000
    ) {
      errors.push({
        field: "captionTemplate",
        message:
          "captionTemplate must be a non-empty string of at most 2000 characters."
      });
    } else {
      value.captionTemplate = record.captionTemplate;
    }
  }

  if (record.isDefault !== undefined) {
    if (typeof record.isDefault !== "boolean") {
      errors.push({
        field: "isDefault",
        message: "isDefault must be a boolean."
      });
    } else {
      value.isDefault = record.isDefault;
    }
  }

  if (record.isActive !== undefined) {
    if (typeof record.isActive !== "boolean") {
      errors.push({
        field: "isActive",
        message: "isActive must be a boolean."
      });
    } else {
      value.isActive = record.isActive;
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, value };
}

/**
 * Plain-text placeholder substitution — `{{title}}`/`{{excerpt}}`/
 * `{{canonicalUrl}}` replaced verbatim (no escaping needed/applied: the
 * output is a plain-text social caption, never HTML). Unrecognized
 * `{{...}}` tokens are left as-is (not stripped) so an operator notices a
 * typo'd placeholder rather than silently losing it.
 */
export function renderSocialPublishCaption(
  captionTemplate: string,
  values: { title: string; excerpt: string; canonicalUrl: string }
): string {
  return captionTemplate
    .replaceAll("{{title}}", values.title)
    .replaceAll("{{excerpt}}", values.excerpt)
    .replaceAll("{{canonicalUrl}}", values.canonicalUrl);
}
