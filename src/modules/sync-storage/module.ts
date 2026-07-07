import { defineModule } from "../_shared/module-contract";

export const syncStorageModule = defineModule({
  key: "sync_storage",
  name: "Sync Storage",
  version: "1.0.0",
  status: "active",
  description:
    "Offline-first sync nodes, outbox/inbox event exchange, and HMAC-signed push/pull with anti-replay.",
  dependencies: ["tenant_admin"],
  api: {
    openApiPath: "openapi/awcms-mini-public-api.openapi.yaml",
    basePath: "/api/v1/sync"
  },
  jobs: [
    {
      command: "bun run sync:objects:dispatch",
      purpose:
        "Drain the due object sync upload queue (claim-lease, retry/backoff, circuit breaker) for every active tenant.",
      recommendedSchedule: "Every 1-2 minutes via cron/systemd timer.",
      environmentNotes:
        "No-op when R2 is disabled (STORAGE_DRIVER=local) — safe to schedule regardless of deployment profile.",
      safeInOfflineLan: true
    }
  ]
});
