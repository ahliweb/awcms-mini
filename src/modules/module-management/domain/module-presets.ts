/**
 * Pure tenant module preset definitions + decision logic (Issue #565, epic
 * #555). No I/O here — the application layer
 * (`application/module-presets.ts`) resolves the current tenant module
 * state from `listModules()` + `awcms_mini_tenant_modules`, hands it to
 * `computeModulePresetPlan`, then executes the plan through the existing
 * `enableTenantModule`/`disableTenantModule` lifecycle primitives (never
 * duplicated here — see `domain/tenant-module-lifecycle.ts`'s own header
 * comment for the same "domain = pure, application = I/O" split).
 *
 * ## Design decision 1 — a preset both enables AND disables
 *
 * Applying a preset enables every module the preset lists, and disables
 * every currently-enabled module that (a) is not in the preset's list and
 * (b) is not "protected" (see below). Only-ever-enabling would make presets
 * useless as a way to reach a coherent profile: a tenant that previously
 * had `blog_content` enabled and then applies `minimal` would stay non-minimal
 * forever if presets never disabled anything. A preset apply is therefore a
 * best-effort "make tenant module state match this profile" operation, not
 * a pure additive grant.
 *
 * ## Design decision 2 — what "protected" (core, for preset purposes) means
 *
 * Only `module_management` sets `isCore: true` in this registry today (see
 * `src/modules/module-management/module.ts`). No other foundational module
 * (`tenant_admin`, `identity_access`, `profile_identity`) sets it — their
 * "core-ness" today is enforced *indirectly*, purely through the
 * dependency graph's reverse-dependency check
 * (`evaluateModuleDisable`'s `MODULE_REVERSE_DEPENDENCY_ACTIVE`): nothing
 * can disable `identity_access` while `module_management` (which depends on
 * it, transitively) remains enabled, and `module_management` itself can
 * never be disabled (`isCore: true`).
 *
 * `resolveProtectedModuleKeys` makes that *indirect* protection *explicit*
 * for preset-planning purposes: it is `isCore` keys unioned with the full
 * transitive dependency closure of every `isCore` key. A preset never
 * attempts to disable anything in this set — not because we duplicate the
 * reverse-dependency check (we don't — `enableTenantModule`/
 * `disableTenantModule` still run their own real validation against the
 * live DB state), but because attempting to disable them would always be
 * rejected anyway (`CORE_MODULE_CANNOT_BE_DISABLED` for `module_management`
 * itself, `MODULE_REVERSE_DEPENDENCY_ACTIVE` for its dependencies as long as
 * `module_management` stays enabled — which it always does, since nothing
 * can disable it). Computing this set lets the `minimal` preset concretely
 * mean "enable nothing beyond this protected set, disable everything else
 * this tenant can safely give up" instead of an empty enable list that
 * would silently leave every previously-enabled module untouched.
 *
 * In this repo's current registry, `resolveProtectedModuleKeys` evaluates
 * to `{module_management, tenant_admin, identity_access, profile_identity}`
 * — the closure of `module_management`'s own `dependencies` array plus
 * itself.
 *
 * ## Design decision 3 — dependencies not listed in a preset are NOT auto-added
 *
 * If a preset lists a module whose dependency isn't itself in the preset
 * (and isn't otherwise already enabled), this code does **not** invent new
 * resolution logic to silently add it. The existing
 * `evaluateModuleEnable` semantics (`MODULE_DEPENDENCY_MISSING`/
 * `MODULE_DEPENDENCY_DISABLED`) are reused as-is: the module simply fails
 * to enable and that failure is surfaced as a real, reportable outcome by
 * the application layer — never swallowed, never silently worked around.
 * (In practice, for the five presets defined below this only matters when
 * a *previous* preset application disabled a module — e.g. `sync_storage`
 * — that a *later* preset's listed module — e.g. `reporting` — depends on
 * without listing it explicitly; a fresh tenant has every module enabled
 * by default, so this never triggers on first apply.)
 */
import type { ModuleDescriptor } from "../../_shared/module-contract";
import type { ModuleTenantState } from "./tenant-module-lifecycle";

export type ModulePresetName =
  | "online_website"
  | "news_portal"
  | "news_portal_full_online_r2"
  | "saas_online"
  | "pos_lan"
  | "minimal";

