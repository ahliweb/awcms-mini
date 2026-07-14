# integration-hub

Issue #754, epic `platform-evolution` #738, Wave 3. `type: "system"` —
ADR-0013 §1/§6 classifies `integration_hub` as a System Foundation
candidate (status pengiriman envelope inbound/outbound — bukan data
bisnis final). Admission decision: `docs/adr/0017-integration-hub-module-
admission.md`. Depends on Issue #742 (`domain_event_runtime`) and Issue
#745 (`data_lifecycle`), both merged.

## Why this module exists

AWCMS-Mini already has provider-specific integrations inside their owning
modules (Mailketing in `email`, R2 in `sync_storage`/`news_portal`,
Cloudflare DNS in `tenant_domain`, Telegram/Meta in `social_publishing`)
and several reliable outbox/worker patterns. What was missing is a
**generic, provider-neutral integration boundary**: signed inbound
webhooks (HMAC signature verification with timing-safe comparison, replay
protection enforced by a real DB uniqueness constraint), normalized
events (translating provider-specific payloads into this repo's own
domain-event shape via `domain_event_runtime`), outbound event
subscriptions (other systems/tenants get notified of internal events,
with reliable delivery), and provider health tracking — mechanisms every
future provider-owning module would otherwise reinvent.

## What this module does NOT do

- **Call a specific business provider's API.** No Meta/Telegram/Mailketing
  HTTP call exists anywhere in this module — only a generic `fetch()` to
  a tenant-configured `target_url` (outbound) and passive receipt of a
  webhook (inbound). Provider-specific mapping/credentials stay owned by
  the module that owns that capability, via `_shared/ports/
integration-adapter-port.ts`.
- **Ship a real business adapter.** This foundation issue ships exactly
  two self-contained FIXTURE inbound signature schemes
  (`fixture_hmac_sha256`, `fixture_shared_secret_nonce`) and one generic
  outbound HTTP adapter (`generic_http_webhook`) — mirroring the accepted
  "foundation issue ships zero real business integrations" precedent
  (#643, #742).
- **Run a provider call inside a database transaction.** Inbound
  verification is pure/local (HMAC comparison only). Outbound delivery is
  a separate, timeout-bounded, retriable worker step
  (`bun run integration-hub:outbound:dispatch`), strictly outside any
  transaction (ADR-0006).

## Core mechanism

### Inbound

1. An operator registers an **endpoint**
   (`POST /api/v1/integration-hub/endpoints`) — an opaque, server-generated
   `endpointToken` (the URL path segment a provider POSTs to) plus a
   `secretReference` pointer (`env:VAR_NAME`, never a raw secret value).
2. A provider POSTs to `POST /api/v1/integration-hub/inbound/
{endpointToken}` — a PUBLIC endpoint (no tenant JWT; the provider has
   no AWCMS-Mini session). Tenant is resolved from the opaque token via a
   narrow `SECURITY DEFINER` bootstrap function
   (`awcms_mini_resolve_integration_endpoint_lookup`, migration 066 —
   same pattern `awcms_mini_resolve_tenant_domain_lookup`, migration 033,
   already established), before any `withTenant(...)` transaction can run.
3. `application/inbound-webhook-intake.ts`'s `processInboundWebhook` runs
   the full gate chain (endpoint/tenant status, content type, body size,
   signature verification) and — for a verified delivery — INSERTs the
   inbound delivery row with `ON CONFLICT (tenant_id, endpoint_id,
replay_key) DO NOTHING`. A zero-row result means this exact delivery
   was already processed (replay), so nothing further happens. A new row
   means this is genuinely new: the payload is normalized and
   `appendDomainEvent` is called (event type
   `awcms-mini.integration-hub.inbound-message.normalized`) — all inside
   the SAME transaction.

### Outbound

1. An operator registers a **subscription**
   (`POST /api/v1/integration-hub/subscriptions`) — an internal event type
   to listen for, a `targetUrl` (SSRF-validated at write time), and an
   optional bounded declarative `filter`.
2. `integration_hub`'s own static `domain_event_runtime` consumer
   (`integrationHubOutboundFanoutConsumer`,
   `application/outbound-fanout-consumer.ts`) is registered into
   `domain-event-runtime/infrastructure/consumer-registry.ts`'s array —
   the designated additive extension point (mirrors how
   `workflow_approval`/`organization_structure` became real event
   PRODUCERS by editing `event-type-registry.ts`; this module is the
   first real third-party CONSUMER). It runs inside the SAME transaction
   as the source event's own commit — a same-process, DB-only handler
   (zero network calls) that creates `pending`
   `awcms_mini_integration_outbound_deliveries` rows for every matching
   active subscription.
3. `bun run integration-hub:outbound:dispatch`
   (`application/outbound-dispatch.ts`) claims due rows, resolves the
   subscription's target/secret, calls
   `infrastructure/outbound-http-client.ts`'s SSRF-guarded
   `deliverOutboundWebhook` OUTSIDE any transaction, and finalizes
   (`delivered` / `retry_wait` with exponential backoff / `dead_letter`).
   A `dead_letter` delivery can be replayed by a permission-gated,
   reason-required, `Idempotency-Key`-required, audited admin action
   (`application/delivery-replay.ts`) — creates a NEW delivery row
   referencing the original, never mutates/re-queues it.

## Security notes

- **Timing-safe signature verification**: `domain/signature-primitives.ts`'s
  `timingSafeEqualHex` uses `node:crypto`'s `timingSafeEqual` (never `===`
  on the computed vs. provided signature) — same pattern
  `sync-storage/domain/sync-hmac.ts` already established for this repo.
