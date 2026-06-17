// SatuSehat Kobar Plugin — entry point (ADR-016, ADR-018)
// Integrasi AWCMS-Mini dengan SatuSehat Kemenkes.

export { migrate } from "./migrate.mjs";
export { patientsRepository } from "./repositories/patients.mjs";
export { encountersRepository } from "./repositories/encounters.mjs";
export { syncLogsRepository } from "./repositories/sync-logs.mjs";

export const PLUGIN_ID = "satu-sehat-kobar";
