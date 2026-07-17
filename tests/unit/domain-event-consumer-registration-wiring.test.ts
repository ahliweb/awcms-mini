/**
 * Composition-root wiring gate for inverted domain-event consumer
 * registration (Issue #826).
 *
 * #826 broke the `domain_event_runtime <-> integration_hub` import cycle by
 * inverting registration: a module that owns a consumer registers it from
 * its own `infrastructure/domain-event-consumer-registration.ts`, and the
 * runtime imports no consumer module at all. That is the right direction —
 * but it trades a compile-time guarantee for a runtime one. The old static
 * array could not be incomplete; a side-effect registration can, if the
 * file is never imported in a given process.
 *
 * And it fails SILENTLY, which is why this gate is not optional:
 * `dispatch-domain-events.ts` iterates REGISTERED CONSUMERS and selects
 * deliveries per consumer, so an unregistered consumer's deliveries are
 * never claimed — no error, no dead-letter, no log line. They simply sit
 * `pending` forever. For `integration_hub` that means outbound webhooks
 * silently never delivering. (The publish and replay paths fail more
 * visibly — zero delivery rows created, or `UnknownReplayConsumerError` —
 * but "more visibly" is not "visibly".)
 *
 * So: every registration file that EXISTS must be imported by every
 * composition root that executes consumers. Discovering the files by
 * convention (rather than listing them) is what makes this catch the case
 * it is built for — a NEW module adding a registration file and forgetting
 * a root. That is the same class of gap as PR #769/#770's "validator exists
 * but is never wired to the real path", applied to registration.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.join(import.meta.dir, "../..");
const MODULES_ROOT = path.join(REPO_ROOT, "src/modules");

const REGISTRATION_FILE_NAME = "domain-event-consumer-registration.ts";

/**
 * Every process/entry point that resolves a consumer's HANDLER, or that
 * publishes an event a cross-module consumer subscribes to. A new one must
 * be added here AND import every registration file.
 */
const COMPOSITION_ROOTS = [
  // DISPATCH — `bun run domain-events:dispatch`, its own process.
  "scripts/domain-events-dispatch.ts",
  // REPLAY — resolves the handler via `getConsumerByName`.
  "src/pages/api/v1/domain-events/deliveries/[id]/replay.ts"
];

function findRegistrationFiles(): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(MODULES_ROOT)) {
    const infraDir = path.join(MODULES_ROOT, entry, "infrastructure");

    try {
      if (!statSync(infraDir).isDirectory()) continue;
    } catch {
      continue;
    }

    if (readdirSync(infraDir).includes(REGISTRATION_FILE_NAME)) {
      found.push(`${entry}/infrastructure/${REGISTRATION_FILE_NAME}`);
    }
  }

  return found.sort();
}

describe("domain-event consumer registration wiring (Issue #826)", () => {
  const registrationFiles = findRegistrationFiles();

  test("the registration files this gate is built for actually exist (sanity check for this test itself)", () => {
    // Without this, deleting every registration file would make the gate
    // below vacuously pass — a test that cannot fail proves nothing.
    expect(registrationFiles).toEqual([
      "integration-hub/infrastructure/domain-event-consumer-registration.ts",
      "reporting/infrastructure/domain-event-consumer-registration.ts"
    ]);
  });

  for (const root of COMPOSITION_ROOTS) {
    for (const registrationFile of registrationFiles) {
      test(`${root} imports ${registrationFile}`, () => {
        const source = readFileSync(path.join(REPO_ROOT, root), "utf-8");
        const moduleSpecifier = registrationFile.replace(/\.ts$/, "");

        expect(
          source.includes(moduleSpecifier),
          `${root} must \`import "…/${moduleSpecifier}";\` for its side effect. ` +
            `Without it, that consumer is not registered in this process and its deliveries are never claimed — silently, forever.`
        ).toBe(true);
      });
    }
  }

  test("the runtime's own registry imports no consumer module (the cycle #826 broke)", () => {
    const registry = readFileSync(
      path.join(
        MODULES_ROOT,
        "domain-event-runtime/infrastructure/consumer-registry.ts"
      ),
      "utf-8"
    );

    // `logging` is deliberately allowed — foundational infrastructure
    // beneath this runtime, one-directional by construction, and declared.
    for (const forbidden of ["integration-hub", "reporting"]) {
      expect(
        registry.includes(`../../${forbidden}/`),
        `consumer-registry.ts must not import ${forbidden}'s code — that is the import cycle Issue #826 removed. ` +
          `Have ${forbidden} call registerDomainEventConsumer() from its own registration file instead.`
      ).toBe(false);
    }
  });
});
