import type { ModuleDescriptor } from "../_shared/module-contract";

export const observabilityLoggingModule: ModuleDescriptor = {
  key: "observability_logging",
  name: "Observability Logging",
  version: "0.1.0",
  status: "experimental",
  description: "Log event, audit event, security event: penyimpanan tenant-scoped, redaction wajib, correlation ID.",
  dependencies: [],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1"
  },
  events: {
    asyncApiPath: "asyncapi/awcms-mini-domain-events.asyncapi.yaml",
    publishes: [
        "security.event.recorded"
    ],
    subscribes: []
  }
};
