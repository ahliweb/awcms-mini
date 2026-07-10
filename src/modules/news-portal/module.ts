import { defineModule } from "../_shared/module-contract";

export const newsPortalModule = defineModule({
  key: "news_portal",
  name: "News Portal",
  version: "0.1.0",
  status: "active",
  description:
    "Editorial + media layer conceptually on top of blog_content/tenant_domain/visitor_analytics for a full-online, R2-only public news portal (epic `news_portal` #631-#642/#649). Issue #632 (this descriptor) adds ONLY the tenant module preset `news_portal_full_online_r2` (`module-management/domain/module-presets.ts`) and its activation readiness gate (`domain/news-portal-preset-readiness.ts`, `domain/news-media-r2-config.ts`, `application/apply-news-portal-preset.ts`) — no media object registry (#633), no upload endpoint (#634), no permissions/navigation/API of its own yet. Registered now (rather than deferred to a later issue) because the preset needs a real module key to enable/disable, matching `tenant_domain`'s own precedent (Issue #558 registered the descriptor ahead of its resolver/routes/admin UI). `permissions`/`navigation`/`api`/`settings`/`jobs`/`health` are deliberately left undeclared until the corresponding feature is real (same convention `visitor_analytics`, Issue #617, documented in its own module.ts test). `dependencies` deliberately does NOT list blog_content/tenant_domain/visitor_analytics despite the prose relationship above: this module has zero functional code importing/calling into any of them yet, and `blog_content`/`tenant_domain` themselves only depend on foundation modules (never on each other) for the exact same reason (see their own module.ts) — declaring a hard dependency here would make the reverse-dependency guard (`evaluateModuleDisable`'s MODULE_REVERSE_DEPENDENCY_ACTIVE) block disabling blog_content/tenant_domain/visitor_analytics for EVERY tenant (news_portal is enabled by default like every module), which broke existing integration tests when first tried (see git history/PR discussion) and is not something #632's own scope justifies. The preset's own `enabledModuleKeys` ordering (`module-management/domain/module-presets.ts`'s `planEnableOrder`) is what sequences enabling blog_content/tenant_domain/visitor_analytics before news_portal WITHIN one preset application — a permanent hard dependency is not needed for that.",
  dependencies: ["tenant_admin", "identity_access"],
  type: "domain"
});
