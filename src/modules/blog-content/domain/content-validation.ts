import { isValidSlug } from "./slug-policy";

export type ValidationError = {
  field: string;
  message: string;
};

/**
 * Core fields shared by posts and pages (doc issue #537 §Core Data Rules).
 * Lifecycle fields (`status`, `visibility`), SEO fields, and page-only
 * fields (`pageType`, `parentPageId`, `menuOrder`) are validated separately
 * (`post-status.ts`, `seo-validation.ts`) so each concern stays independently
 * testable — Issue #538/#539's create/update handlers compose all of them.
 */
export type BlogContentCoreInput = {
  title: string;
  slug: string;
  excerpt: string | null;
  contentJson: Record<string, unknown>;
  contentText: string;
  locale: string;
};

export type BlogContentCoreValidationResult =
  | { valid: true; value: BlogContentCoreInput }
  | { valid: false; errors: ValidationError[] };

const MAX_TITLE_LENGTH = 200;
const MAX_EXCERPT_LENGTH = 500;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateBlogContentCore(
  body: unknown
): BlogContentCoreValidationResult {
  const errors: ValidationError[] = [];
  const record = (body ?? {}) as Record<string, unknown>;

  if (!isNonEmptyString(record.title)) {
    errors.push({ field: "title", message: "title is required." });
  } else if (record.title.length > MAX_TITLE_LENGTH) {
    errors.push({
      field: "title",
      message: `title must be at most ${MAX_TITLE_LENGTH} characters.`
    });
  }

  if (!isNonEmptyString(record.slug)) {
    errors.push({ field: "slug", message: "slug is required." });
  } else if (!isValidSlug(record.slug)) {
    errors.push({
      field: "slug",
      message:
        "slug must be lowercase alphanumeric segments separated by single hyphens."
    });
  }

  if (
    record.excerpt !== undefined &&
    record.excerpt !== null &&
    (typeof record.excerpt !== "string" ||
      record.excerpt.length > MAX_EXCERPT_LENGTH)
  ) {
    errors.push({
      field: "excerpt",
      message: `excerpt must be a string of at most ${MAX_EXCERPT_LENGTH} characters.`
    });
  }

  if (
    typeof record.contentJson !== "object" ||
    record.contentJson === null ||
    Array.isArray(record.contentJson)
  ) {
    errors.push({
      field: "contentJson",
      message: "contentJson is required and must be an object."
    });
  }

  if (!isNonEmptyString(record.contentText)) {
    errors.push({ field: "contentText", message: "contentText is required." });
  }

  if (record.locale !== undefined && !isNonEmptyString(record.locale)) {
    errors.push({
      field: "locale",
      message: "locale must be a non-empty string when provided."
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      title: (record.title as string).trim(),
      slug: (record.slug as string).trim(),
      excerpt:
        record.excerpt === undefined || record.excerpt === null
          ? null
          : (record.excerpt as string).trim(),
      contentJson: record.contentJson as Record<string, unknown>,
      contentText: record.contentText as string,
      locale: isNonEmptyString(record.locale) ? record.locale.trim() : "id"
    }
  };
}
