import { defineModule } from "../_shared/module-contract";
import { NEWS_MEDIA_PERMISSION_ACTIVITY_CODE } from "./domain/news-media-permissions";

export const newsPortalModule = defineModule({
  key: "news_portal",
  name: "News Portal",
  version: "0.3.0",
  status: "active",
  description:
    "Editorial + media layer conceptually on top of blog_content/tenant_domain/visitor_analytics for a full-online, R2-only public news portal (epic `news_portal` #631-#642/#649). Issue #632 added ONLY the tenant module preset `news_portal_full_online_r2` (`module-management/domain/module-presets.ts`) and its activation readiness gate (`domain/news-portal-preset-readiness.ts`, `domain/news-media-r2-config.ts`, `application/apply-news-portal-preset.ts`). Issue #633 added the tenant-scoped R2-only media object registry (schema + domain/application helpers), permission constants only (not yet wired into this descriptor). Issue #634 adds the direct-to-R2 presigned upload flow — `POST /api/v1/media/news-images/upload-sessions` (create), `.../{id}/finalize` (real R2 `GET` + magic-byte MIME sniffing + server-side SHA-256 checksum, NOT `HEAD`-only — see `news-media-r2-verification.ts`), `.../{id}/cancel` — and is the first issue with a real HTTP surface, so `permissions`/`api` are now declared below (matching `NEWS_MEDIA_PERMISSIONS`, `news-media-permissions.ts`, exactly — see that file's own header for why #634 must reuse those constants rather than invent `media_objects.news_images.*` names from the issue's own body text). Issue #637 (this update) adds the editorial homepage section composer — `POST/GET /api/v1/news-portal/homepage-sections`, `PATCH/DELETE .../{id}` (`homepage_sections` activityCode, `read`/`configure` actions, same action pair `blog_content`'s ads/menus/widgets already use) plus a public composer (`homepage-section-composer.ts`) consumed by `/news/index.ts`, and its own admin UI page (`admin/news-portal/homepage-sections.astro`) — the first navigation-worthy admin screen this module ships, so `navigation` is now declared below too (one entry, same single-top-level-page-then-sub-navigation-inside-the-page convention `blog_content`'s single `/admin/blog` entry uses, even though this module only has one admin page so far). `settings`/`jobs`/`health` remain deliberately undeclared — no per-tenant setting, background job, or health check exists yet for this module specifically (same convention `visitor_analytics`, Issue #617, used before its own features landed). `dependencies` deliberately does NOT list blog_content/tenant_domain/visitor_analytics despite the prose relationship above: this module has zero functional code importing/calling into any of them yet, and `blog_content`/`tenant_domain` themselves only depend on foundation modules (never on each other) for the exact same reason (see their own module.ts) — declaring a hard dependency here would make the reverse-dependency guard (`evaluateModuleDisable`'s MODULE_REVERSE_DEPENDENCY_ACTIVE) block disabling blog_content/tenant_domain/visitor_analytics for EVERY tenant (news_portal is enabled by default like every module), which broke existing integration tests when first tried (see git history/PR discussion) and is not something #632's own scope justifies. The preset's own `enabledModuleKeys` ordering (`module-management/domain/module-presets.ts`'s `planEnableOrder`) is what sequences enabling blog_content/tenant_domain/visitor_analytics before news_portal WITHIN one preset application — a permanent hard dependency is not needed for that. Application code (`homepage-section-composer.ts`, `homepage-section-reference-validation.ts`) DOES import from `blog-content`'s application layer directly (posts/terms queries) — this is a normal cross-module TypeScript import, not the `dependencies` array above, which only governs enable/disable ordering/guards; Issue #636 already established the same cross-module import direction in reverse (`blog_content` importing from `news_portal`).",
  dependencies: ["tenant_admin", "identity_access"],
  type: "domain",
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/media/news-images"
  },
  navigation: [
    {
      labelKey: "admin.layout.nav_news_portal_homepage_sections",
      path: "/admin/news-portal/homepage-sections",
      order: 80,
      requiredPermission: "news_portal.homepage_sections.read"
    }
  ],
  permissions: [
    {
      activityCode: "homepage_sections",
      action: "read",
      description: "Read editorial homepage section configuration"
    },
    {
      activityCode: "homepage_sections",
      action: "configure",
      description:
        "Create, update, reorder, enable/disable, or delete editorial homepage sections"
    },
    {
      activityCode: NEWS_MEDIA_PERMISSION_ACTIVITY_CODE,
      action: "create",
      description:
        "Create a pending news media object / start a presigned upload session"
    },
    {
      activityCode: NEWS_MEDIA_PERMISSION_ACTIVITY_CODE,
      action: "read",
      description: "Read news media object metadata"
    },
    {
      activityCode: NEWS_MEDIA_PERMISSION_ACTIVITY_CODE,
      action: "verify",
      description: "Finalize/verify an uploaded news media object"
    },
    {
      activityCode: NEWS_MEDIA_PERMISSION_ACTIVITY_CODE,
      action: "attach",
      description: "Attach a verified news media object to an owning resource"
    },
    {
      activityCode: NEWS_MEDIA_PERMISSION_ACTIVITY_CODE,
      action: "detach",
      description: "Detach a news media object from its owning resource"
    },
    {
      activityCode: NEWS_MEDIA_PERMISSION_ACTIVITY_CODE,
      action: "delete",
      description: "Soft delete news media object metadata"
    },
    {
      activityCode: NEWS_MEDIA_PERMISSION_ACTIVITY_CODE,
      action: "restore",
      description: "Restore a soft-deleted news media object"
    },
    {
      activityCode: NEWS_MEDIA_PERMISSION_ACTIVITY_CODE,
      action: "purge",
      description: "Hard purge an already soft-deleted news media object"
    },
    {
      activityCode: NEWS_MEDIA_PERMISSION_ACTIVITY_CODE,
      action: "cancel",
      description: "Cancel one's own not-yet-uploaded news media upload session"
    }
  ]
});
