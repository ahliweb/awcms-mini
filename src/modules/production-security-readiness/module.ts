import type { ModuleDescriptor } from "../_shared/module-contract";

export const productionSecurityReadinessModule: ModuleDescriptor = {
  key: "production_security_readiness",
  name: "Production Security Readiness",
  version: "0.1.0",
  status: "experimental",
  description: "Security control, readiness assessment, finding, go-live gates; critical finding memblokir go-live.",
  dependencies: ["observability_logging"],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1"
  },
  events: {
    asyncApiPath: "asyncapi/awcms-mini-domain-events.asyncapi.yaml",
    publishes: [
        "security.golive.blocked"
    ],
    subscribes: []
  }
};
