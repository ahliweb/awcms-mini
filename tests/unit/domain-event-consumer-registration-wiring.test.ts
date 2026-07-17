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
  // Deliberately NOT listing publish roots here. This list's rule is "every
  // root imports EVERY registration file", which is right for a root that
  // RESOLVES handlers (dispatch/replay can be handed any consumer's delivery)
  // but wrong for a PUBLISHER: forcing `integration_hub`'s publisher to import
  // `reporting`'s registration would manufacture exactly the cross-module edge
  // Issue #826 deleted. Publish-side coverage is asserted separately below,
  // per-module. (PR #847 review; general derivation tracked as Issue #848.)
];

/**
 * PUBLISH-side wiring, asserted per-module rather than through
 * `COMPOSITION_ROOTS` above.
 *
 * `appendDomainEvent` creates delivery rows FROM THE REGISTRY at publish
 * time, so a publisher that has not imported the registration for a consumer
 * subscribed to its event creates ZERO rows for an event that really
 * happened. That is strictly worse than a missed dispatch root: a missed
 * dispatch leaves rows `pending` and re-running the dispatcher recovers them;
 * a missed publish root loses them permanently, with nothing to reconstruct
 * from — and silently, since `dispatch-domain-events.ts` iterates registered
 * consumers, not delivery rows.
 *
 * Only ONE entry today, and that is a fact about the registry rather than an
 * omission: `integration_hub.outbound_subscription_fanout` is the only
 * registered cross-module consumer whose event type has any production
 * publisher, and that publisher is in the SAME module — so the import is a
 * module reaching its own infrastructure, not a new module-level edge.
 * `reporting.event_activity_projector` subscribes to
 * `domain-event-runtime.sample.recorded`, which no production code publishes.
 */
const PUBLISH_ROOTS: { publisher: string; registration: string }[] = [
  {
    publisher:
      "src/modules/integration-hub/application/inbound-webhook-intake.ts",
    registration:
      "integration-hub/infrastructure/domain-event-consumer-registration.ts"
  }
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

        // An import STATEMENT ending in this specifier — not any mention of
        // it. `includes()` is satisfied by a comment naming the path, which
        // is the same defect this PR fixes in `ci-check-parity.test.ts` and
        // which the publish-side check below shipped with until it was
        // caught. The relative prefix varies by root (`../`, `../../…`), so
        // the specifier is anchored at the end of the module string.
        const importStatement = new RegExp(
          `^\\s*import\\s+["'][^"']*${moduleSpecifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\.ts)?["']\\s*;?\\s*$`,
          "m"
        );

        expect(
          importStatement.test(source),
          `${root} must \`import "…/${moduleSpecifier}";\` for its side effect. ` +
            `Without it, that consumer is not registered in this process and its deliveries are never claimed — silently, forever.`
        ).toBe(true);
      });
    }
  }

  test("PUBLISH_ROOTS is not empty — an empty list would make the publish-side assertions below vacuous", () => {
    expect(PUBLISH_ROOTS.length).toBeGreaterThan(0);
  });

  for (const { publisher, registration } of PUBLISH_ROOTS) {
    test(`${publisher} imports ${registration} (publish-side: unregistered consumer = zero delivery rows, permanently)`, () => {
      const source = readFileSync(path.join(REPO_ROOT, publisher), "utf-8");
      const moduleDir = registration.split("/")[0]!;
      const specifier = `../infrastructure/${REGISTRATION_FILE_NAME.replace(".ts", "")}`;

      // Match the IMPORT STATEMENT, not any occurrence of the path. The first
      // version of this check used `source.includes(specifier)` and passed
      // with the real import deleted, because the line above it is a comment
      // mentioning the same path — the identical "prose satisfies the gate"
      // defect this PR fixes in `ci-check-parity.test.ts`. A side-effect
      // import has no bindings, so the statement form is unambiguous.
      const importStatement = new RegExp(
        `^\\s*import\\s+["']${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\.ts)?["']\\s*;?\\s*$`,
        "m"
      );

      expect(
        importStatement.test(source),
        `${publisher} calls appendDomainEvent but does not import its module's consumer registration.\n` +
          `Delivery rows are created FROM THE REGISTRY at publish time, so without this import a subscribed ` +
          `consumer gets ZERO rows for an event that did happen — no error, no dead-letter, nothing to replay.\n` +
          `Add: import "${specifier}";  (registration file: ${moduleDir}/infrastructure/${REGISTRATION_FILE_NAME})`
      ).toBe(true);
    });
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