export type ModulePresetDefinition = {
  name: ModulePresetName;
  label: string;
  description: string;
  /**
   * Module keys this preset wants enabled, beyond whatever
   * `resolveProtectedModuleKeys` already protects/keeps enabled. `minimal`
   * is deliberately empty — "core modules only" per the issue's own
   * phrase.
   */
  enabledModuleKeys: readonly string[];
};

export const MODULE_PRESETS: readonly ModulePresetDefinition[] = [
  {
    name: "online_website",
    label: "Online website",
    description:
      "Public website with custom domain, content, transactional email, and reporting.",
    enabledModuleKeys: ["tenant_domain", "blog_content", "email", "reporting"]
  },
  {
    name: "news_portal",
    label: "News portal",
    description:
      "Online website plus editorial approval workflow for published content.",
    enabledModuleKeys: [
      "tenant_domain",
      "blog_content",
      "email",
      "reporting",
      "workflow"
    ]
  },
  // NOTE: "news_portal" above (Issue #565, epic #555) and
  // "news_portal_full_online_r2" below (Issue #632, epic `news_portal`
  // #631-#642/#649) are deliberately DIFFERENT preset names for
  // DIFFERENT concepts — "news_portal" is "online website + editorial
  // approval workflow" (no R2/media requirement at all), while
  // "news_portal_full_online_r2" is the full-online, R2-only-media
  // editorial+news profile. Do not merge/rename either one to "fix" the
  // apparent naming overlap — a tenant using the plain `news_portal`
  // preset is not required to have any NEWS_MEDIA_R2_* config, and this
  // preset's own activation is gated (see
  // `news-portal/application/apply-news-portal-preset.ts`) in a way
  // `news_portal` above is not.
  {
    name: "news_portal_full_online_r2",
    label: "News portal (full-online, R2-only media)",
    description:
      "Full-online public news portal profile: blog_content + tenant_domain + visitor_analytics editorial/media stack, with news images stored exclusively in Cloudflare R2 (bucket/credentials kept separate from sync_storage's own R2_* config, Issue #631 architecture doc §2). Activation MUST go through `applyNewsPortalFullOnlineR2Preset` (`news-portal/application/apply-news-portal-preset.ts`), never this generic `applyModulePreset` directly with this name — that wrapper runs the readiness gate (`news-portal/domain/news-portal-preset-readiness.ts`: NEWS_PORTAL_ENABLED=true, NEWS_PORTAL_PROFILE=full_online_r2, complete+separated NEWS_MEDIA_R2_* config) this generic engine has no way to enforce (it never imports concrete domain modules — see this file's own header comment).",
    enabledModuleKeys: [
      "blog_content",
      "tenant_domain",
      "visitor_analytics",
      "module_management",
      "identity_access",
      "news_portal"
    ]
  },
  {
    name: "saas_online",
    label: "SaaS (online)",
    description:
      "Multi-tenant SaaS profile: custom domain, email, reporting, approval workflow — no public content module.",
    enabledModuleKeys: ["tenant_domain", "email", "reporting", "workflow"]
  },
  {
    name: "pos_lan",
    label: "POS (LAN-first)",
    description:
      "Offline-capable point-of-sale profile: sync storage, reporting, approval workflow — no public-facing domain/content/email.",
    enabledModuleKeys: ["sync_storage", "reporting", "workflow"]
  },
  {
    name: "minimal",
    label: "Minimal",
    description:
      "Core platform modules only — every non-core module a tenant hasn't explicitly kept is disabled.",
    enabledModuleKeys: []
  }
];

export function findModulePreset(name: string): ModulePresetDefinition | null {
  return MODULE_PRESETS.find((preset) => preset.name === name) ?? null;
}

/**
 * `isCore` keys unioned with the full transitive dependency closure of
 * every `isCore` key — see design decision 2 above. Generic over whatever
 * `allDescriptors` currently contains, never hardcoded to today's specific
 * module keys.
 */