- **Replay protection is a real DB constraint**: `UNIQUE (tenant_id,
endpoint_id, replay_key)` on `awcms_mini_integration_inbound_deliveries`
  — not an in-memory check, so it survives a restart/multi-instance
  deployment.
- **Key rotation with overlap**: an endpoint's `secretReferencePrevious`/
  `previousSecretExpiresAt` let a request signed with the OLD secret keep
  verifying until the declared overlap window elapses
  (`application/secret-resolver.ts`'s `resolvePreviousSecretIfInOverlap`).
- **SSRF protection**: `domain/ssrf-guard.ts` blocks private/link-local/
  metadata/reserved literal IPs and known metadata hostnames at
  subscription write time; `infrastructure/outbound-http-client.ts`
  re-validates AND checks every DNS-resolved address at dispatch time.
  Deployment-wide opt-out for LAN-first deployments:
  `INTEGRATION_HUB_ALLOW_PRIVATE_TARGETS=true` (doc 18). **Documented
  residual limitation**: this does not pin the resolved IP for the actual
  `fetch()` call, so a DNS-rebinding TOCTOU race is not fully closed — see
  `ssrf-guard.ts`'s own header comment.
- **Data minimization**: `raw_body_snippet` (bounded to 2000 chars,
  secret-pattern-redacted) is only ever populated for a signature-VALID
  delivery; a rejected/invalid attempt stores only a hash + size.
  `integration_hub.inbound_deliveries` is registered with `data_lifecycle`
  (Issue #745) as a `"generic"` descriptor, default 90-day retention.
- **Never logs/persists a raw secret value** — `secret_reference` fields
  are pointers (`env:VAR_NAME`) only; the resolved value is used in-memory
  for exactly one HMAC computation and never returned/logged.
- **Tenant isolation**: every table `ENABLE`+`FORCE ROW LEVEL SECURITY`,
  `tenant_id = current_setting('app.current_tenant_id')::uuid`, plus
  explicit `tenant_id` filters in every query (defense in depth).

## Tables (migration `066_awcms_mini_integration_hub_schema.sql`)

| Table                                        | Purpose                                                                |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| `awcms_mini_integration_endpoints`           | Inbound webhook endpoint identity + secret pointer(s). Soft-deletable. |
| `awcms_mini_integration_inbound_deliveries`  | Replay-protected inbound inbox. Append-only.                           |
| `awcms_mini_integration_subscriptions`       | Outbound event subscription registry. Soft-deletable.                  |
| `awcms_mini_integration_outbound_deliveries` | Per (subscription, source event) delivery/retry/dead-letter state.     |
| `awcms_mini_integration_delivery_attempts`   | Append-only outbound attempt history.                                  |
| `awcms_mini_integration_adapter_health`      | Per (tenant, adapter, direction) up/degraded/down state.               |

## API (`src/pages/api/v1/integration-hub/*`)

- `POST /api/v1/integration-hub/inbound/{endpointToken}` — public webhook
  receiver.
- `GET`/`POST /api/v1/integration-hub/endpoints`, `GET`/`DELETE .../{id}`,
  `POST .../{id}/{rotate-secret,pause,resume}`.
- `GET`/`POST /api/v1/integration-hub/subscriptions`, `GET`/`DELETE
.../{id}`, `POST .../{id}/{pause,resume}`.
- `GET /api/v1/integration-hub/deliveries/inbound`,
  `GET /api/v1/integration-hub/deliveries/outbound[/{id}]`,
  `POST .../outbound/{id}/replay`.
- `GET /api/v1/integration-hub/health`, `GET /api/v1/integration-hub/adapters`.

## Jobs

`bun run integration-hub:outbound:dispatch`
(`scripts/integration-hub-outbound-dispatch.ts`) — recommended every 1-2
minutes via cron/systemd timer. Built on the shared worker runner
(`src/lib/jobs/job-runner.ts`).

## Configuration

`INTEGRATION_HUB_ALLOW_PRIVATE_TARGETS` (default `false`, doc 18) — see
Security notes above.

## Known limitations

- `awcms_mini_integration_outbound_deliveries`/`_delivery_attempts` are
  NOT registered with `data_lifecycle` in this PR — `_delivery_attempts.
delivery_id` has a plain foreign key to `_outbound_deliveries.id`, and
  `_outbound_deliveries.replay_of_delivery_id` self-references the same
  table; `data_lifecycle`'s generic engine issues an unordered `DELETE
FROM <tableName>` per descriptor with no cross-descriptor FK-aware
  ordering, so registering both without first adding delete ordering or
  `ON DELETE` semantics risks a real foreign-key-violation purge failure.
  Follow-up issue.
- **SSRF DNS-rebinding TOCTOU gap**: see Security notes above.
- **No adapter-specific circuit breaker persistence across restarts**: the
  in-memory `getProviderCircuitBreaker` instance (fail-fast gate) resets
  on worker restart; `awcms_mini_integration_adapter_health` (the
  persisted, cross-restart-visible signal) is observability-only and does
  not itself gate dispatch attempts.
- **Outbound subscription fan-out is scoped to `integration_hub`'s own
  event type today** (`awcms-mini.integration-hub.inbound-message.
normalized`) — a future producer module wanting outbound webhook
  fan-out for its OWN event type adds it to
  `integrationHubOutboundFanoutConsumer`'s `eventTypes` array
  (`domain-event-runtime/infrastructure/consumer-registry.ts`) and to
  `subscription-directory.ts`'s allowlist check, following the same
  reviewed-source-code registration convention every other real producer/
  consumer in this repo already uses.
