/**
 * Canonical, NEUTRAL-GROUND tenant-lifecycle policy (Issue #873, epic #868,
 * ADR-0022 §11.2). Pure — ZERO imports, zero I/O. Lives in `_shared` (not under
 * `tenant-lifecycle/`) precisely so the base `identity_access` auth chokepoint
 * can consult it to ENFORCE lifecycle restrictions WITHOUT importing the
 * control-plane module (which would be a forbidden reverse dependency —
 * `tests/unit/module-boundary.test.ts`, ADR-0022 §4). The `tenant_lifecycle`
 * module re-exports this file from its own `domain/` so there is exactly ONE
 * source of truth for the state machine + restriction matrix (no drift between
 * the enforcing surface and the owning module — memory
 * `ssr-admin-pages-skip-module-enabled`).
 *
 * The transition whitelist and restriction matrix here BYTE-MIRROR the DB
 * trigger in `sql/089` so an illegal transition is rejected identically at the
 * application layer and the database.
 */

export type LifecycleState =
  | "provisioning"
  | "trial"
  | "active"
  | "renewal_due"
  | "past_due"
  | "grace"
  | "suspended"
  | "canceled"
  | "restoring"
  | "blocked";

export const LIFECYCLE_STATES: readonly LifecycleState[] = [
  "provisioning",
  "trial",
  "active",
  "renewal_due",
  "past_due",
  "grace",
  "suspended",
  "canceled",
  "restoring",
  "blocked"
];

export type LifecycleSource =
  "system" | "operator" | "scheduler" | "billing" | "provisioning" | "restore";

export const LIFECYCLE_SOURCES: readonly LifecycleSource[] = [
  "system",
  "operator",
  "scheduler",
  "billing",
  "provisioning",
  "restore"
];

const LIFECYCLE_TRANSITIONS: Readonly<
  Record<LifecycleState, readonly LifecycleState[]>
> = {
  provisioning: ["trial", "active", "blocked", "canceled"],
  trial: ["active", "grace", "past_due", "suspended", "canceled", "blocked"],
  active: [
    "renewal_due",
    "past_due",
    "grace",
    "suspended",
    "canceled",
    "blocked"
  ],
  renewal_due: [
    "active",
    "past_due",
    "grace",
    "suspended",
    "canceled",
    "blocked"
  ],
  past_due: ["active", "grace", "suspended", "canceled", "blocked"],
  grace: ["active", "past_due", "suspended", "canceled", "blocked"],
  suspended: ["restoring", "canceled", "blocked"],
  canceled: ["restoring"],
  restoring: ["active", "suspended", "canceled", "blocked"],
  blocked: ["active", "suspended", "canceled", "restoring"]
};

export function isLifecycleState(value: unknown): value is LifecycleState {
  return (
    typeof value === "string" &&
    (LIFECYCLE_STATES as readonly string[]).includes(value)
  );
}

export function isLifecycleSource(value: unknown): value is LifecycleSource {
  return (
    typeof value === "string" &&
    (LIFECYCLE_SOURCES as readonly string[]).includes(value)
  );
}

/** A same-state write is allowed; a state CHANGE must be in the transition graph. */
export function isLegalTransition(
  from: LifecycleState,
  to: LifecycleState
): boolean {
  return from === to || LIFECYCLE_TRANSITIONS[from].includes(to);
}

export function legalTargetsFrom(
  from: LifecycleState
): readonly LifecycleState[] {
  return LIFECYCLE_TRANSITIONS[from];
}

/** `canceled` may only leave toward `restoring` (an explicit, reconciled reactivate). */
export function isCanceledTerminal(state: LifecycleState): boolean {
  return state === "canceled";
}

/** A tenant may be RESTORED (moved into `restoring`) only from a restricted state. */
export function isRestorableState(state: LifecycleState): boolean {
  return state === "suspended" || state === "canceled" || state === "blocked";
}

/** States a scheduler-driven transition (trial/grace/renewal expiry) may originate from. */
export function isSchedulableFrom(state: LifecycleState): boolean {
  return (
    state === "trial" ||
    state === "grace" ||
    state === "past_due" ||
    state === "renewal_due" ||
    state === "active"
  );
}

// ---------------------------------------------------------------------------
// Restriction matrix (server-derived, fail-closed) — ADR-0022 §6 High-2.
// ---------------------------------------------------------------------------

/**
 * The effective restriction surface a lifecycle state implies. Every field is a
 * POSITIVE capability (true = allowed) so a fail-closed default is trivially
 * "all false". 1:1 with the AC restriction dimensions.
 */
