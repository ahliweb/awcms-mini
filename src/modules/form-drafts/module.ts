import { defineModule } from "../_shared/module-contract";

export const formDraftsModule = defineModule({
  key: "form_drafts",
  name: "Form Drafts",
  version: "1.0.0",
  status: "active",
  description:
    "Generic, domain-agnostic server-side draft store for the reusable wizard pattern (create/update/read/submit/delete a tenant-scoped JSONB payload, denylist-validated against secret-shaped fields). No domain-specific logic — a derived module owns what a draft's payload actually means.",
  dependencies: ["identity_access"],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/form-drafts"
  },
  jobs: [
    {
      command: "bun run form-drafts:purge",
      purpose:
        "Expire overdue draft rows, then physically delete expired/abandoned drafts past the retention cutoff, for every active tenant.",
      recommendedSchedule: "Daily via cron/systemd timer.",
      environmentNotes:
        "Pure database operation — no external network dependency.",
      safeInOfflineLan: true
    }
  ]
});
