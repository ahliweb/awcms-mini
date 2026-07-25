/**
 * Gate against re-introducing a hand-written worker-script count
 * (Issue #930 Wave 4).
 *
 * ## Why this test exists
 *
 * `docs/awcms-mini/database-capacity-runbook.md` and `capacity-config.ts`'s
 * header both used to describe the `worker` process class as "the 9
 * unattended background scripts", and `capacity-config.ts` additionally
 * listed all nine by name. By the time anyone looked, the real count had
 * nearly tripled — and nothing failed, because a number typed into prose has
 * nothing checking it.
 *
 * That matters more here than in an ordinary doc: the runbook's advice on
 * sizing `DATABASE_CAPACITY_WORKER_INSTANCES_MAX` is stated in terms of "N
 * distinct scripts", so a stale N is advice to under-budget connections.
 *
 * Both places now defer to `JOB_WORK_CLASS_REGISTRY` (itself gated against a
 * grep of `scripts/` by `bun run db:work-class:check`). This test keeps them
 * honest by failing if a literal count reappears.
 *
 * It deliberately does NOT assert the current number anywhere — that would
 * just be a third hand-maintained copy of the thing being gated.
 */
import { describe, expect, test } from "bun:test";

import { countRegisteredWorkerJobs } from "../../src/lib/database/capacity-config";
import { JOB_WORK_CLASS_REGISTRY } from "../../src/lib/database/work-class-registry";

/**
 * Every place that has described the worker class by counting it.
 *
 * The list is not speculative — each entry held a literal "9" when this gate
 * was written, and `src/lib/config/registry.ts` even carried the annotation
 * "(count corrected by Issue #743)". So the number had already been corrected
 * once and drifted again. That is the argument for a gate rather than a
 * fourth correction.
 */
const RUNBOOK_PATH = "docs/awcms-mini/database-capacity-runbook.md";
const CAPACITY_CONFIG_PATH = "src/lib/database/capacity-config.ts";
const COUNTED_ELSEWHERE = [
  RUNBOOK_PATH,
  CAPACITY_CONFIG_PATH,
  "src/lib/config/registry.ts",
  "src/lib/database/client.ts",
  "src/lib/database/work-class-registry.ts"
];

/**
 * Matches any claim about how many scripts there are: "the 9 unattended
 * background scripts", "9 worker scripts", "9 already-shipped scripts",
 * "25 scripts".
 *
 * Deliberately broader than the first version, which required a
 * worker/background/unattended adjective and therefore MISSED
 * "runtime behavior change to 9 already-shipped scripts" sitting three lines
 * from a phrasing it did catch. Within this small, explicit file list, any
 * "<number> ... scripts" is a count worth failing on — these files have no
 * legitimate reason to enumerate scripts by hand.
 */
const HARDCODED_SCRIPT_COUNT = /\b\d+\s+(?:[a-z-]+\s+){0,3}scripts?\b/i;

async function readRepoFile(path: string): Promise<string> {
  return Bun.file(path).text();
}

describe("worker inventory drift (Issue #930 Wave 4)", () => {
  test.each(COUNTED_ELSEWHERE)(
    "%s does not hardcode a worker-script count",
    async (path) => {
      const text = await readRepoFile(path);
      const match = text.match(HARDCODED_SCRIPT_COUNT);

      expect(
        match?.[0] ?? null,
        `${path} states a literal worker-script count ("${match?.[0]}"). That number ` +
          "goes stale silently — it drifted from 9 to nearly triple with nothing failing, " +
          "after having already been 'corrected by Issue #743' once. Describe the class " +
          "instead and let countRegisteredWorkerJobs() supply the number; the registry it " +
          "reads is gated against the filesystem by db:work-class:check."
      ).toBeNull();
    }
  );

  test("the regex would actually catch the drift it is named for", async () => {
    // A gate that cannot fail is not a gate. This pins that the pattern
    // matches the exact phrasing that went stale, in both the English form
    // the code comment used and the form the runbook table used.
    expect("the 9 unattended background scripts").toMatch(
      HARDCODED_SCRIPT_COUNT
    );
    expect(
      "The 9 unattended background scripts (getWorkerDatabaseClient())"
    ).toMatch(HARDCODED_SCRIPT_COUNT);
    expect("25 worker scripts are registered").toMatch(HARDCODED_SCRIPT_COUNT);
    // The phrasing the first, narrower version of this regex missed even
    // though it sat three lines from one it caught.
    expect("runtime behavior change to 9 already-shipped scripts").toMatch(
      HARDCODED_SCRIPT_COUNT
    );

    // And that it does NOT fire on the numbers those files legitimately
    // contain — otherwise the fix would be to weaken the gate.
    expect("approved capacity of 100 connections").not.toMatch(
      HARDCODED_SCRIPT_COUNT
    );
    expect("10 application instances x pool_max 20").not.toMatch(
      HARDCODED_SCRIPT_COUNT
    );
    expect("DATABASE_CAPACITY_WORKER_INSTANCES_MAX=1").not.toMatch(
      HARDCODED_SCRIPT_COUNT
    );
  });

  test("the derived count is the registry's, so it cannot disagree with the gated inventory", () => {
    expect(countRegisteredWorkerJobs()).toBe(
      Object.keys(JOB_WORK_CLASS_REGISTRY).length
    );
  });
});
