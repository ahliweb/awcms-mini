import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "bun:test";
import { parse } from "yaml";

import { DOMAIN_EVENT_CONSUMERS } from "../../src/modules/domain-event-runtime/infrastructure/consumer-registry";
import { DOMAIN_EVENT_TYPE_REGISTRY } from "../../src/modules/domain-event-runtime/domain/event-type-registry";
import {
  isValidEventType,
  isValidEventVersion
} from "../../src/modules/domain-event-runtime/domain/envelope";
import { domainEventRuntimeModule } from "../../src/modules/domain-event-runtime/module";

/**
 * Bidirectional parity between the runtime's own code-level registries and
 * the published AsyncAPI contract (Issue #742 acceptance criterion:
 * "Runtime registry and AsyncAPI event types/versions pass bidirectional
 * parity checks"). Scoped to the events this runtime itself is aware of —
 * `event-type-registry.ts`'s own doc comment explains why this is a
 * finer-grained complement to (not a replacement for) the existing
 * repo-wide `checkModuleEventChannels` (`scripts/api-spec-check.ts`, part
 * of `bun run api:spec:check`/`bun run check`), which already validates
 * `module.ts`'s `events.publishes` array against AsyncAPI channels for
 * EVERY module, including this one.
 *
 * Direction 1 (registry -> AsyncAPI): every `DOMAIN_EVENT_TYPE_REGISTRY`
 * entry must have a matching AsyncAPI channel — `appendDomainEvent`
 * already enforces this at RUNTIME (`UnregisteredDomainEventTypeError`
 * only prevents publishing an event NOT in the registry; it says nothing
 * about whether a registry entry itself has drifted from the published
 * contract), so this test is what actually closes that gap statically.
 *
 * Direction 2 (AsyncAPI -> registry, scoped): every event type any
 * registered CONSUMER subscribes to must be present in
 * `DOMAIN_EVENT_TYPE_REGISTRY` — a consumer subscribing to an event type
 * the registry itself doesn't know about would be silent, undetectable
 * drift (the consumer would simply never receive anything, since
 * `appendDomainEvent` can only fan out registry-known types).
 */

async function loadAsyncApiChannels(): Promise<Record<string, unknown>> {
  const filePath = path.join(
    import.meta.dir,
    "../../asyncapi/awcms-mini-domain-events.asyncapi.yaml"
  );
  const source = await readFile(filePath, "utf8");
  const document = parse(source) as { channels?: Record<string, unknown> };

  return document.channels ?? {};
}

describe("domain-event-runtime registry <-> AsyncAPI parity (Issue #742)", () => {
  test("every DOMAIN_EVENT_TYPE_REGISTRY entry has a matching AsyncAPI channel", async () => {
    const channels = await loadAsyncApiChannels();

    for (const entry of DOMAIN_EVENT_TYPE_REGISTRY) {
      expect(channels[entry.eventType]).toBeDefined();
    }
  });

  test("every consumer's subscribed event type is present in DOMAIN_EVENT_TYPE_REGISTRY", () => {
    const registeredTypes = new Set(
      DOMAIN_EVENT_TYPE_REGISTRY.map((entry) => entry.eventType)
    );

    for (const consumer of DOMAIN_EVENT_CONSUMERS) {
      for (const eventType of consumer.eventTypes) {
        expect(registeredTypes.has(eventType)).toBe(true);
      }
    }
  });

  test("module.ts's events.publishes includes every DOMAIN_EVENT_TYPE_REGISTRY entry", () => {
    const publishes = new Set(domainEventRuntimeModule.events?.publishes ?? []);

    for (const entry of DOMAIN_EVENT_TYPE_REGISTRY) {
      expect(publishes.has(entry.eventType)).toBe(true);
    }
  });

  test("every DOMAIN_EVENT_TYPE_REGISTRY entry has a well-formed event type and version", () => {
    // Reuses the actual validators (not a re-typed copy of their regex) —
    // a hand-duplicated pattern here previously drifted from
    // `envelope.ts`'s real `EVENT_TYPE_PATTERN` and masked the exact bug
    // `domain-event-runtime-envelope.test.ts` caught (the first namespace
    // segment, "awcms-mini", contains a hyphen).
    for (const entry of DOMAIN_EVENT_TYPE_REGISTRY) {
      expect(isValidEventType(entry.eventType)).toBe(true);
      expect(isValidEventVersion(entry.eventVersion)).toBe(true);
    }
  });

  test("no two DOMAIN_EVENT_TYPE_REGISTRY entries share the same (eventType, eventVersion) pair", () => {
    const seen = new Set<string>();

    for (const entry of DOMAIN_EVENT_TYPE_REGISTRY) {
      const key = `${entry.eventType}@${entry.eventVersion}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});