export function resolveProtectedModuleKeys(
  allDescriptors: readonly ModuleDescriptor[]
): Set<string> {
  const descriptorByKey = new Map(allDescriptors.map((d) => [d.key, d]));
  const protectedKeys = new Set<string>();

  function includeWithDependencies(key: string): void {
    if (protectedKeys.has(key)) {
      return;
    }
    protectedKeys.add(key);

    const descriptor = descriptorByKey.get(key);
    for (const dep of descriptor?.dependencies ?? []) {
      includeWithDependencies(dep);
    }
  }

  for (const descriptor of allDescriptors) {
    if (descriptor.isCore) {
      includeWithDependencies(descriptor.key);
    }
  }

  return protectedKeys;
}

function buildDependentsIndex(
  allDescriptors: readonly ModuleDescriptor[]
): Map<string, string[]> {
  const dependents = new Map<string, string[]>();

  for (const descriptor of allDescriptors) {
    for (const dep of descriptor.dependencies) {
      const list = dependents.get(dep) ?? [];
      list.push(descriptor.key);
      dependents.set(dep, list);
    }
  }

  return dependents;
}

/**
 * Orders `candidates` (module keys to enable) so each module's own
 * dependencies come before it, given `alreadyEnabled` as a satisfied base
 * set. Any candidate whose dependency can never be satisfied within this
 * plan (missing from the registry entirely, or disabled and not itself a
 * candidate) is still appended at the end — best-effort — so the real
 * `enableTenantModule` call surfaces the exact rejection reason
 * (`MODULE_DEPENDENCY_MISSING`/`MODULE_DEPENDENCY_DISABLED`) rather than
 * this planner silently dropping it.
 */
function planEnableOrder(
  candidates: ReadonlySet<string>,
  allDescriptors: readonly ModuleDescriptor[],
  alreadyEnabled: ReadonlySet<string>
): string[] {
  const descriptorByKey = new Map(allDescriptors.map((d) => [d.key, d]));
  const remaining = new Set(candidates);
  const ordered: string[] = [];
  const satisfied = new Set(alreadyEnabled);

  let changed = true;
  while (remaining.size > 0 && changed) {
    changed = false;

    for (const key of remaining) {
      const deps = descriptorByKey.get(key)?.dependencies ?? [];
      const ready = deps.every((dep) => satisfied.has(dep));

      if (ready) {
        ordered.push(key);
        satisfied.add(key);
        remaining.delete(key);
        changed = true;
      }
    }
  }

  // Best-effort: anything left has an unresolved dependency within this
  // plan. Append it anyway so `enableTenantModule` reports the real reason.
  return [...ordered, ...remaining];
}

export type ModulePresetDisableSkip = {
  moduleKey: string;
  reason: "reverse_dependency_active";
};

export type ModulePresetDisablePlan = {
  ordered: string[];
  skipped: ModulePresetDisableSkip[];
};

/**
 * Orders `candidates` (module keys to disable) leaves-first, so a module is
 * only disabled once nothing that remains enabled still depends on it —
 * mirroring exactly what the real, sequential `disableTenantModule` calls
 * will see as each one lands. A candidate that can never become
 * disableable (a module that stays enabled — core/protected or another
 * preset-listed module — depends on it) is reported in `skipped`, never
 * silently dropped and never force-disabled. Modules that stay enabled
 * (i.e. not in `candidates`) are never removed from `stillEnabled` below,
 * so they naturally keep blocking anything that depends on them without
 * needing to be passed in separately.
 *
 * `stillEnabledBase` must include BOTH modules already enabled before this
 * plan runs AND modules this same plan is about to newly enable
 * (`wantEnabled` at the call site) — a disable candidate that only a
 * freshly-enabling module depends on must still be skipped, not scheduled
 * for disable (post-review fix: the caller previously passed only the
 * pre-plan enabled set, so a module blocked exclusively by a module in the
 * same plan's `toEnable` slipped through as a disable candidate and only
 * got caught later as a spurious rejection from the real
 * `disableTenantModule` call, instead of a pre-emptive `skipped` entry).
 */
