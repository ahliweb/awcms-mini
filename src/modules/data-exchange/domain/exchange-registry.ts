/**
 * Exchange descriptor registry validation gate (Issue #752, epic #738
 * platform-evolution Wave 3). Pure code-registry validation — no I/O, no
 * database, no network — same shape as `data-lifecycle/domain/lifecycle-
 * registry.ts`'s `validateLifecycleRegistry`. Unlike that file (wired into
 * `bun run check` via its own named script/CI step), this registry's
 * validation is exercised by a unit test only
 * (`tests/unit/data-exchange-registry.test.ts`) — deliberately NOT wired as
 * a new `bun run X:check` script/CI step, to avoid adding a new named CI
 * step while several sibling Wave-3 issues are concurrently editing
 * `.github/workflows/ci.yml` (this issue's own scope note). `bun test`
 * (part of `bun run check`) already exercises this function against the
 * real registry.
 *
 * Every `ExchangeDescriptor` is declared by its OWNING module's own
 * `module.ts` (`ModuleDescriptor.dataExchange`, see `_shared/module-
 * contract.ts`) — this file only AGGREGATES (`collectExchangeDescriptors`)
 * and VALIDATES what modules already declared. It never invents a
 * descriptor and never reaches into another module's schema.
 */
import type {
  ExchangeDescriptor,
  ModuleDescriptor
} from "../../_shared/module-contract";

const DESCRIPTOR_KEY_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/** `requiredPermission` must be a well-formed `module_key.activity_code.action` permission key (`identity-access/domain/access-control.ts`'s own `permissionKey()` format) — security-auditor finding on PR #782: a malformed value would silently fail closed at runtime (`descriptor-authorization.ts`'s own defense), but catching the shape at registry-validation time (CI, `bun test`) is a much earlier, cheaper signal than a runtime 500 on a real request. */
const PERMISSION_KEY_PATTERN =
  /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/** Sane upper bound on `limits.maxFileBytes` — must never exceed the HTTP-layer hard ceiling (`src/lib/security/request-body-limit.ts`'s `BODY_SIZE_HARD_CEILING_BYTES`, 10 MiB) since intake always goes through that shared reader first; a descriptor claiming more would be silently truncated by the HTTP layer regardless. */
export const MAX_EXCHANGE_FILE_BYTES = 10 * 1024 * 1024;

/** Sane upper bound on `limits.maxRowCount` — defense in depth against a descriptor accidentally declaring an effectively-unbounded batch, mirroring `data-lifecycle`'s `MAX_LIFECYCLE_BATCH_LIMIT` precedent. */
export const MAX_EXCHANGE_ROW_COUNT = 50_000;

export const MAX_EXCHANGE_FIELDS_PER_ROW = 200;

export const VALID_EXCHANGE_FORMATS: readonly string[] = ["csv", "json"];
export const VALID_EXCHANGE_DIRECTIONS: readonly string[] = [
  "import",
  "export",
  "both"
];

export type ExchangeRegistryIssue = {
  descriptorKey: string;
  message: string;
};

export function formatExchangeRegistryIssue(
  issue: ExchangeRegistryIssue
): string {
  return `[${issue.descriptorKey}] ${issue.message}`;
}

/** Flattens every registered module's own `dataExchange` array into one list. Order follows `modules` (i.e. `listModules()`), stable and deterministic. */
export function collectExchangeDescriptors(
  modules: readonly ModuleDescriptor[]
): ExchangeDescriptor[] {
  return modules.flatMap((module) => module.dataExchange ?? []);
}

