import { defineModule } from "../_shared/module-contract";

export const loggingModule = defineModule({
  key: "logging",
  name: "Logging & Audit Trail",
  version: "1.0.0",
  status: "active",
  description:
    "Cross-module audit trail (awcms_mini_audit_events), structured JSON logging, and correlation ID propagation. Complements, not replaces, domain events and per-module audit tables.",
  dependencies: ["tenant_admin"],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/logs"
  },
  jobs: [
    {
      command: "bun run logs:audit:purge",
      purpose:
        "Delete awcms_mini_audit_events rows past their retention cutoff for every active tenant, in bounded batches.",
      recommendedSchedule: "Daily via cron/systemd timer.",
      environmentNotes:
        "Pure database operation — no external network dependency.",
      safeInOfflineLan: true
    }
  ]
});
