export type ValidationError = {
  field: string;
  message: string;
};

export type SocialPublishTriggerEvent =
  "post_published" | "scheduled_published" | "manual_editor_action";

export const SOCIAL_PUBLISH_TRIGGER_EVENTS: readonly SocialPublishTriggerEvent[] =
  ["post_published", "scheduled_published", "manual_editor_action"];

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export type CreateSocialPublishRuleInput = {
  socialAccountId: string;
  triggerEvent: SocialPublishTriggerEvent;
  requiresApproval: boolean;
  isEnabled: boolean;
  templateId: string | null;
};

export type CreateSocialPublishRuleValidationResult =
  | { valid: true; value: CreateSocialPublishRuleInput }
  | { valid: false; errors: ValidationError[] };

export function validateCreateSocialPublishRuleInput(
  body: unknown
): CreateSocialPublishRuleValidationResult {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];

  if (!isUuid(record.socialAccountId)) {
    errors.push({
      field: "socialAccountId",
      message: "socialAccountId is required and must be a UUID."
    });
  }

  if (
    typeof record.triggerEvent !== "string" ||
    !SOCIAL_PUBLISH_TRIGGER_EVENTS.includes(
      record.triggerEvent as SocialPublishTriggerEvent
    )
  ) {
    errors.push({
      field: "triggerEvent",
      message: `triggerEvent must be one of: ${SOCIAL_PUBLISH_TRIGGER_EVENTS.join(", ")}.`
    });
  }

  let templateId: string | null = null;

  if (record.templateId !== undefined && record.templateId !== null) {
    if (!isUuid(record.templateId)) {
      errors.push({
        field: "templateId",
        message: "templateId must be a UUID when provided."
      });
    } else {
      templateId = record.templateId;
    }
  }

  const requiresApproval =
    typeof record.requiresApproval === "boolean"
      ? record.requiresApproval
      : true;

  const isEnabled =
    typeof record.isEnabled === "boolean" ? record.isEnabled : true;

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      socialAccountId: record.socialAccountId as string,
      triggerEvent: record.triggerEvent as SocialPublishTriggerEvent,
      requiresApproval,
      isEnabled,
      templateId
    }
  };
}

export type UpdateSocialPublishRuleInput = {
  requiresApproval?: boolean;
  isEnabled?: boolean;
  templateId?: string | null;
};

export type UpdateSocialPublishRuleValidationResult =
  | { valid: true; value: UpdateSocialPublishRuleInput }
  | { valid: false; errors: ValidationError[] };

export function validateUpdateSocialPublishRuleInput(
  body: unknown
): UpdateSocialPublishRuleValidationResult {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];
  const value: UpdateSocialPublishRuleInput = {};

  if (record.requiresApproval !== undefined) {
    if (typeof record.requiresApproval !== "boolean") {
      errors.push({
        field: "requiresApproval",
        message: "requiresApproval must be a boolean."
      });
    } else {
      value.requiresApproval = record.requiresApproval;
    }
  }

  if (record.isEnabled !== undefined) {
    if (typeof record.isEnabled !== "boolean") {
      errors.push({
        field: "isEnabled",
        message: "isEnabled must be a boolean."
      });
    } else {
      value.isEnabled = record.isEnabled;
    }
  }

  if (record.templateId !== undefined) {
    if (record.templateId !== null && !isUuid(record.templateId)) {
      errors.push({
        field: "templateId",
        message: "templateId must be a UUID or null."
      });
    } else {
      value.templateId = record.templateId as string | null;
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, value };
}
