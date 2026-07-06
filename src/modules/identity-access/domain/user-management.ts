/**
 * Pure validation for the Access & Users management endpoints
 * (`/api/v1/users`, `/api/v1/roles`). Same shape/style as
 * `tenant-admin/domain/setup-validation.ts` — no I/O here; existence checks
 * (duplicate login, unknown role/permission id) happen in the endpoint against
 * the database. Keeping these pure keeps them unit-testable without a DB.
 */
export type ValidationError = {
  field: string;
  message: string;
};

export type CreateUserInput = {
  displayName: string;
  loginIdentifier: string;
  password: string;
  roleIds: string[];
};

export type UpdateUserInput = {
  displayName?: string;
  status?: "active" | "inactive";
};

export type CreateRoleInput = {
  roleCode: string;
  roleName: string;
  permissionIds: string[];
};

export type UpdateRoleInput = {
  roleName?: string;
  permissionIds?: string[];
};

type Result<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

/** Reused by `password-reset-validation.ts` (Issue #496) — single source of truth for the password policy. */
export const MIN_PASSWORD_LENGTH = 8;
const ROLE_CODE_PATTERN = /^[a-z][a-z0-9_]*$/;
const USER_STATUSES = new Set(["active", "inactive"]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validates an array of ids as non-empty strings. Returns the trimmed,
 * de-duplicated list. A missing/undefined field yields an empty list (callers
 * decide whether that is allowed for their operation).
 */
function validateIdList(
  value: unknown,
  field: string,
  errors: ValidationError[]
): string[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    errors.push({ field, message: `${field} must be an array of ids.` });
    return [];
  }

  const ids: string[] = [];

  for (const entry of value) {
    if (typeof entry !== "string" || !UUID_PATTERN.test(entry.trim())) {
      errors.push({ field, message: `${field} must contain valid UUID ids.` });
      return [];
    }

    ids.push(entry.trim());
  }

  return Array.from(new Set(ids));
}

export function validateCreateUserInput(
  body: unknown
): Result<CreateUserInput> {
  const errors: ValidationError[] = [];
  const record = (body ?? {}) as Record<string, unknown>;

  if (!isNonEmptyString(record.displayName)) {
    errors.push({ field: "displayName", message: "displayName is required." });
  }

  if (!isNonEmptyString(record.loginIdentifier)) {
    errors.push({
      field: "loginIdentifier",
      message: "loginIdentifier is required."
    });
  }

  if (typeof record.password !== "string" || record.password.length === 0) {
    errors.push({ field: "password", message: "password is required." });
  } else if (record.password.length < MIN_PASSWORD_LENGTH) {
    errors.push({
      field: "password",
      message: `password must be at least ${MIN_PASSWORD_LENGTH} characters.`
    });
  }

  const roleIds = validateIdList(record.roleIds, "roleIds", errors);

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      displayName: (record.displayName as string).trim(),
      loginIdentifier: (record.loginIdentifier as string).trim(),
      password: record.password as string,
      roleIds
    }
  };
}

export function validateUpdateUserInput(
  body: unknown
): Result<UpdateUserInput> {
  const errors: ValidationError[] = [];
  const record = (body ?? {}) as Record<string, unknown>;
  const value: UpdateUserInput = {};

  if (record.displayName !== undefined) {
    if (!isNonEmptyString(record.displayName)) {
      errors.push({
        field: "displayName",
        message: "displayName must be a non-empty string."
      });
    } else {
      value.displayName = (record.displayName as string).trim();
    }
  }

  if (record.status !== undefined) {
    if (
      typeof record.status !== "string" ||
      !USER_STATUSES.has(record.status)
    ) {
      errors.push({
        field: "status",
        message: "status must be 'active' or 'inactive'."
      });
    } else {
      value.status = record.status as "active" | "inactive";
    }
  }

  if (errors.length === 0 && value.displayName === undefined && !value.status) {
    errors.push({
      field: "body",
      message: "Provide at least one of displayName or status."
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, value };
}

export function validateCreateRoleInput(
  body: unknown
): Result<CreateRoleInput> {
  const errors: ValidationError[] = [];
  const record = (body ?? {}) as Record<string, unknown>;

  if (!isNonEmptyString(record.roleCode)) {
    errors.push({ field: "roleCode", message: "roleCode is required." });
  } else if (!ROLE_CODE_PATTERN.test((record.roleCode as string).trim())) {
    errors.push({
      field: "roleCode",
      message:
        "roleCode must be lowercase and start with a letter (a-z, 0-9, _)."
    });
  }

  if (!isNonEmptyString(record.roleName)) {
    errors.push({ field: "roleName", message: "roleName is required." });
  }

  const permissionIds = validateIdList(
    record.permissionIds,
    "permissionIds",
    errors
  );

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      roleCode: (record.roleCode as string).trim(),
      roleName: (record.roleName as string).trim(),
      permissionIds
    }
  };
}

export function validateUpdateRoleInput(
  body: unknown
): Result<UpdateRoleInput> {
  const errors: ValidationError[] = [];
  const record = (body ?? {}) as Record<string, unknown>;
  const value: UpdateRoleInput = {};

  if (record.roleName !== undefined) {
    if (!isNonEmptyString(record.roleName)) {
      errors.push({
        field: "roleName",
        message: "roleName must be a non-empty string."
      });
    } else {
      value.roleName = (record.roleName as string).trim();
    }
  }

  if (record.permissionIds !== undefined) {
    value.permissionIds = validateIdList(
      record.permissionIds,
      "permissionIds",
      errors
    );
  }

  if (
    errors.length === 0 &&
    value.roleName === undefined &&
    value.permissionIds === undefined
  ) {
    errors.push({
      field: "body",
      message: "Provide at least one of roleName or permissionIds."
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, value };
}
