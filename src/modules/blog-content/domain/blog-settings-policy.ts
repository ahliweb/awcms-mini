/**
 * `PATCH /api/v1/blog/settings` validator (Issue #543 §Settings Page).
 * `awcms_mini_blog_settings` (migration 026, Issue #537) already has typed
 * columns for `default_locale`/`default_visibility`/`posts_per_page`/
 * `seo_default_title`/`seo_default_description` — this issue is the first
 * to actually read/write them through an admin route. `blogTitle`,
 * `blogDescription`, `rssEnabled`, and `sitemapEnabled` have no dedicated
 * column (out of this issue's scope to add one — the table's existing
 * catch-all `settings jsonb` column is exactly for this), so they live
 * under that column instead. Partial-update shape, same convention as
 * `validateUpdateBlogPostInput`: only fields present in the body are
 * validated/copied.
 */
import { validateLocaleField } from "./content-validation";
import {
  isBlogContentVisibility,
  type BlogContentVisibility
} from "./post-status";

export type ValidationError = {
  field: string;
  message: string;
};

const MAX_BLOG_TITLE_LENGTH = 200;
const MAX_BLOG_DESCRIPTION_LENGTH = 500;
const MAX_SEO_TITLE_LENGTH = 200;
const MAX_SEO_DESCRIPTION_LENGTH = 300;
const MIN_POSTS_PER_PAGE = 1;
const MAX_POSTS_PER_PAGE = 100;

export type UpdateBlogSettingsInput = {
  blogTitle?: string;
  blogDescription?: string | null;
  postsPerPage?: number;
  rssEnabled?: boolean;
  sitemapEnabled?: boolean;
  defaultLocale?: string;
  defaultVisibility?: BlogContentVisibility;
  seoDefaultTitle?: string | null;
  seoDefaultDescription?: string | null;
};

export type UpdateBlogSettingsValidationResult =
  | { valid: true; value: UpdateBlogSettingsInput }
  | { valid: false; errors: ValidationError[] };

function validateOptionalBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
  requireNonEmpty: boolean
): ValidationError | null {
  if (value === null && !requireNonEmpty) {
    return null;
  }

  if (
    typeof value !== "string" ||
    (requireNonEmpty && value.trim().length === 0)
  ) {
    return {
      field,
      message: requireNonEmpty
        ? `${field} must be a non-empty string.`
        : `${field} must be a string or null.`
    };
  }

  if (value.length > maxLength) {
    return {
      field,
      message: `${field} must be at most ${maxLength} characters.`
    };
  }

  return null;
}

export function validateUpdateBlogSettingsInput(
  body: unknown
): UpdateBlogSettingsValidationResult {
  const errors: ValidationError[] = [];
  const record = (body ?? {}) as Record<string, unknown>;
  const value: UpdateBlogSettingsInput = {};

  if (record.blogTitle !== undefined) {
    const error = validateOptionalBoundedString(
      record.blogTitle,
      "blogTitle",
      MAX_BLOG_TITLE_LENGTH,
      true
    );
    if (error) {
      errors.push(error);
    } else {
      value.blogTitle = (record.blogTitle as string).trim();
    }
  }

  if (record.blogDescription !== undefined) {
    const error = validateOptionalBoundedString(
      record.blogDescription,
      "blogDescription",
      MAX_BLOG_DESCRIPTION_LENGTH,
      false
    );
    if (error) {
      errors.push(error);
    } else {
      value.blogDescription =
        record.blogDescription === null
          ? null
          : (record.blogDescription as string).trim();
    }
  }

  if (record.postsPerPage !== undefined) {
    if (
      typeof record.postsPerPage !== "number" ||
      !Number.isInteger(record.postsPerPage) ||
      record.postsPerPage < MIN_POSTS_PER_PAGE ||
      record.postsPerPage > MAX_POSTS_PER_PAGE
    ) {
      errors.push({
        field: "postsPerPage",
        message: `postsPerPage must be an integer between ${MIN_POSTS_PER_PAGE} and ${MAX_POSTS_PER_PAGE}.`
      });
    } else {
      value.postsPerPage = record.postsPerPage;
    }
  }

  if (record.rssEnabled !== undefined) {
    if (typeof record.rssEnabled !== "boolean") {
      errors.push({
        field: "rssEnabled",
        message: "rssEnabled must be a boolean."
      });
    } else {
      value.rssEnabled = record.rssEnabled;
    }
  }

  if (record.sitemapEnabled !== undefined) {
    if (typeof record.sitemapEnabled !== "boolean") {
      errors.push({
        field: "sitemapEnabled",
        message: "sitemapEnabled must be a boolean."
      });
    } else {
      value.sitemapEnabled = record.sitemapEnabled;
    }
  }

  if (record.defaultLocale !== undefined) {
    const error = validateLocaleField(record.defaultLocale);
    if (error) {
      errors.push({ field: "defaultLocale", message: error.message });
    } else {
      value.defaultLocale = (record.defaultLocale as string).trim();
    }
  }

  if (record.defaultVisibility !== undefined) {
    if (!isBlogContentVisibility(record.defaultVisibility)) {
      errors.push({
        field: "defaultVisibility",
        message: "defaultVisibility must be one of public, private, unlisted."
      });
    } else {
      value.defaultVisibility = record.defaultVisibility;
    }
  }

  if (record.seoDefaultTitle !== undefined) {
    const error = validateOptionalBoundedString(
      record.seoDefaultTitle,
      "seoDefaultTitle",
      MAX_SEO_TITLE_LENGTH,
      false
    );
    if (error) {
      errors.push(error);
    } else {
      value.seoDefaultTitle =
        record.seoDefaultTitle === null
          ? null
          : (record.seoDefaultTitle as string).trim();
    }
  }

  if (record.seoDefaultDescription !== undefined) {
    const error = validateOptionalBoundedString(
      record.seoDefaultDescription,
      "seoDefaultDescription",
      MAX_SEO_DESCRIPTION_LENGTH,
      false
    );
    if (error) {
      errors.push(error);
    } else {
      value.seoDefaultDescription =
        record.seoDefaultDescription === null
          ? null
          : (record.seoDefaultDescription as string).trim();
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, value };
}
