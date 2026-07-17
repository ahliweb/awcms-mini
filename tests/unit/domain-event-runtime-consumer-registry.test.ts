import { afterEach, describe, expect, test } from "bun:test";

import {
  BASE_DOMAIN_EVENT_CONSUMERS,
  DOMAIN_EVENT_CONSUMERS,
  getConsumerByName,
  getConsumersForEventType,
  registerDomainEventConsumer,
  registerDomainEventConsumerForTests,
  resetDomainEventConsumersForTests,
  unregisterDomainEventConsumerForTests
} from "../../src/modules/domain-event-runtime/infrastructure/consumer-registry";
import type {
  DomainEventConsumerDefinition,
  DomainEventConsumerHandler
} from "../../src/modules/domain-event-runtime/domain/consumer-types";
import { SAMPLE_RECORDED_EVENT_TYPE } from "../../src/modules/domain-event-runtime/domain/event-type-registry";

describe("DOMAIN_EVENT_CONSUMERS static registry (Issue #742)", () => {
  test("ships at least two representative consumers", () => {
    expect(DOMAIN_EVENT_CONSUMERS.length).toBeGreaterThanOrEqual(2);
  });

  test("every consumer name is unique", () => {
    const names = DOMAIN_EVENT_CONSUMERS.map((consumer) => consumer.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every consumer declares at least one event type and one event version", () => {
    for (const consumer of DOMAIN_EVENT_CONSUMERS) {
      expect(consumer.eventTypes.length).toBeGreaterThan(0);
      expect(consumer.eventVersions.length).toBeGreaterThan(0);
    }
  });

  test("every consumer has a non-empty description", () => {
    for (const consumer of DOMAIN_EVENT_CONSUMERS) {
      expect(consumer.description.length).toBeGreaterThan(0);
    }
  });

  test("getConsumersForEventType returns every consumer subscribed to the sample reference event", () => {
    // Not necessarily EVERY registered consumer — a later real consumer
    // (e.g. Issue #754's `integration_hub.outbound_subscription_fanout`)
    // legitimately subscribes to its OWN event type, not the foundation
    // issue's self-contained reference event. Compare against the actual
    // declared subscribers instead of the whole registry's length.
    const declaredSubscribers = DOMAIN_EVENT_CONSUMERS.filter((consumer) =>
      consumer.eventTypes.includes(SAMPLE_RECORDED_EVENT_TYPE)
    );
    const matched = getConsumersForEventType(SAMPLE_RECORDED_EVENT_TYPE);
    expect(matched.length).toBe(declaredSubscribers.length);
    expect(matched.length).toBeGreaterThanOrEqual(2);
  });

  test("getConsumersForEventType returns an empty array for an unregistered event type", () => {
    expect(getConsumersForEventType("awcms-mini.nonexistent.thing")).toEqual(
      []
    );
  });

  test("getConsumerByName resolves a known consumer and returns undefined for an unknown one", () => {
    const first = DOMAIN_EVENT_CONSUMERS[0]!;
    expect(getConsumerByName(first.name)?.name).toBe(first.name);
    expect(getConsumerByName("not-a-real-consumer")).toBeUndefined();
  });
});

describe("registerDomainEventConsumer — inverted cross-module registration (Issue #826)", () => {
  const handler: DomainEventConsumerHandler = async () => {};

  const makeConsumer = (
    name: string,
    consumerHandler: DomainEventConsumerHandler = handler
  ): DomainEventConsumerDefinition => ({
    name,
    description: "Fixture consumer for Issue #826's registration tests.",
    eventTypes: ["awcms-mini.test.fixture"],
    eventVersions: ["1.0"],
    handler: consumerHandler
  });

  const FIXTURE_NAMES = [
    "test_module.register_once",
    "test_module.register_twice",
    "test_module.collide",
    "test_module.real_registration"
  ];

  afterEach(() => {
    // `registerDomainEventConsumer` is the PRODUCTION api and its entries
    // deliberately survive `resetDomainEventConsumersForTests`, so each
    // fixture must be undone explicitly — `bun test` shares this module-level
    // singleton across every test file in the process, and a leaked fixture
    // fails `domain-event-registry-parity.test.ts` in a DIFFERENT file (its
    // `awcms-mini.test.fixture` event type is not in the event-type registry).
    for (const name of FIXTURE_NAMES) {
      unregisterDomainEventConsumerForTests(name);
    }

    resetDomainEventConsumersForTests();
  });

  test("a registered consumer becomes resolvable by name and by event type", () => {
    const consumer = makeConsumer("test_module.register_once");

    registerDomainEventConsumer(consumer);

    expect(getConsumerByName("test_module.register_once")).toBe(consumer);
    expect(getConsumersForEventType("awcms-mini.test.fixture")).toContain(
      consumer
    );
  });

  test("re-registering the SAME consumer is a no-op, not a duplicate entry", () => {
    // Several composition roots import the same registration file in one
    // process (dispatch + replay + the owning module's own producer), so
    // this call genuinely runs more than once. A duplicate entry would make
    // `appendDomainEvent` create two delivery rows per event, i.e. fan every
    // event out twice.
    const consumer = makeConsumer("test_module.register_twice");

    registerDomainEventConsumer(consumer);
    registerDomainEventConsumer(consumer);

    const matches = DOMAIN_EVENT_CONSUMERS.filter(
      (entry) => entry.name === "test_module.register_twice"
    );

    expect(matches.length).toBe(1);
  });

  test("a DIFFERENT handler claiming an already-registered name throws instead of silently winning", () => {
    // The "later entry silently wins" defect shipped by Issue #740/PR #769
    // — one module hijacking another's registration must be loud.
    registerDomainEventConsumer(makeConsumer("test_module.collide"));

    expect(() =>
      registerDomainEventConsumer(
        makeConsumer("test_module.collide", async () => {})
      )
    ).toThrow(/already registered with a different handler/);
  });

  test("resetDomainEventConsumersForTests drops test fakes but KEEPS real cross-module registrations", () => {
    // The trap this guards: restoring the base array alone would silently
    // unregister integration_hub's/reporting's real consumers for the rest
    // of the process, and `dispatch-domain-events.ts` iterates registered
    // consumers — their deliveries would then never be claimed at all.
    const real = makeConsumer("test_module.real_registration");
    registerDomainEventConsumer(real);

    registerDomainEventConsumerForTests(makeConsumer("test_module.fake"));
    resetDomainEventConsumersForTests();

    expect(getConsumerByName("test_module.real_registration")).toBe(real);
    expect(getConsumerByName("test_module.fake")).toBeUndefined();
  });

  test("the runtime's own base registry contains no consumer owned by another module", () => {
    // Asserts BASE_DOMAIN_EVENT_CONSUMERS, not DOMAIN_EVENT_CONSUMERS. The
    // latter is a live binding that `registerDomainEventConsumer` appends to
    // BY DESIGN, so the moment any other test file transitively imports a
    // module's registration file, `integration_hub.*` legitimately appears in
    // it — and this assertion, which is about the runtime's own STATIC array,
    // would fail for a reason that has nothing to do with the invariant it
    // guards. It passed alone and failed in the full suite for exactly that
    // reason; the invariant was never broken, the test was reading the wrong
    // array. (Found by the orchestrator's full-suite run, wave 2 epic #818.)
    //
    // `logging.*` is this runtime's own reference consumer calling into
    // foundational logging infrastructure, not a plugin registration.
    for (const consumer of BASE_DOMAIN_EVENT_CONSUMERS) {
      expect(consumer.name.startsWith("integration_hub.")).toBe(false);
      expect(consumer.name.startsWith("reporting.")).toBe(false);
    }
  });

  test("the base registry is not the mutable binding — a plugin registration must not be able to reach it", () => {
    const baseLength = BASE_DOMAIN_EVENT_CONSUMERS.length;
    const fake: DomainEventConsumerDefinition = {
      name: "integration_hub.__base_isolation_probe",
      description:
        "Probe: proves a plugin registration cannot reach the base array.",
      eventTypes: [SAMPLE_RECORDED_EVENT_TYPE],
      eventVersions: ["1"],
      handler: (async () => {}) as DomainEventConsumerHandler
    };

    registerDomainEventConsumer(fake);
    try {
      // The merged view sees it...
      expect(DOMAIN_EVENT_CONSUMERS.some((c) => c.name === fake.name)).toBe(
        true
      );
      // ...the base array never does. Without this, the assertion above could
      // pass simply because nothing had registered yet, which is precisely how
      // the original version of this test hid its own defect.
      expect(BASE_DOMAIN_EVENT_CONSUMERS.length).toBe(baseLength);
      expect(
        BASE_DOMAIN_EVENT_CONSUMERS.some((c) => c.name === fake.name)
      ).toBe(false);
    } finally {
      unregisterDomainEventConsumerForTests(fake.name);
    }
  });
});