export type RestrictionProfile = {
  adminAccessAllowed: boolean;
  writesAllowed: boolean;
  publicSiteAllowed: boolean;
  backgroundJobsAllowed: boolean;
  providerDispatchAllowed: boolean;
  dataExportAllowed: boolean;
  ownerRecoveryAllowed: boolean;
  entitlementActive: boolean;
};

const ALLOW: RestrictionProfile = {
  adminAccessAllowed: true,
  writesAllowed: true,
  publicSiteAllowed: true,
  backgroundJobsAllowed: true,
  providerDispatchAllowed: true,
  dataExportAllowed: true,
  ownerRecoveryAllowed: true,
  entitlementActive: true
};

/** Unrestricted — a tenant NOT governed by lifecycle (no record). */
export const ALLOW_ALL: RestrictionProfile = Object.freeze({ ...ALLOW });

/** Most-restrictive — the fail-closed default (governing tenant, unknown state). */
export const DENY_ALL: RestrictionProfile = Object.freeze({
  adminAccessAllowed: false,
  writesAllowed: false,
  publicSiteAllowed: false,
  backgroundJobsAllowed: false,
  providerDispatchAllowed: false,
  dataExportAllowed: false,
  ownerRecoveryAllowed: false,
  entitlementActive: false
});

const RESTRICTIONS: Readonly<Record<LifecycleState, RestrictionProfile>> = {
  provisioning: {
    ...ALLOW,
    publicSiteAllowed: false,
    backgroundJobsAllowed: false,
    providerDispatchAllowed: false
  },
  trial: { ...ALLOW },
  active: { ...ALLOW },
  renewal_due: { ...ALLOW },
  past_due: { ...ALLOW, writesAllowed: false, entitlementActive: false },
  grace: { ...ALLOW },
  suspended: {
    adminAccessAllowed: false,
    writesAllowed: false,
    publicSiteAllowed: false,
    backgroundJobsAllowed: false,
    providerDispatchAllowed: false,
    dataExportAllowed: true,
    ownerRecoveryAllowed: true,
    entitlementActive: false
  },
  canceled: {
    adminAccessAllowed: false,
    writesAllowed: false,
    publicSiteAllowed: false,
    backgroundJobsAllowed: false,
    providerDispatchAllowed: false,
    dataExportAllowed: true,
    ownerRecoveryAllowed: true,
    entitlementActive: false
  },
  restoring: {
    adminAccessAllowed: true,
    writesAllowed: false,
    publicSiteAllowed: false,
    backgroundJobsAllowed: false,
    providerDispatchAllowed: false,
    dataExportAllowed: true,
    ownerRecoveryAllowed: true,
    entitlementActive: false
  },
  blocked: {
    adminAccessAllowed: false,
    writesAllowed: false,
    publicSiteAllowed: false,
    backgroundJobsAllowed: false,
    providerDispatchAllowed: false,
    dataExportAllowed: true,
    ownerRecoveryAllowed: true,
    entitlementActive: false
  }
};

/** Server-derived restriction profile for a known lifecycle state. Total, pure. */
export function deriveRestrictions(state: LifecycleState): RestrictionProfile {
  return RESTRICTIONS[state];
}

export function isRestricted(profile: RestrictionProfile): boolean {
  return (
    !profile.adminAccessAllowed ||
    !profile.writesAllowed ||
    !profile.publicSiteAllowed ||
    !profile.backgroundJobsAllowed ||
    !profile.providerDispatchAllowed ||
    !profile.entitlementActive
  );
}

/**
 * The single access decision every enforcing surface (the API/SSR auth
 * chokepoint) applies for a governed tenant: a blocked admin surface denies
 * everything; an admitted-but-read-only state denies writes. `isWrite` is the
 * caller's action classification (a mutation vs a read). Returns a stable
 * machine reason so the chokepoint can pick a deterministic error code.
 */
export type LifecycleAccessDecision =
  { allowed: true } | { allowed: false; reason: "suspended" | "read_only" };

export function lifecycleAccessDecision(
  profile: RestrictionProfile,
  isWrite: boolean
): LifecycleAccessDecision {
  if (!profile.adminAccessAllowed) {
    return { allowed: false, reason: "suspended" };
  }
  if (isWrite && !profile.writesAllowed) {
    return { allowed: false, reason: "read_only" };
  }
  return { allowed: true };
}

/**
 * Whether an AccessAction string is a WRITE (mutation). A small, explicit READ
 * allow-list — everything else is treated as a write (fail-closed toward
 * treating unknown actions as writes so a new mutating action is restricted by
 * default, never silently exempt).
 */
const READ_ACTIONS: ReadonlySet<string> = new Set(["read", "check", "analyze"]);

export function isWriteAction(action: string): boolean {
  return !READ_ACTIONS.has(action);
}
