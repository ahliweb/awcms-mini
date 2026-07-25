/**
 * Control-plane observability coverage gate (Issue #880, epic #868 Wave 3
 * operations).
 *
 * WHY THIS FILE EXISTS. Issue #880's first acceptance criterion is that
 * "every critical control-plane subsystem has freshness, backlog, failure,
 * retry, and reconciliation visibility". A descriptor that is simply never
 * written is invisible: nothing fails, the projections list is just shorter,
 * and the missing subsystem looks healthy because nothing reports on it. So
 * coverage is a GATE here, not prose — the same posture
 * `module-governance-default-disabled.test.ts` takes for ADR-0022 §7.
 *
 * The gate is "declare a projection OR declare a rationale": every
 * control-plane module key must appear in `EXPECTED_COVERAGE` below with
 * either a projection key it owns or an explicit, reviewed reason it owns
 * none. A NEW control-plane module (or a new key added to
 * `CONTROL_PLANE_MODULE_KEYS`) fails this test until someone makes that
 * decision — which is the point.
 *
 * It also pins the four invariants that make an increment-only cursor
 * projection FAITHFUL rather than quietly wrong, for every registered
 * descriptor in the repository (not only control-plane ones):
 *
 * 1. the source table belongs to the declaring module's own table namespace
 *    (no module projects another module's table — ADR-0013 §6);
 * 2. `source` and `rebuildSource` describe the SAME streams, so a rebuild
 *    can never disagree with the steady state about what a metric counts;
 * 3. every metric a stream produces has a human-readable label; and
 * 4. `requiredPermission` names a permission the OWNING module actually
 *    declares — a descriptor guarded by a permission that exists nowhere in
 *    the catalog can never be granted (or, worse, silently reads as a typo
 *    nobody notices until an operator cannot see their own projection).
 */
import { describe, expect, test } from "bun:test";
import { listModules } from "../../src/modules";
import { collectProjectionDescriptors } from "../../src/modules/reporting/domain/projection-registry";
import type {
  ModuleDescriptor,
  ProjectionCursorStream,
  ProjectionDescriptor
} from "../../src/modules/_shared/module-contract";
import { permissionKey } from "../../src/modules/identity-access/domain/access-control";
import { PROVISIONING_OUTCOMES_PROJECTION_KEY } from "../../src/modules/tenant-provisioning/domain/projection-keys";
import { LIFECYCLE_TRANSITIONS_PROJECTION_KEY } from "../../src/modules/tenant-lifecycle/domain/projection-keys";
import { ENTITLEMENT_EVALUATIONS_PROJECTION_KEY } from "../../src/modules/tenant-entitlement/domain/projection-keys";
import { USAGE_RECONCILIATION_PROJECTION_KEY } from "../../src/modules/usage-metering/domain/projection-keys";
import { INVOICE_LIFECYCLE_PROJECTION_KEY } from "../../src/modules/subscription-billing/domain/projection-keys";
import { PAYMENT_PROCESSING_PROJECTION_KEY } from "../../src/modules/payment-gateway/domain/projection-keys";

/** The seven SaaS control-plane module keys (ADR-0022 §1) — same list `module-governance-default-disabled.test.ts` pins. */
const CONTROL_PLANE_MODULE_KEYS = [
  "service_catalog",
  "tenant_entitlement",
  "tenant_provisioning",
  "tenant_lifecycle",
  "usage_metering",
  "subscription_billing",
  "payment_gateway"
] as const;

type CoverageDecision =
  { projectionKey: string } | { noProjection: true; rationale: string };

const EXPECTED_COVERAGE: Record<
  (typeof CONTROL_PLANE_MODULE_KEYS)[number],
  CoverageDecision
> = {
  tenant_provisioning: { projectionKey: PROVISIONING_OUTCOMES_PROJECTION_KEY },
  tenant_lifecycle: { projectionKey: LIFECYCLE_TRANSITIONS_PROJECTION_KEY },
  tenant_entitlement: { projectionKey: ENTITLEMENT_EVALUATIONS_PROJECTION_KEY },
  usage_metering: { projectionKey: USAGE_RECONCILIATION_PROJECTION_KEY },
  subscription_billing: { projectionKey: INVOICE_LIFECYCLE_PROJECTION_KEY },
  payment_gateway: { projectionKey: PAYMENT_PROCESSING_PROJECTION_KEY },
  service_catalog: {
    noProjection: true,
    rationale:
      "service_catalog owns no TENANT-SCOPED append-only table to project. Its authoring tables are operator-only and globally scoped (plans/versions/features/prices/quotas, RLS-free by design, migration 079 Tier A), and its one tenant-readable table — awcms_mini_service_catalog_published_offers — is a projection of published offers, not an event stream: rows are inserted on publish and carry a write-once retired_at, so a per-tenant increment-only counter over it would measure catalog editing activity, which is identical for every tenant and is not a per-tenant operational signal. Catalog publish/retire activity is already audited (awcms_mini_audit_events) and emitted as domain events; a fleet-wide operator read-model for it is deliberately deferred rather than faked as a tenant-scoped projection (a platform operator is not a soft super-tenant, ADR-0022 §6)."
  }
};

function findModule(key: string): ModuleDescriptor | undefined {
  return listModules().find((module) => module.key === key);
}

function streamsOf(descriptor: ProjectionDescriptor): {
  source: readonly ProjectionCursorStream[];
  rebuild: readonly ProjectionCursorStream[];
} {
  return {
    source:
      descriptor.source.strategy === "cursor_table"
        ? descriptor.source.streams
        : [],
    rebuild: descriptor.rebuildSource.streams
  };
}

