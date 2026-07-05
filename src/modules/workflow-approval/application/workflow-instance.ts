import {
  validateWorkflowSteps,
  type WorkflowStepDefinition
} from "../domain/workflow-transition";

export type StartWorkflowInstanceParams = {
  tenantId: string;
  workflowDefinitionId: string;
  resourceType: string;
  resourceId: string;
  requestedByTenantUserId: string;
};

export type StartWorkflowInstanceResult = {
  instanceId: string;
  taskId: string;
};

/**
 * Internal-only application function (Issue 11.1) — no public HTTP route
 * calls this with arbitrary request-body input. Doc 17's seed model grants
 * no `create`/`configure` action for `workflow.approval`, so this base has
 * deliberately no public "create workflow definition" or "start workflow
 * instance" endpoint. This function exists for future domain code in a
 * derived app (which would gate a real business action, e.g. a POS
 * cancel/Coretax export) and for test/verification fixtures — the same
 * pattern already used by Issue 9.1 (direct SQL for a second office/
 * tenant-user fixture) and Issue 10.1 (direct SQL for test profiles).
 *
 * Reads the definition's `steps`, creates the instance (`status: 'pending'`,
 * `current_step_order: 1`), and creates the first task
 * (`step_order: 1`, `status: 'pending'`). Throws if the definition does not
 * exist, is inactive, or is soft-deleted.
 */
export async function startWorkflowInstance(
  tx: Bun.SQL,
  params: StartWorkflowInstanceParams
): Promise<StartWorkflowInstanceResult> {
  const definitionRows = await tx`
    SELECT id, steps, status, deleted_at
    FROM awcms_mini_workflow_definitions
    WHERE tenant_id = ${params.tenantId} AND id = ${params.workflowDefinitionId}
  `;
  const definition = definitionRows[0] as
    | { id: string; steps: unknown; status: string; deleted_at: Date | null }
    | undefined;

  if (!definition || definition.deleted_at !== null) {
    throw new Error("Workflow definition not found or soft-deleted.");
  }

  if (definition.status !== "active") {
    throw new Error("Workflow definition is not active.");
  }

  const stepsValidation = validateWorkflowSteps(definition.steps);

  if (!stepsValidation.valid) {
    throw new Error(
      "Workflow definition has an invalid steps shape: " +
        stepsValidation.errors.map((error) => error.message).join(" ")
    );
  }

  const steps: WorkflowStepDefinition[] = stepsValidation.value;
  const firstStep = steps.find((step) => step.stepOrder === 1);

  if (!firstStep) {
    throw new Error("Workflow definition is missing step 1.");
  }

  const instanceRows = await tx`
    INSERT INTO awcms_mini_workflow_instances
      (tenant_id, workflow_definition_id, resource_type, resource_id,
       status, current_step_order, requested_by_tenant_user_id)
    VALUES (
      ${params.tenantId}, ${params.workflowDefinitionId}, ${params.resourceType},
      ${params.resourceId}, 'pending', 1, ${params.requestedByTenantUserId}
    )
    RETURNING id
  `;
  const instanceId = instanceRows[0]!.id as string;

  const taskRows = await tx`
    INSERT INTO awcms_mini_workflow_tasks
      (tenant_id, workflow_instance_id, step_order, status)
    VALUES (${params.tenantId}, ${instanceId}, 1, 'pending')
    RETURNING id
  `;
  const taskId = taskRows[0]!.id as string;

  return { instanceId, taskId };
}