function validateSingleDescriptor(
  ownerModule: ModuleDescriptor,
  descriptor: ExchangeDescriptor
): ExchangeRegistryIssue[] {
  const issues: ExchangeRegistryIssue[] = [];
  const push = (message: string) =>
    issues.push({ descriptorKey: descriptor.key || "(missing key)", message });

  if (!descriptor.key || !DESCRIPTOR_KEY_PATTERN.test(descriptor.key)) {
    push(
      `key must be non-empty and match "<module_key>.<resource_shortname>" (got ${JSON.stringify(descriptor.key)}).`
    );
  }

  if (descriptor.ownerModuleKey !== ownerModule.key) {
    push(
      `ownerModuleKey (${JSON.stringify(descriptor.ownerModuleKey)}) must equal the declaring module's own key (${JSON.stringify(ownerModule.key)}) — a module must not declare a descriptor it claims another module owns.`
    );
  }

  if (!VALID_EXCHANGE_DIRECTIONS.includes(descriptor.direction)) {
    push(
      `direction must be one of ${VALID_EXCHANGE_DIRECTIONS.join(", ")} (got ${JSON.stringify(descriptor.direction)}).`
    );
  }

  if (!descriptor.formats || descriptor.formats.length === 0) {
    push("formats must declare at least one of csv/json.");
  } else if (
    descriptor.formats.some(
      (format) => !VALID_EXCHANGE_FORMATS.includes(format)
    )
  ) {
    push(
      `formats must only contain ${VALID_EXCHANGE_FORMATS.join(", ")} (got ${JSON.stringify(descriptor.formats)}).`
    );
  }

  if (!descriptor.schemaVersion) {
    push("schemaVersion is required.");
  }

  if (!descriptor.adapterRegistryKey) {
    push(
      "adapterRegistryKey is required — the real DataExchangeAdapterPort implementation this descriptor resolves to via infrastructure/exchange-adapter-registry.ts."
    );
  }

  if (!descriptor.limits) {
    push("limits is required.");
  } else {
    const { maxFileBytes, maxRowCount, maxFieldsPerRow } = descriptor.limits;

    if (
      !Number.isFinite(maxFileBytes) ||
      maxFileBytes <= 0 ||
      maxFileBytes > MAX_EXCHANGE_FILE_BYTES
    ) {
      push(
        `limits.maxFileBytes must be a positive number no greater than ${MAX_EXCHANGE_FILE_BYTES} (got ${maxFileBytes}).`
      );
    }

    if (
      !Number.isFinite(maxRowCount) ||
      maxRowCount <= 0 ||
      maxRowCount > MAX_EXCHANGE_ROW_COUNT
    ) {
      push(
        `limits.maxRowCount must be a positive number no greater than ${MAX_EXCHANGE_ROW_COUNT} (got ${maxRowCount}) — intake must never be unbounded.`
      );
    }

    if (
      !Number.isFinite(maxFieldsPerRow) ||
      maxFieldsPerRow <= 0 ||
      maxFieldsPerRow > MAX_EXCHANGE_FIELDS_PER_ROW
    ) {
      push(
        `limits.maxFieldsPerRow must be a positive number no greater than ${MAX_EXCHANGE_FIELDS_PER_ROW} (got ${maxFieldsPerRow}).`
      );
    }
  }

  // Issue #820 Cacat 1: `sensitiveFields` used to be optional, and its
  // absence made the preview route return every staged value RAW with no
  // raw-value permission check at all — forgetting to declare it OPENED the
  // data instead of closing it. It is now mandatory: a module must state
  // `{ fieldNames: [] }` affirmatively rather than say nothing.
  if (!descriptor.sensitiveFields) {
    push(
      "sensitiveFields is required — declare { fieldNames: [] } to state explicitly that no field is sensitive."
    );
  } else if (
    descriptor.sensitiveFields.fieldNames.length > 0 &&
    !descriptor.sensitiveFields.rawValuePermission
  ) {
    push(
      "sensitiveFields.rawValuePermission is required whenever sensitiveFields.fieldNames is non-empty."
    );
  }

  const naturalKeyField = descriptor.sensitiveFields?.naturalKeyField;
  if (naturalKeyField !== undefined && naturalKeyField.length === 0) {
    push(
      "sensitiveFields.naturalKeyField must be a non-empty parsed-row field name when declared."
    );
  }

  if (
    descriptor.requiredPermission &&
    !PERMISSION_KEY_PATTERN.test(descriptor.requiredPermission)
  ) {
    push(
      `requiredPermission must match "<module_key>.<activity_code>.<action>" (got ${JSON.stringify(descriptor.requiredPermission)}).`
    );
  }

  if (
    descriptor.sensitiveFields?.rawValuePermission &&
    !PERMISSION_KEY_PATTERN.test(descriptor.sensitiveFields.rawValuePermission)
  ) {
    push(
      `sensitiveFields.rawValuePermission must match "<module_key>.<activity_code>.<action>" (got ${JSON.stringify(descriptor.sensitiveFields.rawValuePermission)}).`
    );
  }

  if (!descriptor.description) {
    push("description is required.");
  }

  return issues;
}

export type ExchangeRegistryValidationResult = {
  valid: boolean;
  issues: ExchangeRegistryIssue[];
  descriptors: readonly ExchangeDescriptor[];
};

/**
 * Validates the WHOLE registry: per-descriptor structural validity
 * (`validateSingleDescriptor`), plus the cross-descriptor invariant that
 * `key` is unique across the whole registry (a descriptor key doubles as
 * the public `importKey`/`exportKey` API clients request by — a collision
 * would make two unrelated contracts indistinguishable).
 */
export function validateExchangeRegistry(
  modules: readonly ModuleDescriptor[]
): ExchangeRegistryValidationResult {
  const issues: ExchangeRegistryIssue[] = [];
  const allDescriptors: ExchangeDescriptor[] = [];
  const seenKeys = new Map<string, number>();

  for (const module of modules) {
    for (const descriptor of module.dataExchange ?? []) {
      allDescriptors.push(descriptor);
      issues.push(...validateSingleDescriptor(module, descriptor));

      seenKeys.set(descriptor.key, (seenKeys.get(descriptor.key) ?? 0) + 1);
    }
  }

  for (const [key, count] of seenKeys) {
    if (count > 1) {
      issues.push({
        descriptorKey: key,
        message: `key is registered ${count} times — descriptor keys must be unique across the whole registry.`
      });
    }
  }

  return { valid: issues.length === 0, issues, descriptors: allDescriptors };
}
