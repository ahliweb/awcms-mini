/**
 * Pure provisioning state machine (Issue #872, epic #868, ADR-0022 §11.1).
 * Mirrors the DB triggers in `sql/085` so the application layer can validate a
 * transition BEFORE issuing a state-predicated UPDATE, and so tests can prove
 * the legal transition graph without a database. Pure — no I/O.
 */

export type RequestStatus =
  | "requested"
  | "in_progress"
  | "provisioned"
  | "compensating"
  | "failed"
  | "blocked"
  | "canceled"
  | "reconciling";

export type ReadinessState = "pending" | "ready" | "blocked";

export type StepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "waiting"
  | "skipped"
  | "compensation_pending"
  | "compensated"
  | "compensation_failed"
  | "compensation_manual";

const REQUEST_TRANSITIONS: Readonly<
  Record<RequestStatus, readonly RequestStatus[]>
> = {
  requested: ["in_progress", "canceled"],
  in_progress: ["provisioned", "compensating", "blocked", "canceled"],
  compensating: ["failed", "blocked"],
  failed: ["in_progress", "canceled"],
  blocked: ["in_progress", "compensating", "canceled"],
  provisioned: ["reconciling"],
  reconciling: ["provisioned"],
  canceled: []
};

const STEP_TRANSITIONS: Readonly<Record<StepStatus, readonly StepStatus[]>> = {
  pending: ["running", "skipped"],
  running: ["completed", "failed", "waiting", "skipped"],
  waiting: ["completed", "failed", "running"],
  failed: ["running", "compensation_pending"],
  completed: ["compensation_pending"],
  compensation_pending: [
    "compensated",
    "compensation_failed",
    "compensation_manual"
  ],
  compensation_failed: [
    "compensation_pending",
    "compensated",
    "compensation_manual"
  ],
  skipped: [],
  compensated: [],
  compensation_manual: []
};

/** A same-status write (counter/checkpoint update) is always allowed; a status change must be in the transition graph. */
export function isLegalRequestTransition(
  from: RequestStatus,
  to: RequestStatus
): boolean {
  return from === to || REQUEST_TRANSITIONS[from].includes(to);
}

export function isLegalStepTransition(
  from: StepStatus,
  to: StepStatus
): boolean {
  return from === to || STEP_TRANSITIONS[from].includes(to);
}

const TERMINAL_REQUEST_STATUSES: ReadonlySet<RequestStatus> = new Set([
  "canceled"
]);

/** `provisioned` is a stable success state, not terminal (it can enter reconciling); `canceled` is truly terminal. */
export function isTerminalRequestStatus(status: RequestStatus): boolean {
  return TERMINAL_REQUEST_STATUSES.has(status);
}

/** A run can be started/resumed only from these statuses. */
export function isResumableStatus(status: RequestStatus): boolean {
  return (
    status === "requested" ||
    status === "in_progress" ||
    status === "failed" ||
    status === "blocked"
  );
}

/** A run can be canceled only when not already terminal/provisioned. */
export function isCancelableStatus(status: RequestStatus): boolean {
  return (
    status === "requested" ||
    status === "in_progress" ||
    status === "failed" ||
    status === "blocked"
  );
}
