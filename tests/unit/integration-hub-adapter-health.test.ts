import { describe, expect, test } from "bun:test";
import {
  applyHealthFailure,
  applyHealthSuccess,
  type AdapterHealthSnapshot
} from "../../src/modules/integration-hub/domain/adapter-health";

describe("adapter health state machine", () => {
  test("a success resets consecutive failures and reports up", () => {
    const next = applyHealthSuccess({
      state: "degraded",
      consecutiveFailures: 5,
      consecutiveSuccesses: 0
    });
    expect(next.state).toBe("up");
    expect(next.consecutiveFailures).toBe(0);
    expect(next.consecutiveSuccesses).toBe(1);
  });

  test("stays up for failures below the degraded threshold", () => {
    let state: AdapterHealthSnapshot = {
      state: "up",
      consecutiveFailures: 0,
      consecutiveSuccesses: 0
    };
    state = applyHealthFailure(state);
    state = applyHealthFailure(state);
    expect(state.state).toBe("up");
    expect(state.consecutiveFailures).toBe(2);
  });

  test("transitions to degraded at the degraded threshold", () => {
    let state: AdapterHealthSnapshot = {
      state: "up",
      consecutiveFailures: 0,
      consecutiveSuccesses: 0
    };
    for (let i = 0; i < 3; i += 1) {
      state = applyHealthFailure(state);
    }
    expect(state.state).toBe("degraded");
  });

  test("transitions to down at the down threshold", () => {
    let state: AdapterHealthSnapshot = {
      state: "up",
      consecutiveFailures: 0,
      consecutiveSuccesses: 0
    };
    for (let i = 0; i < 8; i += 1) {
      state = applyHealthFailure(state);
    }
    expect(state.state).toBe("down");
  });
});
