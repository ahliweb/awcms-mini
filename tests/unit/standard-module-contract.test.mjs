import test from "node:test";
import assert from "node:assert/strict";

import { errorEnvelope, successEnvelope } from "../../src/modules/_shared/api-response.mjs";
import { createDomainEvent } from "../../src/modules/_shared/domain-event.mjs";
import {
  defineModule,
  findUnknownModuleDependencies,
  validateModuleDescriptor,
} from "../../src/modules/_shared/module-contract.mjs";
import { modules } from "../../src/modules/index.mjs";

test("standard module contract: registered modules are valid and dependency-complete", () => {
  for (const module of modules) {
    assert.doesNotThrow(() => validateModuleDescriptor(module));
    assert.equal(module.security.scopeModel, "single_tenant");
    assert.equal(module.security.authorization, "rbac_abac");
    assert.equal(module.security.audit, "required");
  }

  assert.deepEqual(findUnknownModuleDependencies(modules), []);
});

test("standard module contract: rejects tenant-scoped module descriptors", () => {
  assert.throws(
    () =>
      defineModule({
        key: "tenant_admin",
        name: "Tenant Admin",
        version: "0.1.0",
        status: "active",
        description: "AWPOS-style multi-tenant module that must not be copied into Mini.",
        dependencies: [],
        security: {
          scopeModel: "multi_tenant",
          authorization: "rbac_abac",
          audit: "required",
        },
      }),
    /single_tenant/,
  );
});

test("api response helper: emits standard success and error envelopes", () => {
  assert.deepEqual(successEnvelope({ status: "ok" }, { requestId: "req_1" }), {
    success: true,
    data: { status: "ok" },
    meta: { requestId: "req_1" },
  });

  assert.deepEqual(errorEnvelope("ACCESS_DENIED", "Tidak punya akses.", { correlationId: "corr_1" }), {
    success: false,
    error: {
      code: "ACCESS_DENIED",
      message: "Tidak punya akses.",
      correlationId: "corr_1",
    },
  });
});

test("domain event helper: emits single-tenant event envelope", () => {
  const event = createDomainEvent({
    eventType: "audit.log_recorded",
    sourceModule: "audit_observability",
    aggregateType: "audit_log",
    aggregateId: "audit_1",
    payload: { action: "role.assigned" },
    eventId: "evt_1",
    occurredAt: "2026-07-04T00:00:00.000Z",
  });

  assert.equal(event.scope.kind, "single_tenant");
  assert.equal(event.eventVersion, "1.0");
  assert.deepEqual(event.payload, { action: "role.assigned" });
});
