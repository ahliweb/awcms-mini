/**
 * `awcms_mini_blog_settings` read/write (Issue #543 §Settings Page) — one
 * row per tenant, same upsert convention `theme-settings-directory.ts`
 * (Issue #542) uses for `awcms_mini_blog_theme_settings`. `blogTitle`,
 * `blogDescription`, `rssEnabled`, `sitemapEnabled` are stored in the
 * table's catch-all `settings jsonb` column (see `blog-settings-policy.ts`
 * header comment for why); everything else has its own typed column
 * already seeded by migration 026.
 */
import type { UpdateBlogSettingsInput } from "../domain/blog-settings-policy";
import type { BlogContentVisibility } from "../domain/post-status";
import {
  isOverridableChecklistRuleId,
  isValidChecklistSeverity,
  type ChecklistPolicyOverrides
} from "../domain/content-quality-checklist";

export type BlogSettingsView = {
  tenantId: string;
  blogTitle: string;
  blogDescription: string | null;
  postsPerPage: number;
  rssEnabled: boolean;
  sitemapEnabled: boolean;
  defaultLocale: string;
  defaultVisibility: BlogContentVisibility;
  seoDefaultTitle: string | null;
  seoDefaultDescription: string | null;
  /** Issue #640 — tenant override of the content quality checklist's non-security rule severities; `{}` when the tenant never configured one (checklist falls back to its own defaults). */
  contentQualityChecklistPolicy: ChecklistPolicyOverrides;
  updatedAt: string | null;
};

const DEFAULT_BLOG_TITLE = "Blog";
const DEFAULT_POSTS_PER_PAGE = 10;

type BlogSettingsRow = {
  tenant_id: string;
  default_locale: string;
  default_visibility: BlogContentVisibility;
  posts_per_page: number;
  seo_default_title: string | null;
  seo_default_description: string | null;
  settings: Record<string, unknown>;
  updated_at: Date;
};

/**
 * Filters a raw stored `contentQualityChecklistPolicy` blob down to only
 * entries that are BOTH a genuinely overridable (non-security) rule id and
 * a real `ChecklistSeverity` value — reviewer/security-auditor finding on
 * PR #725: the write side (`blog-settings-policy.ts`) already rejects an
 * invalid entry with a 400, but the read side previously only checked
 * "is this an object," trusting its shape and contents unconditionally.
 * Since the only path that can ever WRITE this column already validates,
 * this is defense-in-depth against a future direct DB write/migration/
 * refactor bypassing that single write-time gate — same "don't trust a
 * single enforcement point" lesson as Issue #636's revision-restore fix.
 */
function sanitizeChecklistPolicyOverrides(
  raw: unknown
): ChecklistPolicyOverrides {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }

  const sanitized: ChecklistPolicyOverrides = {};

  for (const [ruleId, severity] of Object.entries(
    raw as Record<string, unknown>
  )) {
    if (
      isOverridableChecklistRuleId(ruleId) &&
      isValidChecklistSeverity(severity)
    ) {
      sanitized[ruleId] = severity;
    }
  }

  return sanitized;
}

function toView(
  tenantId: string,
  row: BlogSettingsRow | null
): BlogSettingsView {
  const extras = row?.settings ?? {};

  return {
    tenantId,
    blogTitle:
      typeof extras.blogTitle === "string"
        ? extras.blogTitle
        : DEFAULT_BLOG_TITLE,
    blogDescription:
      typeof extras.blogDescription === "string"
        ? extras.blogDescription
        : null,
    postsPerPage: row?.posts_per_page ?? DEFAULT_POSTS_PER_PAGE,
    rssEnabled: extras.rssEnabled !== false,
    sitemapEnabled: extras.sitemapEnabled !== false,
    defaultLocale: row?.default_locale ?? "id",
    defaultVisibility: row?.default_visibility ?? "public",
    seoDefaultTitle: row?.seo_default_title ?? null,
    seoDefaultDescription: row?.seo_default_description ?? null,
    contentQualityChecklistPolicy: sanitizeChecklistPolicyOverrides(
      extras.contentQualityChecklistPolicy
    ),
    updatedAt: row?.updated_at.toISOString() ?? null
  };
}

/** `null` row (tenant never configured settings) still returns a full view built from defaults — same "missing row = default" convention `fetchPublicBlogSettings` already uses. */
export async function fetchBlogSettings(
  tx: Bun.SQL,
  tenantId: string
): Promise<BlogSettingsView> {
  const rows = (await tx`
    SELECT tenant_id, default_locale, default_visibility, posts_per_page,
           seo_default_title, seo_default_description, settings, updated_at
    FROM awcms_mini_blog_settings
    WHERE tenant_id = ${tenantId}
  `) as BlogSettingsRow[];

  return toView(tenantId, rows[0] ?? null);
}

/**
 * Upsert — merges `patch` onto the existing row (typed columns overwritten
 * only when present in `patch`; `blogTitle`/`blogDescription`/`rssEnabled`/
 * `sitemapEnabled` shallow-merged into the existing `settings` jsonb blob,
 * same merge-patch semantics `updateModuleSettings` uses).
 */
export async function upsertBlogSettings(
  tx: Bun.SQL,
  tenantId: string,
  patch: UpdateBlogSettingsInput
): Promise<BlogSettingsView> {
  const existing = await fetchBlogSettings(tx, tenantId);

  const defaultLocale = patch.defaultLocale ?? existing.defaultLocale;
  const defaultVisibility =
    patch.defaultVisibility ?? existing.defaultVisibility;
  const postsPerPage = patch.postsPerPage ?? existing.postsPerPage;
  const seoDefaultTitle =
    patch.seoDefaultTitle !== undefined
      ? patch.seoDefaultTitle
      : existing.seoDefaultTitle;
  const seoDefaultDescription =
    patch.seoDefaultDescription !== undefined
      ? patch.seoDefaultDescription
      : existing.seoDefaultDescription;

  const extras = {
    blogTitle: patch.blogTitle ?? existing.blogTitle,
    blogDescription:
      patch.blogDescription !== undefined
        ? patch.blogDescription
        : existing.blogDescription,
    rssEnabled: patch.rssEnabled ?? existing.rssEnabled,
    sitemapEnabled: patch.sitemapEnabled ?? existing.sitemapEnabled,
    contentQualityChecklistPolicy:
      patch.contentQualityChecklistPolicy ??
      existing.contentQualityChecklistPolicy
  };

  const rows = (await tx`
    INSERT INTO awcms_mini_blog_settings
      (tenant_id, default_locale, default_visibility, posts_per_page,
       seo_default_title, seo_default_description, settings, updated_at)
    VALUES
      (${tenantId}, ${defaultLocale}, ${defaultVisibility}, ${postsPerPage},
       ${seoDefaultTitle}, ${seoDefaultDescription}, ${extras}, now())
    ON CONFLICT (tenant_id) DO UPDATE SET
      default_locale = EXCLUDED.default_locale,
      default_visibility = EXCLUDED.default_visibility,
      posts_per_page = EXCLUDED.posts_per_page,
      seo_default_title = EXCLUDED.seo_default_title,
      seo_default_description = EXCLUDED.seo_default_description,
      settings = EXCLUDED.settings,
      updated_at = now()
    RETURNING tenant_id, default_locale, default_visibility, posts_per_page,
              seo_default_title, seo_default_description, settings, updated_at
  `) as BlogSettingsRow[];

  return toView(tenantId, rows[0] ?? null);
}
