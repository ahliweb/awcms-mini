import type { ModuleDescriptor } from "../_shared/module-contract";

export const workflowApprovalModule: ModuleDescriptor = {
  key: "workflow_approval",
  name: "Workflow Approval",
  version: "0.1.0",
  status: "experimental",
  description: "Approval lintas modul untuk high-risk action: definisi, instance, task, decision; larang self-approval.",
  dependencies: ["identity_access","observability_logging"],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1"
  },
  events: {
    asyncApiPath: "asyncapi/awcms-mini-domain-events.asyncapi.yaml",
    publishes: [
        "workflow.task.approved",
        "workflow.task.rejected"
    ],
    subscribes: []
  }
};