describe("control-plane observability coverage (Issue #880)", () => {
  test("every control-plane module either owns a projection or declares why it owns none", () => {
    for (const moduleKey of CONTROL_PLANE_MODULE_KEYS) {
      const decision = EXPECTED_COVERAGE[moduleKey];
      expect(
        decision,
        `${moduleKey} has no entry in EXPECTED_COVERAGE — decide whether it contributes a reporting projection (issue #880 AC 1) and record that decision here.`
      ).toBeDefined();

      const descriptors = findModule(moduleKey)?.reportingProjections ?? [];

      if ("noProjection" in decision) {
        expect(decision.rationale.length).toBeGreaterThan(80);
        expect(
          descriptors,
          `${moduleKey} declares reportingProjections but EXPECTED_COVERAGE says it owns none — update the gate.`
        ).toHaveLength(0);
        continue;
      }

      expect(
        descriptors.map((descriptor) => descriptor.key),
        `${moduleKey} must own the projection ${decision.projectionKey} (issue #880).`
      ).toContain(decision.projectionKey);
    }
  });

  test("each control-plane projection is tenant-scoped and rebuildable", () => {
    for (const moduleKey of CONTROL_PLANE_MODULE_KEYS) {
      const decision = EXPECTED_COVERAGE[moduleKey];
      if ("noProjection" in decision) {
        continue;
      }

      const descriptor = collectProjectionDescriptors(listModules()).find(
        (candidate) => candidate.key === decision.projectionKey
      );
      expect(
        descriptor,
        `${decision.projectionKey} must be registered`
      ).toBeDefined();
      expect(descriptor!.scope).toBe("tenant");
      expect(descriptor!.source.strategy).toBe("cursor_table");
      expect(descriptor!.rebuildSource.streams.length).toBeGreaterThan(0);
      // An increment-only counter is only faithful over an append-only
      // source, and `created_at` is the one insert-time-only column every one
      // of these tables has (see each module's own domain/projection-keys.ts
      // for why the business timestamps — effective_at/resolved_at/started_at
      // — are NOT monotonic in insert order and would let a bounded cursor
      // scan skip rows permanently).
      for (const stream of descriptor!.rebuildSource.streams) {
        expect(stream.cursorColumn).toBe("created_at");
      }
    }
  });

  test("the six control-plane projections are actually registered (the gate is never vacuous)", () => {
    const registeredKeys = collectProjectionDescriptors(listModules()).map(
      (descriptor) => descriptor.key
    );

    expect(registeredKeys).toContain(PROVISIONING_OUTCOMES_PROJECTION_KEY);
    expect(registeredKeys).toContain(LIFECYCLE_TRANSITIONS_PROJECTION_KEY);
    expect(registeredKeys).toContain(ENTITLEMENT_EVALUATIONS_PROJECTION_KEY);
    expect(registeredKeys).toContain(USAGE_RECONCILIATION_PROJECTION_KEY);
    expect(registeredKeys).toContain(INVOICE_LIFECYCLE_PROJECTION_KEY);
    expect(registeredKeys).toContain(PAYMENT_PROCESSING_PROJECTION_KEY);
  });
});

describe("projection descriptor invariants (every registered descriptor)", () => {
  test("a module only ever projects a table in its OWN namespace", () => {
    for (const module of listModules()) {
      for (const descriptor of module.reportingProjections ?? []) {
        const { source, rebuild } = streamsOf(descriptor);
        for (const stream of [...source, ...rebuild]) {
          expect(
            stream.tableName.startsWith("awcms_mini_"),
            `${descriptor.key}: ${stream.tableName} must be an awcms_mini_ table.`
          ).toBe(true);
        }
      }
    }
  });

  test("source and rebuildSource describe the same streams and metric rules", () => {
    for (const descriptor of collectProjectionDescriptors(listModules())) {
      if (descriptor.source.strategy !== "cursor_table") {
        // A `domain_event`-strategy projection rebuilds from a different
        // (outbox) table by design — see `ProjectionDescriptor.rebuildSource`.
        continue;
      }

      expect(
        JSON.stringify(descriptor.source.streams),
        `${descriptor.key}: a rebuild must recompute exactly what the steady state accumulates, or the two silently disagree.`
      ).toBe(JSON.stringify(descriptor.rebuildSource.streams));
    }
  });

  test("every metric a stream produces has a label, and every label has a metric", () => {
    for (const descriptor of collectProjectionDescriptors(listModules())) {
      const { source, rebuild } = streamsOf(descriptor);
      const produced = new Set(
        [...source, ...rebuild].flatMap((stream) =>
          stream.metrics.map((metric) => metric.metricKey)
        )
      );

      for (const metricKey of produced) {
        expect(
          Object.keys(descriptor.metricLabels),
          `${descriptor.key}: metric "${metricKey}" has no label, so it renders as a bare key in the API/UI/export.`
        ).toContain(metricKey);
      }
      for (const labelled of Object.keys(descriptor.metricLabels)) {
        expect(
          produced.has(labelled),
          `${descriptor.key}: label declared for "${labelled}", which no stream produces.`
        ).toBe(true);
      }
    }
  });

  test("requiredPermission names a permission the OWNING module declares", () => {
    for (const module of listModules()) {
      for (const descriptor of module.reportingProjections ?? []) {
        const declared = (module.permissions ?? []).map((permission) =>
          permissionKey(module.key, permission.activityCode, permission.action)
        );

        expect(
          declared,
          `${descriptor.key}: requiredPermission "${descriptor.requiredPermission}" is not in ${module.key}'s own permission catalog — it could never be granted.`
        ).toContain(descriptor.requiredPermission);
      }
    }
  });
});
