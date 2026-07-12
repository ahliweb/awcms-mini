---
"awcms-mini": minor
---

Add a provider-neutral, privacy-safe metrics port for operational
observability (Issue #698, epic #679 platform-hardening) —
`src/lib/observability/metrics-port.ts` (`MetricsPort` contract,
`METRIC_DEFINITIONS` cardinality/privacy registry,
`recordCounter`/`recordHistogram`/`recordGauge`), a default no-op adapter
(zero I/O, zero external collector needed for offline/LAN deployments), an
in-memory adapter for tests, and a dependency-free Prometheus text-
exposition adapter example
(`src/lib/observability/adapters/prometheus-text-adapter.ts`, not wired up
by default).

Hooked into the existing shared mechanisms, not duplicated per call site:
`http_requests_total`/`http_request_duration_ms` from `src/middleware.ts`
(via `context.routePattern`, never a concrete request id);
`job_run_total`/`job_run_duration_ms`/`job_run_item_count` from
`src/lib/jobs/job-runner.ts`'s single `buildResult` choke point;
`provider_call_total`/`provider_call_duration_ms`/`provider_circuit_state`
from a new `decorateWithMetrics` wrapper around
`getDatabaseCircuitBreaker`/`getProviderCircuitBreaker`
(`src/lib/database/circuit-breaker.ts`), which also adds
`deriveProviderFamilyLabel` to keep a tenant-scoped breaker registry key
(Issue #610 shape) from ever reaching a metric label; and
`db_pool_work_class_active`/`db_pool_work_class_queued` from
`src/lib/database/work-class.ts`.

Adds a new authorized endpoint `GET /api/v1/logs/observability/dependency-health`
(permission `logging.observability.read`, migration
`047_awcms_mini_observability_metrics_permission.sql`) distinguishing
local dependencies (database) from optional external providers (email,
object storage, SSO/OIDC, Cloudflare DNS, …), aggregated by the same
bounded provider family label the metrics use — never a raw registry key
or tenant id.

See `docs/awcms-mini/observability-metrics.md` for architecture, the
per-metric cardinality/privacy review, initial SLIs/SLOs with burn-rate
guidance, dashboard/runbook examples, and the optional Prometheus/
OpenTelemetry adapter pattern.