function planDisableOrder(
  candidates: ReadonlySet<string>,
  allDescriptors: readonly ModuleDescriptor[],
  stillEnabledBase: ReadonlySet<string>
): ModulePresetDisablePlan {
  const dependentsOf = buildDependentsIndex(allDescriptors);
  const remaining = new Set(candidates);
  const ordered: string[] = [];
  // Modules considered "still enabled" as the plan progresses — starts as
  // stillEnabledBase, shrinks as we decide to disable one.
  const stillEnabled = new Set(stillEnabledBase);

  let changed = true;
  while (remaining.size > 0 && changed) {
    changed = false;

    for (const key of remaining) {
      const dependents = dependentsOf.get(key) ?? [];
      const blocked = dependents.some((dependentKey) =>
        stillEnabled.has(dependentKey)
      );

      if (!blocked) {
        ordered.push(key);
        stillEnabled.delete(key);
        remaining.delete(key);
        changed = true;
      }
    }
  }

  const skipped: ModulePresetDisableSkip[] = [...remaining].map((key) => ({
    moduleKey: key,
    reason: "reverse_dependency_active"
  }));

  return { ordered, skipped };
}

export type ModulePresetPlanInput = {
  preset: ModulePresetDefinition;
  allDescriptors: readonly ModuleDescriptor[];
  currentState: readonly ModuleTenantState[];
};

export type ModulePresetPlan = {
  presetName: ModulePresetName;
  /** Module keys to enable, in dependency-safe order. */
  toEnable: readonly string[];
  /** Module keys to disable, in dependency-safe (leaves-first) order. */
  toDisable: readonly string[];
  /**
   * Currently-enabled, non-preset-listed modules that were deliberately
   * left enabled because something else that stays enabled still depends
   * on them.
   */
  skippedDisable: readonly ModulePresetDisableSkip[];
  /** Keys never considered for disabling at all (core or its dependency closure). */
  protectedModuleKeys: readonly string[];
  /** Preset-listed keys that don't resolve to any registered descriptor. */
  unknownModuleKeys: readonly string[];
};

/**
 * Pure decision function: given a preset, the live module registry, and the
 * tenant's current per-module enabled state, decides which modules to
 * enable and which to disable. Performs no I/O and calls neither
 * `evaluateModuleEnable` nor `evaluateModuleDisable` itself — the
 * application layer still runs the real `enableTenantModule`/
 * `disableTenantModule` for every planned change, so this plan is a
 * best-effort *intent*, not a guarantee (a planned enable/disable can still
 * be rejected by the real lifecycle validation, which the application layer
 * surfaces rather than this function pre-empting).
 */
export function computeModulePresetPlan(
  input: ModulePresetPlanInput
): ModulePresetPlan {
  const { preset, allDescriptors, currentState } = input;
  const descriptorByKey = new Map(allDescriptors.map((d) => [d.key, d]));
  const currentlyEnabled = new Set(
    currentState.filter((s) => s.tenantEnabled).map((s) => s.moduleKey)
  );
  const protectedKeys = resolveProtectedModuleKeys(allDescriptors);

  const unknownModuleKeys = preset.enabledModuleKeys.filter(
    (key) => !descriptorByKey.has(key)
  );
  const wantEnabled = new Set(
    preset.enabledModuleKeys.filter((key) => descriptorByKey.has(key))
  );

  const enableCandidates = new Set(
    [...wantEnabled].filter((key) => !currentlyEnabled.has(key))
  );
  const toEnable = planEnableOrder(
    enableCandidates,
    allDescriptors,
    currentlyEnabled
  );

  const disableCandidates = new Set(
    [...currentlyEnabled].filter(
      (key) => !protectedKeys.has(key) && !wantEnabled.has(key)
    )
  );
  // Seed with currentlyEnabled UNION wantEnabled, not just currentlyEnabled:
  // a module this same plan is about to newly enable (wantEnabled) must
  // still count as "will stay enabled" for the blocking check below, or a
  // disable candidate that only that newly-enabling module depends on gets
  // scheduled for disable instead of skipped — the real disableTenantModule
  // call would still catch it (MODULE_REVERSE_DEPENDENCY_ACTIVE), but as a
  // spurious rejection instead of the pre-emptive skip this plan promises.
  const disablePlan = planDisableOrder(
    disableCandidates,
    allDescriptors,
    new Set([...currentlyEnabled, ...wantEnabled])
  );

  return {
    presetName: preset.name,
    toEnable,
    toDisable: disablePlan.ordered,
    skippedDisable: disablePlan.skipped,
    protectedModuleKeys: [...protectedKeys],
    unknownModuleKeys
  };
}
