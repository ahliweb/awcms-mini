/**
 * Work-class concurrency gate (Issue 10.2, doc 16 §Connection pooling dan
 * backpressure). `Bun.SQL`'s own pool (`src/lib/database/client.ts`) knows
 * nothing about "work class" — it is a flat pool of connections. This module
 * is a pure, in-process application-level semaphore that sits in front of
 * that pool: every DB-bound request first acquires a slot for its work
 * class, then does its work, then releases the slot. When a class is at its
 * concurrency max, callers queue FIFO until a slot frees or a timeout
 * elapses.
 *
 * This is intentionally NOT env-tunable — the max-concurrency numbers below
 * are small, fixed constants that roughly track doc 16's priority table:
 *
 * | Work class             | Max | Why                                        |
 * | ----------------------- | --: | ------------------------------------------- |
 * | `critical_transaction`  |  10 | Highest priority (doc 16) gets the largest  |
 * |                         |     | share of the pool so it is least likely to  |
 * |                         |     | queue behind lower-priority work.           |
 * | `interactive`           |   8 | High priority; most existing endpoints      |
 * |                         |     | (CRUD/admin/search) default here.           |
 * | `reporting`             |   4 | Medium priority; reports/dashboards can     |
 * |                         |     | tolerate more queueing than interactive.    |
 * | `background_sync`       |   4 | Low priority; sync push/pull/outbox should   |
 * |                         |     | never starve interactive/reporting traffic.  |
 * | `maintenance`           |   1 | Scheduled, not an HTTP concern in this base — |
 * |                         |     | serialized to avoid overlapping runs.        |
 *
 * These add up to well under `DATABASE_POOL_MAX` (default 20), leaving
 * headroom in the underlying `Bun.SQL` pool itself.
 */
export type WorkClass =
  | "critical_transaction"
  | "interactive"
  | "reporting"
  | "background_sync"
  | "maintenance";

export type WorkClassSlot = {
  release: () => void;
};

export class WorkClassTimeoutError extends Error {
  readonly workClass: WorkClass;

  constructor(workClass: WorkClass, timeoutMs: number) {
    super(
      `Timed out after ${timeoutMs}ms waiting for a "${workClass}" work-class slot.`
    );
    this.name = "WorkClassTimeoutError";
    this.workClass = workClass;
  }
}

const WORK_CLASS_MAX: Record<WorkClass, number> = {
  critical_transaction: 10,
  interactive: 8,
  reporting: 4,
  background_sync: 4,
  maintenance: 1
};

type Waiter = {
  resolve: (slot: WorkClassSlot) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type GateState = {
  active: number;
  queue: Waiter[];
};

function createGateState(): Record<WorkClass, GateState> {
  return {
    critical_transaction: { active: 0, queue: [] },
    interactive: { active: 0, queue: [] },
    reporting: { active: 0, queue: [] },
    background_sync: { active: 0, queue: [] },
    maintenance: { active: 0, queue: [] }
  };
}

let gates = createGateState();

function makeSlot(workClass: WorkClass): WorkClassSlot {
  let released = false;

  return {
    release: () => {
      if (released) {
        return;
      }

      released = true;
      releaseSlot(workClass);
    }
  };
}

function releaseSlot(workClass: WorkClass): void {
  const gate = gates[workClass];
  const next = gate.queue.shift();

  if (next) {
    clearTimeout(next.timer);
    // Active count stays the same: the freed slot is handed directly to the
    // next queued waiter instead of being decremented then re-incremented.
    next.resolve(makeSlot(workClass));
    return;
  }

  gate.active = Math.max(0, gate.active - 1);
}

/**
 * Acquire a concurrency slot for `workClass`. Resolves immediately if under
 * the class's max; otherwise queues FIFO and resolves when a slot frees, or
 * rejects with `WorkClassTimeoutError` after `timeoutMs`.
 */
export function acquireWorkClassSlot(
  workClass: WorkClass,
  timeoutMs: number
): Promise<WorkClassSlot> {
  const gate = gates[workClass];
  const max = WORK_CLASS_MAX[workClass];

  if (gate.active < max) {
    gate.active += 1;

    return Promise.resolve(makeSlot(workClass));
  }

  return new Promise<WorkClassSlot>((resolve, reject) => {
    const waiter: Waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = gate.queue.indexOf(waiter);

        if (index >= 0) {
          gate.queue.splice(index, 1);
        }

        reject(new WorkClassTimeoutError(workClass, timeoutMs));
      }, timeoutMs)
    };

    gate.queue.push(waiter);
  });
}

export type WorkClassSaturation = {
  workClass: WorkClass;
  active: number;
  max: number;
  queued: number;
};

/**
 * Snapshot of current active/max/queued counts per work class, used by the
 * `/database/pool/health` endpoint and by saturation logging.
 */
export function getWorkClassSaturation(): WorkClassSaturation[] {
  return (Object.keys(gates) as WorkClass[]).map((workClass) => ({
    workClass,
    active: gates[workClass].active,
    max: WORK_CLASS_MAX[workClass],
    queued: gates[workClass].queue.length
  }));
}

/**
 * Test-only reset so `tests/database-pooling.test.ts` cases don't leak state
 * (queued timers, active counts) into each other.
 */
export function resetWorkClassGatesForTests(): void {
  for (const workClass of Object.keys(gates) as WorkClass[]) {
    for (const waiter of gates[workClass].queue) {
      clearTimeout(waiter.timer);
    }
  }

  gates = createGateState();
}
