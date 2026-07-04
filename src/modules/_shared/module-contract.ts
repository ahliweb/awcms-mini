/**
 * Module contract AWCMS-Mini (doc 10) — setiap modul modular monolith
 * mendeklarasikan descriptor ini di src/modules/<module>/module.ts.
 */

export type ModuleStatus = "active" | "experimental" | "deprecated";

export type ModuleDescriptor = {
  /** snake_case, unik — dipakai registry, permission namespace, audit. */
  key: string;
  name: string;
  version: string;
  status: ModuleStatus;
  description: string;
  /** Daftar module key lain yang menjadi dependency. */
  dependencies: string[];
  api?: {
    openApiPath: string;
    basePath: string;
  };
  events?: {
    asyncApiPath?: string;
    publishes?: string[];
    subscribes?: string[];
  };
};

const MODULE_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Validasi struktural descriptor; melempar Error dengan pesan jelas. */
export function assertValidModuleDescriptor(descriptor: ModuleDescriptor): void {
  if (!MODULE_KEY_PATTERN.test(descriptor.key)) {
    throw new Error(`Module key tidak valid (harus snake_case): ${descriptor.key}`);
  }
  if (!descriptor.name || !descriptor.version || !descriptor.description) {
    throw new Error(`Module ${descriptor.key}: name/version/description wajib diisi`);
  }
  if (!["active", "experimental", "deprecated"].includes(descriptor.status)) {
    throw new Error(`Module ${descriptor.key}: status tidak valid`);
  }
}
