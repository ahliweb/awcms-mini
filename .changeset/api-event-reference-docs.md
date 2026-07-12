---
"awcms-mini": minor
---

Publish a generated, versioned API and event reference document (Issue
#700, epic #679 platform-hardening) — `docs/awcms-mini/api-reference.md`,
built by a new `bun run api:docs:generate` (`scripts/api-docs-generate.ts`)
from the CANONICAL bundled contracts
(`openapi/awcms-mini-public-api.openapi.yaml`, produced by
`bun run openapi:bundle`, Issue #695, and
`asyncapi/awcms-mini-domain-events.asyncapi.yaml`) — never from the OpenAPI
source fragments directly.

The generated doc covers: authentication model, tenant context, keyset
pagination, idempotency, correlation/request IDs, the standard success/
error envelope and error codes, request body size limits, a conditional
feature-gates section (derived by scanning the contract for tenant-mode
gated behavior), every REST operation grouped by module with parameters/
request/response schemas, a schema appendix with synthetic example
payloads, every AsyncAPI domain event channel, and a compatibility/
deprecation policy section (ADR-0008) that auto-lists any
`deprecated: true` operation/schema/channel.

All example values are synthesized from JSON Schema shape alone (nil UUID,
fixed placeholder dates, `example.com` hostnames only) — never copied from
real config/logs/fixtures, so no secret or production hostname can enter
the document. Generation is fully deterministic and offline (no network
access, no external CLI, no SaaS).

A new read-only `bun run api:docs:check` (`scripts/api-docs-check.ts`),
wired into `bun run check`, regenerates the doc in memory and fails the
build if the committed file is stale relative to the bundled contracts —
the same `checkBundleFreshness` pattern the OpenAPI bundle itself uses.

The generated Markdown file requires no server or internet connection to
read — open it with any text editor, `less`, or a local Markdown
previewer, satisfying offline/LAN operator access.
