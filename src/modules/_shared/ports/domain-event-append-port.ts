/**
 * `DomainEventAppendPort` (Issue #845, epic #818) — the capability a module
 * consumes when it must append a domain event to the outbox but sits BELOW
 * `domain_event_runtime` in the lifecycle DAG and therefore cannot declare a
 * `dependencies` edge to it.
 *
 * `profile_identity` is the concrete case. Its `merge-workflow.ts` publishes
 * `profile.merged` via `domain_event_runtime`'s `appendDomainEvent`, but
 * `domain_event_runtime` depends on `identity_access`, which depends on
 * `profile_identity` — so a direct `profile_identity -> domain_event_runtime`
 * import (and the matching `dependencies` declaration the Issue #826 gate
 * `tests/unit/module-declared-dependencies.test.ts` would demand) would close
 * a real 3-cycle: `profile_identity -> domain_event_runtime -> identity_access
 * -> profile_identity`. `modules:dag:check` (`validateModuleDependencyGraph`)
 * would reject it.
 *
 * This port lives on neutral ground (`_shared`, imports NOTHING from any
 * module) so the consumer imports only a TYPE from here — never the
 * `domain_event_runtime` implementation. The TRUE composition root (the route
 * handler in `src/pages/api/**`, which the module-boundary/declared-dependency
 * gates deliberately do not scan) imports the concrete `appendDomainEvent`
 * from `domain_event_runtime` and injects it. Same ADR-0011 inversion the
 * `blog_content`/`news_portal` port pair and the Issue #826/#848
 * `domain_event_runtime` consumer-registry inversion already use.
 *
 * The shapes below are a structural mirror of `domain_event_runtime`'s own
 * `AppendDomainEventInput`/`AppendDomainEventResult` (the concrete
 * `appendDomainEvent` is assignable to `DomainEventAppendPort` by structural
 * typing — its richer result is return-covariant, its identical input is
 * param-compatible). They are intentionally NOT imported from
 * `domain_event_runtime` here — that would defeat the entire purpose of the
 * port by reintroducing the very edge it exists to break.
 */
export type DomainEventAppendPortInput = {
  eventType: string;
  eventVersion: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion?: number;
  orderKey?: string;
  correlationId?: string | null;
  causationId?: string | null;
  /** The publishing module's own `ModuleDescriptor.key`, always passed explicitly. */
  producerModule: string;
  schemaRef?: string | null;
  actorTenantUserId?: string | null;
  actorProfileId?: string | null;
  payload: Record<string, unknown>;
  occurredAt?: Date;
};

export type DomainEventAppendPortResult = {
  eventId: string;
  eventSequence: number;
  deliveriesCreated: number;
};

/**
 * `tx` MUST be the caller's own business transaction — the concrete adapter
 * (`domain_event_runtime`'s `appendDomainEvent`) writes the outbox row inside
 * it so source state and event commit atomically (Issue #742). The port never
 * opens its own transaction.
 */
export type DomainEventAppendPort = (
  tx: Bun.SQL,
  tenantId: string,
  input: DomainEventAppendPortInput
) => Promise<DomainEventAppendPortResult>;
