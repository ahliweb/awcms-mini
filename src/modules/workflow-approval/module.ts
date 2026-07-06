import { defineModule } from "../_shared/module-contract";

export const workflowApprovalModule = defineModule({
  key: "workflow",
  name: "Workflow Approval",
  version: "1.0.0",
  status: "active",
  description:
    "Generic workflow approval engine (definitions, instances, tasks, decisions) with a self-approval guard reused from identity_access's ABAC evaluator. No public create-definition/start-instance endpoint in this base — see README.",
  dependencies: ["tenant_admin", "identity_access"],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/workflows"
  }
});
