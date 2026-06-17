// SIKESRA Plugin — entry point (ADR-016, ADR-018)
// Plugin data kesehatan rakyat untuk AWCMS-Mini.
// Semua data highly_restricted; NIK selalu terenkripsi di app layer.

export { migrate } from "./migrate.mjs";
export { subjectsRepository } from "./repositories/subjects.mjs";
export { recordsRepository } from "./repositories/records.mjs";
export { recordDocumentsRepository } from "./repositories/record-documents.mjs";

export const PLUGIN_ID = "sikesra";
