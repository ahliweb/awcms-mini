/**
 * Sanctioned entry point for activating the `news_portal_full_online_r2`
 * module preset (Issue #632, epic `news_portal`). Wraps
 * `module-management/application/module-presets.ts`'s generic
 * `applyModulePreset` with a readiness gate this preset's activation
 * requires (`domain/news-portal-preset-readiness.ts`) — the generic
 * engine deliberately has zero knowledge of R2/media (it only ever
 * receives plain `ModuleDescriptor[]` data, never imports a concrete
 * domain module — see `module-management/domain/module-presets.ts`'s own
 * header comment), so this gate cannot live there without breaking that
 * separation.
 *
 * IMPORTANT for future callers (#633 onward, any future setup-wizard/API
 * step that lets an operator apply a preset): call
 * `applyNewsPortalFullOnlineR2Preset` for this specific preset name, never
 * `applyModulePreset(tx, tenantId, actor, "news_portal_full_online_r2")`
 * directly — the generic function has no way to enforce this gate itself.
 * As of this issue nothing calls `applyModulePreset` from any HTTP route
 * (module-presets.ts's own header comment: "no HTTP route in this issue")
 * so there is no real bypass surface in production today; this comment
 * exists to keep it that way.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { applyModulePreset } from "../../module-management/application/module-presets";
import type { ApplyModulePresetResult } from "../../module-management/application/module-presets";
import { markFullOnlineR2ModeApplied } from "./news-portal-tenant-state";
import { evaluateNewsPortalFullOnlineR2Readiness } from "../domain/news-portal-preset-readiness";

export const NEWS_PORTAL_FULL_ONLINE_R2_PRESET_NAME =
  "news_portal_full_online_r2";

export type ApplyNewsPortalFullOnlineR2PresetResult =
  | ({ outcome: "applied" } & Omit<
      Extract<ApplyModulePresetResult, { outcome: "applied" }>,
      "outcome"
    >)
  | {
      outcome: "rejected";
      code: "NEWS_PORTAL_PRESET_NOT_READY";
      reasons: string[];
      detail: string[];
    }
  | {
      outcome: "rejected";
      code: "MODULE_PRESET_NOT_FOUND";
      reasons: string[];
      detail: string[];
    };

/**
 * Evaluates readiness first (pure, no I/O); on failure, records an audit
 * event (`news_portal_preset_activation_rejected`, severity `warning` —
 * this is a "security readiness decision" per skill
 * `awcms-mini-audit-log`) and returns rejected WITHOUT touching any module
 * enable/disable state. On success, delegates to the existing, generic
 * `applyModulePreset` (which itself audits each individual module
 * enable/disable — see `module-management/application/module-presets.ts`)
 * and additionally records one more audit event confirming the gate
 * passed, so "why was this tenant allowed into full-online R2-only mode"
 * is answerable from the audit log alone, not just inferred from module
 * enable events.
 */
export async function applyNewsPortalFullOnlineR2Preset(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  env: NodeJS.ProcessEnv = process.env,
  correlationId?: string | null
): Promise<ApplyNewsPortalFullOnlineR2PresetResult> {
  const readiness = evaluateNewsPortalFullOnlineR2Readiness(env);

  if (!readiness.ready) {
    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId,
      moduleKey: "news_portal",
      action: "news_portal_preset_activation_rejected",
      resourceType: "tenant_module_preset",
      resourceId: NEWS_PORTAL_FULL_ONLINE_R2_PRESET_NAME,
      severity: "warning",
      message: `Activation of preset "${NEWS_PORTAL_FULL_ONLINE_R2_PRESET_NAME}" blocked: ${readiness.reasons.join(", ")}.`,
      attributes: { reasons: readiness.reasons, detail: readiness.detail },
      correlationId: correlationId ?? undefined
    });

    return {
      outcome: "rejected",
      code: "NEWS_PORTAL_PRESET_NOT_READY",
      reasons: readiness.reasons,
      detail: readiness.detail
    };
  }

  const result = await applyModulePreset(
    tx,
    tenantId,
    actorTenantUserId,
    NEWS_PORTAL_FULL_ONLINE_R2_PRESET_NAME,
    correlationId
  );

  if (result.outcome === "applied") {
    // `applyModulePreset`'s top-level `outcome: "applied"` does NOT mean
    // every module in the preset's list actually ended up enabled — a
    // per-module rejection (e.g. `MODULE_DEPENDENCY_MISSING`/
    // `MODULE_DEPENDENCY_DISABLED`) is recorded inside `result.changes[]`
    // without changing the top-level outcome (reviewer finding, PR #666
    // re-review). What #636's tenant-scoped gate actually depends on is
    // narrowly "did `news_portal` itself end up enabled" — an unrelated
    // bundled module (e.g. `visitor_analytics`) failing because of ITS OWN
    // unrelated dependency (e.g. `logging` disabled) is a real, common
    // occurrence (confirmed by this repo's own existing preset
    // integration test fixture) that must NOT block the R2-only marker
    // for a tenant whose `news_portal` enable genuinely succeeded — only
    // a rejection of `news_portal`'s OWN change entry means the tenant is
    // not actually in the state this marker claims.
    const newsPortalChange = result.changes.find(
      (change) => change.moduleKey === "news_portal"
    );
    const newsPortalRejected = newsPortalChange?.outcome === "rejected";

    if (newsPortalRejected) {
      await recordAuditEvent(tx, {
        tenantId,
        actorTenantUserId,
        moduleKey: "news_portal",
        action: "news_portal_preset_partially_applied",
        resourceType: "tenant_module_preset",
        resourceId: NEWS_PORTAL_FULL_ONLINE_R2_PRESET_NAME,
        severity: "warning",
        message: `Preset "${NEWS_PORTAL_FULL_ONLINE_R2_PRESET_NAME}" was accepted by the generic engine, but news_portal's own module enable was rejected. Full-online R2-only mode is NOT considered active for this tenant until re-applied cleanly.`,
        attributes: {
          changes: result.changes,
          skipped: result.skipped.length
        },
        correlationId: correlationId ?? undefined
      });

      return result;
    }

    // Persist the genuine "this tenant applied the preset" signal — a
    // dedicated, non-tenant-writable table (migration `043`, see its
    // header for why this is a brand-new table rather than reusing
    // `awcms_mini_tenant_modules`/`awcms_mini_module_settings`, both tried
    // and both found exploitable/useless in review). Set unconditionally
    // on every fully successful application (including a re-application
    // that finds every module already `already_satisfied`) so the
    // timestamp always reflects the most recent confirmed-ready
    // activation.
    await markFullOnlineR2ModeApplied(tx, tenantId);

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId,
      moduleKey: "news_portal",
      action: "news_portal_preset_activated",
      resourceType: "tenant_module_preset",
      resourceId: NEWS_PORTAL_FULL_ONLINE_R2_PRESET_NAME,
      severity: "info",
      message: `Preset "${NEWS_PORTAL_FULL_ONLINE_R2_PRESET_NAME}" activated (full-online R2-only readiness gate passed).`,
      attributes: {
        changes: result.changes.length,
        skipped: result.skipped.length
      },
      correlationId: correlationId ?? undefined
    });

    return result;
  }

  // Generic engine only rejects with MODULE_PRESET_NOT_FOUND, which can't
  // actually happen here (the preset name is a compile-time constant
  // registered in MODULE_PRESETS) — but propagate faithfully rather than
  // assert/throw, matching this repo's "never silently swallow" convention.
  return {
    outcome: "rejected",
    code: "MODULE_PRESET_NOT_FOUND",
    reasons: [result.code],
    detail: [result.message]
  };
}
