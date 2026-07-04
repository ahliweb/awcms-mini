import type { ModuleDescriptor } from "../_shared/module-contract";

export const profileIdentityModule: ModuleDescriptor = {
  key: "profile_identity",
  name: "Profile Identity",
  version: "0.1.0",
  status: "experimental",
  description: "Central profile untuk user/customer/supplier/contact: identifier ter-mask + hash lookup, resolver, entity link, merge request.",
  dependencies: ["tenant_admin"],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1"
  },
  events: {
    asyncApiPath: "asyncapi/awcms-mini-domain-events.asyncapi.yaml",
    publishes: [
        "profile.created",
        "profile.merged"
    ],
    subscribes: []
  }
};
