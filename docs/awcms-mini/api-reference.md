# AWCMS-Mini API & Event Reference (generated)

> **GENERATED FILE — do not edit by hand.** Produced by
> `bun run api:docs:generate` (`scripts/api-docs-generate.ts`, Issue #700,
> epic #679) from the bundled contracts below. Edit the OpenAPI fragments
> (`openapi/awcms-mini-public-api.src.yaml` + `openapi/modules/*.yaml`) or
> the AsyncAPI file, regenerate the OpenAPI bundle
> (`bun run openapi:bundle`), then regenerate this document — never edit
> it directly. `bun run api:docs:check` (part of `bun run check`) fails
> the build if this file is stale relative to the bundled contracts.

- **REST contract**: [`openapi/awcms-mini-public-api.openapi.yaml`](../../openapi/awcms-mini-public-api.openapi.yaml) — `info.version` `1.0.0`.
- **Event contract**: [`asyncapi/awcms-mini-domain-events.asyncapi.yaml`](../../asyncapi/awcms-mini-domain-events.asyncapi.yaml) — `info.version` `1.0.0`.

Contract version is independent SemVer, bumped only when the contract
SHAPE itself changes (ADR-0008 — see
[`docs/adr/0008-independent-contract-and-module-versioning.md`](../adr/0008-independent-contract-and-module-versioning.md)),
not on every package release.

**Version selection.** This document is generated 1:1 from the contract
files committed at the same git commit/tag you're viewing it at — there is
no interactive version switcher (no SaaS, no build-time JS required to
read it offline). To read the reference for a prior release, check out
that release's git tag (`git tag -l`, see `CHANGELOG.md`) and open this
same path there, or regenerate locally with `bun run api:docs:generate`
after checking it out.

**Offline/LAN use.** This is a plain, self-contained Markdown file with no
external image/script/font references — open it with any text editor,
`less`, a local Markdown previewer, or `git show <tag>:docs/awcms-mini/api-reference.md`.
No server or internet connection is required.

## Contract overview

**AWCMS-Mini Public API** — version `1.0.0`.

Stable REST contract for the AWCMS-Mini modular monolith base (ADR-0008 — contract version is independent of the package release version; bumped only when the contract shape itself changes).

**Request body size limits** (Issue #686, epic #679): every endpoint that accepts a body enforces an application-level size cap, independent of any reverse-proxy limit — most endpoints allow up to 128 KiB; content-heavy endpoints (blog posts/pages/templates/theme, email templates/announcements, news-portal homepage sections, sync push and object-enqueue batches) allow up to 5 MiB. A body over the limit — whether declared via `Content-Length` or discovered while streaming a chunked/ unlabeled body — is rejected with `413 Payload Too Large` and error code `PAYLOAD_TOO_LARGE`, using the same envelope as every other error response in this contract. No endpoint accepts a body larger than 10 MiB.

## Cross-cutting conventions

### Authentication model

| Scheme         | Kind                                      | Description                                                        |
| -------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| `bearerAuth`   | http (bearer, JWT)                        | Standard authenticated API access.                                 |
| `tenantHeader` | apiKey (header: `X-AWCMS-Mini-Tenant-ID`) | Active tenant context for tenant-scoped API.                       |
| `syncHmac`     | apiKey (header: `X-AWCMS-Mini-Signature`) | HMAC signature for sync endpoints with node and timestamp headers. |

Every operation below states its own security requirement explicitly —
either a real requirement (usually `bearerAuth` + `tenantHeader`
together) or `none (public endpoint)`. There is no implicit "some
endpoints just don't need auth" — `bun run api:spec:check`'s public
operation allow-list (`ALLOWED_PUBLIC_OPERATIONS` in
`scripts/api-spec-check.ts`) enforces this stays reviewed.

### Tenant context

`tenantHeader` (`X-AWCMS-Mini-Tenant-ID`) carries the active tenant for
every tenant-scoped request; the server also sets PostgreSQL Row-Level
Security context from the authenticated session, never trusting the
header alone as the sole isolation boundary (defense in depth — see
[`16_backend_data_access_integration.md`](16_backend_data_access_integration.md#rls-context-kritis-untuk-multi-tenant)).

### Pagination

List endpoints use opaque **keyset** pagination via the `cursor` query
parameter (see the `Cursor` row in the standard parameters table below) —
never large offsets. Pass the previous page's `nextCursor` value back
as `cursor`; omit it for the first page.

### Idempotency

High-risk mutations require the `Idempotency-Key` header (see the
`IdempotencyKey` row below) — see
[`05_openapi_asyncapi_detail.md`](05_openapi_asyncapi_detail.md#endpoint-wajib-idempotency)
for the full list of endpoints that require it and the replay-conflict
behavior.

### Correlation & request IDs

`X-Correlation-ID` and `X-Request-ID` (see the standard parameters
table) are optional caller-supplied trace IDs, echoed back in every
response's `meta` object (`ApiMeta.correlationId`/`requestId`) — see
[`05_openapi_asyncapi_detail.md`](05_openapi_asyncapi_detail.md#header-standard).

### Standard parameters

| Name             | Header/query                      | Required | Type                            | Description                                                                                    |
| ---------------- | --------------------------------- | -------- | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `CorrelationId`  | `X-Correlation-ID` (header)       | no       | string                          | Optional server-side trace correlation ID.                                                     |
| `RequestId`      | `X-Request-ID` (header)           | no       | string                          | Optional client-generated request trace ID.                                                    |
| `AcceptLanguage` | `Accept-Language` (header)        | no       | string                          | Preferred response locale.                                                                     |
| `IdempotencyKey` | `Idempotency-Key` (header)        | yes      | string                          | Required for high-risk mutations.                                                              |
| `SyncNodeId`     | `X-AWCMS-Mini-Node-ID` (header)   | yes      | string                          | Sync node identifier.                                                                          |
| `SyncTimestamp`  | `X-AWCMS-Mini-Timestamp` (header) | yes      | string (date-time)              | Request timestamp used for anti-replay checks.                                                 |
| `SyncSignature`  | `X-AWCMS-Mini-Signature` (header) | yes      | string                          | HMAC signature over the sync request.                                                          |
| `Cursor`         | `cursor` (query)                  | no       | string                          | Opaque keyset pagination cursor from a previous page's `nextCursor`. Omit for the first page.  |
| `AnalyticsRange` | `range` (query)                   | no       | enum(`24h`, `7d`, `30d`, `12m`) | Aggregate window. An unrecognized value is a `400 VALIDATION_ERROR`, never silently defaulted. |

### Standard success envelope

Every `2xx` response body is an `ApiSuccess`-shaped object (or, per
operation, `ApiSuccess<SomeSchema>` — `data` typed to that operation's
specific payload):

```json
{
  "success": true,
  "data": "(operation-specific payload — see each operation's response)",
  "meta": {
    "correlationId": "00000000-0000-0000-0000-000000000000",
    "requestId": "00000000-0000-0000-0000-000000000000"
  }
}
```

### Standard error envelope

Every non-`2xx`/`3xx` response resolves to the same `ApiError` shape —
never an ad-hoc inline error shape (`bun run api:spec:check`'s standard
error schema check enforces this):

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "string",
    "details": [
      {
        "field": "string",
        "message": "string",
        "code": "string"
      }
    ]
  },
  "meta": {
    "correlationId": "00000000-0000-0000-0000-000000000000",
    "requestId": "00000000-0000-0000-0000-000000000000"
  }
}
```

**Error codes** (`ErrorCode` enum): `VALIDATION_ERROR`, `AUTH_REQUIRED`, `AUTH_INVALID_CREDENTIALS`, `TOKEN_EXPIRED`, `ACCESS_DENIED`, `TENANT_REQUIRED`, `RESOURCE_NOT_FOUND`, `RESOURCE_DELETED`, `IDEMPOTENCY_REQUIRED`, `IDEMPOTENCY_CONFLICT`, `WORKFLOW_APPROVAL_REQUIRED`, `SYNC_CONFLICT`, `DATABASE_BUSY`, `PROVIDER_ERROR`, `INTERNAL_ERROR`.

**Standard error responses**:

| Response          | Schema                                 | Description                                                                                                                                                                                                      |
| ----------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BadRequest`      | [`ApiError`](#standard-error-envelope) | Validation or request error.                                                                                                                                                                                     |
| `Unauthorized`    | [`ApiError`](#standard-error-envelope) | Authentication required or expired.                                                                                                                                                                              |
| `Forbidden`       | [`ApiError`](#standard-error-envelope) | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   |
| `NotFound`        | [`ApiError`](#standard-error-envelope) | Resource not found or hidden by soft-delete policy.                                                                                                                                                              |
| `InternalError`   | [`ApiError`](#standard-error-envelope) | Internal server error without stack trace.                                                                                                                                                                       |
| `PayloadTooLarge` | [`ApiError`](#standard-error-envelope) | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. |

### Request body size limits and rate limiting

Request body size limits are declared in the contract description above
(per-endpoint caps, `413 PAYLOAD_TOO_LARGE` on overflow — Issue #686).
General API rate limiting is NOT part of this REST contract; today only
specific pre-auth endpoints (`/auth/login`, `/auth/password/forgot`,
`/auth/password/reset`, MFA verification) apply a source+tenant rate
limit (`429` + `Retry-After`, config in
[`18_configuration_env_reference.md`](18_configuration_env_reference.md)) —
see [`20_threat_model_security_architecture.md`](20_threat_model_security_architecture.md)
§OWASP A07 for the full picture. Edge/proxy-level rate limiting for the
rest of the API is a deployment-layer responsibility, not this base.

## Conditional feature gates

Operations/schemas whose behavior changes based on a tenant-level feature
flag or mode (derived by scanning the contract for "mode is active" in
descriptions — search the bundled OpenAPI file directly for the full
wording of each):

- Schema `BlogPageItem`.`contentJson`: When full-online R2-only news portal mode is active for this tenant (Issue #636), an image gallery block item (mediaType image) must use mediaObjectId referencing a verified/attached same-tenant media object, never a raw url.
- Schema `BlogPageItem`.`featuredMediaId`: When full-online R2-only news portal mode is active for this tenant (Issue #636), must reference an existing, same-tenant media object (Issue #633) with status verified or attached — never a local path or arbitrary external URL. A non-conforming reference is rejected with 422 NEWS_MEDIA_REFERENCE_INVALID. Outside that mode, only the UUID shape is validated.
- Schema `BlogPostItem`.`contentJson`: Structured content (e.g. block/rich-text tree). Opaque to the API. When full-online R2-only news portal mode is active for this tenant (Issue #636), an image gallery block item (mediaType image) must use mediaObjectId referencing a verified/attached same-tenant media object, never a raw url — a non-conforming reference is rejected with 422 NEWS_MEDIA_REFERENCE_INVALID.
- Schema `BlogPostItem`.`featuredMediaId`: When full-online R2-only news portal mode is active for this tenant (Issue #636), must reference an existing, same-tenant media object (Issue #633) with status verified or attached — never a local path or arbitrary external URL. A non-conforming reference is rejected with 422 NEWS_MEDIA_REFERENCE_INVALID. Outside that mode, only the UUID shape is validated.
- Schema `CreateBlogPageRequest`.`contentJson`: When full-online R2-only news portal mode is active for this tenant (Issue #636), an image gallery block item (mediaType image) must use mediaObjectId referencing a verified/attached same-tenant media object, never a raw url.
- Schema `CreateBlogPageRequest`.`featuredMediaId`: When full-online R2-only news portal mode is active for this tenant (Issue #636), must reference an existing, same-tenant media object (Issue #633) with status verified or attached — never a local path or arbitrary external URL. A non-conforming reference is rejected with 422 NEWS_MEDIA_REFERENCE_INVALID. Outside that mode, only the UUID shape is validated.
- Schema `CreateBlogPostRequest`.`contentJson`: When full-online R2-only news portal mode is active for this tenant (Issue #636), an image gallery block item (mediaType image) must use mediaObjectId referencing a verified/attached same-tenant media object, never a raw url.
- Schema `CreateBlogPostRequest`.`featuredMediaId`: When full-online R2-only news portal mode is active for this tenant (Issue #636), must reference an existing, same-tenant media object (Issue #633) with status verified or attached — never a local path or arbitrary external URL. A non-conforming reference is rejected with 422 NEWS_MEDIA_REFERENCE_INVALID. Outside that mode, only the UUID shape is validated.
- Schema `UpdateBlogPageRequest`.`contentJson`: When full-online R2-only news portal mode is active for this tenant (Issue #636), an image gallery block item (mediaType image) must use mediaObjectId referencing a verified/attached same-tenant media object, never a raw url.
- Schema `UpdateBlogPageRequest`.`featuredMediaId`: When full-online R2-only news portal mode is active for this tenant (Issue #636), must reference an existing, same-tenant media object (Issue #633) with status verified or attached — never a local path or arbitrary external URL. A non-conforming reference is rejected with 422 NEWS_MEDIA_REFERENCE_INVALID. Outside that mode, only the UUID shape is validated.
- Schema `UpdateBlogPostRequest`.`contentJson`: When full-online R2-only news portal mode is active for this tenant (Issue #636), an image gallery block item (mediaType image) must use mediaObjectId referencing a verified/attached same-tenant media object, never a raw url.
- Schema `UpdateBlogPostRequest`.`featuredMediaId`: When full-online R2-only news portal mode is active for this tenant (Issue #636), must reference an existing, same-tenant media object (Issue #633) with status verified or attached — never a local path or arbitrary external URL. A non-conforming reference is rejected with 422 NEWS_MEDIA_REFERENCE_INVALID. Outside that mode, only the UUID shape is validated.

## REST operations by module

## Foundation

Foundation and platform endpoints.

### `GET /api/v1/health` — Check foundation health

- **operationId**: `getHealth`
- **Security**: none (public endpoint)

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |
| `Accept-Language`  | header | no       | string | Preferred response locale.                  |

**Responses**

| Status | Description                                | Schema                                                                                       |
| ------ | ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 200    | Service health status.                     | [`ApiSuccess`](#standard-success-envelope)&lt;[`HealthResponse`](#schema-healthresponse)&gt; |
| 500    | Internal server error without stack trace. | [`ApiError`](#standard-error-envelope)                                                       |

## Tenant Admin

Tenant, office, and the one-time setup wizard.

### `GET /api/v1/settings` — Read the tenant's profile and settings

- **operationId**: `settingsGet`
- **Security**: bearerAuth + tenantHeader

Joins awcms_mini_tenants (tenant_name, legal_name, default_locale, default_theme) and awcms_mini_tenant_settings (timezone, feature_flags).

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                         | Schema                                                                                                       |
| ------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 200    | Tenant profile and settings.                        | [`ApiSuccess`](#standard-success-envelope)&lt;[`TenantSettingsResponse`](#schema-tenantsettingsresponse)&gt; |
| 401    | Authentication required or expired.                 | [`ApiError`](#standard-error-envelope)                                                                       |
| 403    | Access denied by RBAC, ABAC, or tenant policy.      | [`ApiError`](#standard-error-envelope)                                                                       |
| 404    | Resource not found or hidden by soft-delete policy. | [`ApiError`](#standard-error-envelope)                                                                       |
| 500    | Internal server error without stack trace.          | [`ApiError`](#standard-error-envelope)                                                                       |

### `PATCH /api/v1/settings` — Update a subset of the tenant's profile and settings

- **operationId**: `settingsUpdate`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): [`UpdateTenantSettingsRequest`](#schema-updatetenantsettingsrequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                                       |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 200    | Settings updated.                                                                                                                                                                                                | [`ApiSuccess`](#standard-success-envelope)&lt;[`TenantSettingsResponse`](#schema-tenantsettingsresponse)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                                       |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                                       |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                                       |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                                       |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                                       |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                                       |

### `POST /api/v1/setup/initialize` — Bootstrap the first tenant, owner, office, and access assignment

- **operationId**: `setupInitialize`
- **Security**: none (public endpoint)

When full-online auth security hardening AND `TURNSTILE_ENABLED=true` are both active (Issue #588), `turnstileToken` is verified before creating the tenant/owner: missing -> `400 TURNSTILE_REQUIRED`, invalid -> `400 TURNSTILE_INVALID`.

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): [`SetupInitializeRequest`](#schema-setupinitializerequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 200    | Setup completed; tenant, owner, and office created.                                                                                                                                                              | [`ApiSuccess`](#standard-success-envelope)&lt;[`SetupInitializeResponse`](#schema-setupinitializeresponse)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                                         |
| 403    | Setup has already been completed and is permanently locked.                                                                                                                                                      | [`ApiError`](#standard-error-envelope)                                                                         |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                                         |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                                         |

### `GET /api/v1/setup/status` — Check whether the setup wizard has already run

- **operationId**: `setupGetStatus`
- **Security**: none (public endpoint)

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                | Schema                                                                                                 |
| ------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 200    | Setup lock status.                         | [`ApiSuccess`](#standard-success-envelope)&lt;[`SetupStatusResponse`](#schema-setupstatusresponse)&gt; |
| 500    | Internal server error without stack trace. | [`ApiError`](#standard-error-envelope)                                                                 |

## Tenant Domains

Tenant-scoped hostname/subdomain -> tenant mapping admin API (epic #555, Issue #562) -- list/create/update/delete/verify/set-primary for awcms_mini_tenant_domains. Consumed by the public host-based tenant resolver (#559); the optional Cloudflare DNS adapter (#567) is not wired into any route. Pre-existing gap found by Issue #695's OpenAPI split: operations already used this tag, but it was never declared in this top-level list -- fixed here as a documentation-only addition (no path/schema/security change).

### `GET /api/v1/tenant/domains` — List this tenant's domain/subdomain mappings (keyset-paginated, newest first)

- **operationId**: `tenantDomainsList`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                                                                   |
| ------------------ | ------ | -------- | ------ | --------------------------------------------------------------------------------------------- |
| `cursor`           | query  | no       | string | Opaque keyset pagination cursor from a previous page's `nextCursor`. Omit for the first page. |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.                                                    |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID.                                                   |

**Responses**

| Status | Description                                       | Schema                                                                                                           |
| ------ | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 200    | Tenant domain mappings (limit 100), newest first. | [`ApiSuccess`](#standard-success-envelope)&lt;[`TenantDomainListResponse`](#schema-tenantdomainlistresponse)&gt; |
| 400    | Validation or request error.                      | [`ApiError`](#standard-error-envelope)                                                                           |
| 401    | Authentication required or expired.               | [`ApiError`](#standard-error-envelope)                                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy.    | [`ApiError`](#standard-error-envelope)                                                                           |
| 500    | Internal server error without stack trace.        | [`ApiError`](#standard-error-envelope)                                                                           |

### `POST /api/v1/tenant/domains` — Add a tenant domain/subdomain mapping

- **operationId**: `tenantDomainsCreate`
- **Security**: bearerAuth + tenantHeader

Hostname must be a valid DNS hostname shape (reuses the same normalization the public host resolver applies to an inbound `Host` header — Issue #559) and must not already be mapped to any tenant (the underlying unique index is global, not per-tenant): a duplicate hostname always returns a generic `409 HOSTNAME_CONFLICT`, whether the existing mapping belongs to this tenant or another one. `status` always starts `pending_verification` — only `POST .../verify` can move it to `active`.

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): [`CreateTenantDomainRequest`](#schema-createtenantdomainrequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                           |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 200    | Tenant domain mapping created.                                                                                                                                                                                   | [`ApiSuccess`](#standard-success-envelope)&lt;[`TenantDomainItem`](#schema-tenantdomainitem)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                           |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                           |
| 409    | HOSTNAME_CONFLICT — this hostname is already mapped to a tenant (never reveals whether it is this tenant's own mapping or another tenant's).                                                                     | [`ApiError`](#standard-error-envelope)                                                           |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                           |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                           |

### `GET /api/v1/tenant/domains/{id}` — Read one tenant domain mapping

- **operationId**: `tenantDomainsGet`
- **Security**: bearerAuth + tenantHeader

An unknown id, a soft-deleted id, and another tenant's id all return the exact same generic `404` — RLS makes a cross-tenant id invisible before it can ever be distinguished from "doesn't exist".

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                         | Schema                                                                                           |
| ------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 200    | The requested tenant domain mapping.                | [`ApiSuccess`](#standard-success-envelope)&lt;[`TenantDomainItem`](#schema-tenantdomainitem)&gt; |
| 400    | Validation or request error.                        | [`ApiError`](#standard-error-envelope)                                                           |
| 401    | Authentication required or expired.                 | [`ApiError`](#standard-error-envelope)                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy.      | [`ApiError`](#standard-error-envelope)                                                           |
| 404    | Resource not found or hidden by soft-delete policy. | [`ApiError`](#standard-error-envelope)                                                           |
| 500    | Internal server error without stack trace.          | [`ApiError`](#standard-error-envelope)                                                           |

### `PATCH /api/v1/tenant/domains/{id}` — Update a tenant domain/subdomain mapping

- **operationId**: `tenantDomainsUpdate`
- **Security**: bearerAuth + tenantHeader

Partial update. `hostname` is immutable after create; `is_primary` is never settable here (only `POST .../set-primary` can change it); `status` cannot be set to `"active"` here (only `POST .../verify` can) — attempting either is rejected with `400 VALIDATION_ERROR`. Idempotent by construction (same body -> same end state), no `Idempotency-Key` needed.

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): [`UpdateTenantDomainRequest`](#schema-updatetenantdomainrequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                           |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 200    | Tenant domain mapping updated.                                                                                                                                                                                   | [`ApiSuccess`](#standard-success-envelope)&lt;[`TenantDomainItem`](#schema-tenantdomainitem)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                           |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                           |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                           |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                           |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                           |

### `DELETE /api/v1/tenant/domains/{id}` — Soft-delete a tenant domain/subdomain mapping

- **operationId**: `tenantDomainsDelete`
- **Security**: bearerAuth + tenantHeader

Soft delete only — never hard-deletes. Frees the normalized hostname for reuse (the underlying unique index only applies to non-deleted rows). `reason` is required.

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): object

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 200    | Tenant domain mapping deleted.                                                                                                                                                                                   | [`ApiSuccess`](#standard-success-envelope)&lt;object&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                   |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                   |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                   |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                   |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                   |

### `POST /api/v1/tenant/domains/{id}/set-primary` — Atomically set a tenant domain as the active primary domain

- **operationId**: `tenantDomainsSetPrimary`
- **Security**: bearerAuth + tenantHeader

Atomic within a single transaction: unsets any previous primary domain for this tenant, then sets this one, so at most one row is ever the primary at a time. Only a verified (`active`) domain can become primary.

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `Idempotency-Key`  | header | yes      | string        | Required for high-risk mutations.           |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                                                                        | Schema                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 200    | Tenant domain mapping set as primary.                                                                              | [`ApiSuccess`](#standard-success-envelope)&lt;[`TenantDomainItem`](#schema-tenantdomainitem)&gt; |
| 400    | Validation or request error.                                                                                       | [`ApiError`](#standard-error-envelope)                                                           |
| 401    | Authentication required or expired.                                                                                | [`ApiError`](#standard-error-envelope)                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                     | [`ApiError`](#standard-error-envelope)                                                           |
| 404    | Resource not found or hidden by soft-delete policy.                                                                | [`ApiError`](#standard-error-envelope)                                                           |
| 409    | Idempotency-Key reused with a different request, or the domain is not currently `active` (must be verified first). | [`ApiError`](#standard-error-envelope)                                                           |
| 500    | Internal server error without stack trace.                                                                         | [`ApiError`](#standard-error-envelope)                                                           |

### `POST /api/v1/tenant/domains/{id}/verify` — Manually verify a tenant domain/subdomain mapping

- **operationId**: `tenantDomainsVerify`
- **Security**: bearerAuth + tenantHeader

Manual-first verification (Issue #562 §Security notes) — flips `status` from `pending_verification`/`failed` to `active` based purely on fields already on the row (`verification_method` must be configured first). No outbound DNS/HTTP call happens here. Verifying an already-`active` domain is an idempotent no-op (returns the current row). A `suspended` domain cannot be verified.

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `Idempotency-Key`  | header | yes      | string        | Required for high-risk mutations.           |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                                                                            | Schema                                                                                           |
| ------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 200    | Tenant domain mapping verified (status "active").                                                                      | [`ApiSuccess`](#standard-success-envelope)&lt;[`TenantDomainItem`](#schema-tenantdomainitem)&gt; |
| 400    | Missing `Idempotency-Key`, or the domain has no `verification_method` configured.                                      | [`ApiError`](#standard-error-envelope)                                                           |
| 401    | Authentication required or expired.                                                                                    | [`ApiError`](#standard-error-envelope)                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                         | [`ApiError`](#standard-error-envelope)                                                           |
| 404    | Resource not found or hidden by soft-delete policy.                                                                    | [`ApiError`](#standard-error-envelope)                                                           |
| 409    | Idempotency-Key reused with a different request, or the domain's current status (e.g. `suspended`) cannot be verified. | [`ApiError`](#standard-error-envelope)                                                           |
| 500    | Internal server error without stack trace.                                                                             | [`ApiError`](#standard-error-envelope)                                                           |

## Identity & Access

Login identity, session authentication, and tenant user membership.

### `POST /api/v1/access/assignments` — Assign a role to a tenant user

- **operationId**: `accessCreateAssignment`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): [`AccessAssignmentRequest`](#schema-accessassignmentrequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                                           |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 200    | Role assignment created or already present (idempotent).                                                                                                                                                         | [`ApiSuccess`](#standard-success-envelope)&lt;[`AccessAssignmentResponse`](#schema-accessassignmentresponse)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                                           |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                                           |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                                           |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                                           |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                                           |

### `DELETE /api/v1/access/assignments` — Remove a role assignment from a tenant user

- **operationId**: `accessDeleteAssignment`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): [`AccessAssignmentRequest`](#schema-accessassignmentrequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 200    | Assignment removed.                                                                                                                                                                                              | [`ApiSuccess`](#standard-success-envelope)&lt;object&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                   |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                   |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                   |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                   |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                   |

### `GET /api/v1/access/decision-logs` — List recent ABAC decision log entries for the tenant

- **operationId**: `accessListDecisionLogs`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                                                                   |
| ------------------ | ------ | -------- | ------ | --------------------------------------------------------------------------------------------- |
| `cursor`           | query  | no       | string | Opaque keyset pagination cursor from a previous page's `nextCursor`. Omit for the first page. |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.                                                    |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID.                                                   |

**Responses**

| Status | Description                                           | Schema                                                                                                         |
| ------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 200    | Recent decision log entries, newest first (limit 50). | [`ApiSuccess`](#standard-success-envelope)&lt;[`DecisionLogListResponse`](#schema-decisionloglistresponse)&gt; |
| 400    | Validation or request error.                          | [`ApiError`](#standard-error-envelope)                                                                         |
| 401    | Authentication required or expired.                   | [`ApiError`](#standard-error-envelope)                                                                         |
| 403    | Access denied by RBAC, ABAC, or tenant policy.        | [`ApiError`](#standard-error-envelope)                                                                         |
| 500    | Internal server error without stack trace.            | [`ApiError`](#standard-error-envelope)                                                                         |

### `POST /api/v1/access/evaluate` — Evaluate an ABAC access request for the caller

- **operationId**: `accessEvaluate`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): [`AccessEvaluateRequest`](#schema-accessevaluaterequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                                       |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 200    | Access decision. Always recorded in the decision log.                                                                                                                                                            | [`ApiSuccess`](#standard-success-envelope)&lt;[`AccessEvaluateResponse`](#schema-accessevaluateresponse)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                                       |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                                       |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                                       |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                                       |

### `GET /api/v1/access/modules` — List the module/activity/action permission registry

- **operationId**: `accessListModules`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                | Schema                                                                                                       |
| ------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| 200    | Permission registry.                       | [`ApiSuccess`](#standard-success-envelope)&lt;[`ModuleRegistryResponse`](#schema-moduleregistryresponse)&gt; |
| 401    | Authentication required or expired.        | [`ApiError`](#standard-error-envelope)                                                                       |
| 500    | Internal server error without stack trace. | [`ApiError`](#standard-error-envelope)                                                                       |

### `POST /api/v1/auth/login` — Authenticate an identity and issue a session token

- **operationId**: `authLogin`
- **Security**: tenantHeader

When full-online auth security hardening is active (`AUTH_ONLINE_SECURITY_ENABLED=true` and `AUTH_ONLINE_SECURITY_PROFILE=full_online`) AND `TURNSTILE_ENABLED=true` (Issue #588), `turnstileToken` is verified before any password check: missing -> `400 TURNSTILE_REQUIRED`, invalid -> `400 TURNSTILE_INVALID`. Absent entirely for every local/offline/LAN deployment.

When the same gate is active AND `AUTH_MFA_ENABLED=true` (Issue #589) AND the identity has an active TOTP factor enrolled, a password-valid login does NOT create a session — it returns `401 MFA_REQUIRED` with `error.details.mfaChallengeToken` instead (see `LoginMfaRequiredResponse`). Complete the login by calling `POST /auth/mfa/totp/verify` with that token and a TOTP/recovery code. Identities that have never enrolled MFA are unaffected even when the feature is enabled (opt-in per identity, not tenant-wide).

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |
| `Accept-Language`  | header | no       | string | Preferred response locale.                  |

**Request body** (required): [`LoginRequest`](#schema-loginrequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 200    | Session issued.                                                                                                                                                                                                  | [`ApiSuccess`](#standard-success-envelope)&lt;[`LoginResponse`](#schema-loginresponse)&gt;                 |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                                     |
| 401    | Invalid credentials (`AUTH_INVALID_CREDENTIALS`), OR password was valid but MFA/TOTP (Issue #589) must be completed before a session is issued (`MFA_REQUIRED`, `LoginMfaRequiredResponse`).                     | [`ApiError`](#standard-error-envelope) \\\| [`LoginMfaRequiredResponse`](#schema-loginmfarequiredresponse) |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                                     |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                                     |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                                     |

### `POST /api/v1/auth/logout` — Revoke the caller's active session

- **operationId**: `authLogout`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                | Schema                                                                                       |
| ------ | ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 200    | Session revoked.                           | [`ApiSuccess`](#standard-success-envelope)&lt;[`LogoutResponse`](#schema-logoutresponse)&gt; |
| 401    | Authentication required or expired.        | [`ApiError`](#standard-error-envelope)                                                       |
| 500    | Internal server error without stack trace. | [`ApiError`](#standard-error-envelope)                                                       |

### `GET /api/v1/auth/me` — Get the caller's active identity

- **operationId**: `authMe`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                | Schema                                                                               |
| ------ | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| 200    | Active identity for the current session.   | [`ApiSuccess`](#standard-success-envelope)&lt;[`MeResponse`](#schema-meresponse)&gt; |
| 401    | Authentication required or expired.        | [`ApiError`](#standard-error-envelope)                                               |
| 500    | Internal server error without stack trace. | [`ApiError`](#standard-error-envelope)                                               |

### `POST /api/v1/auth/mfa/recovery-codes/regenerate` — Invalidate existing recovery codes and issue a fresh set (high-risk, audited)

- **operationId**: `authMfaRecoveryCodesRegenerate`
- **Security**: bearerAuth + tenantHeader

Full-online-only (Issue #589). Requires an active MFA factor. Every previously issued recovery code stops working immediately; the 10 fresh codes are shown exactly once in the response. Audited (`mfa_recovery_codes_regenerated`).

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                                      | Schema                                                                                                           |
| ------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 200    | Recovery codes regenerated.                                                      | [`ApiSuccess`](#standard-success-envelope)&lt;[`MfaRecoveryCodesResponse`](#schema-mfarecoverycodesresponse)&gt; |
| 401    | Authentication required or expired.                                              | [`ApiError`](#standard-error-envelope)                                                                           |
| 403    | Multi-factor authentication is not enabled for this deployment (`MFA_DISABLED`). | [`ApiError`](#standard-error-envelope)                                                                           |
| 409    | No MFA factor is currently active for this account (`MFA_NOT_ACTIVE`).           | [`ApiError`](#standard-error-envelope)                                                                           |
| 500    | Internal server error without stack trace.                                       | [`ApiError`](#standard-error-envelope)                                                                           |

### `GET /api/v1/auth/mfa/status` — Get the caller's own MFA enrollment status

- **operationId**: `authMfaStatus`
- **Security**: bearerAuth + tenantHeader

Full-online-only (Issue #589) — `403 MFA_DISABLED` unless the #587 gate AND `AUTH_MFA_ENABLED=true` are both active. Reports the caller's own enrollment only (self-service; no admin-on-behalf-of view in this issue).

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                                      | Schema                                                                                             |
| ------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 200    | Current MFA enrollment status.                                                   | [`ApiSuccess`](#standard-success-envelope)&lt;[`MfaStatusResponse`](#schema-mfastatusresponse)&gt; |
| 400    | Validation or request error.                                                     | [`ApiError`](#standard-error-envelope)                                                             |
| 401    | Authentication required or expired.                                              | [`ApiError`](#standard-error-envelope)                                                             |
| 403    | Multi-factor authentication is not enabled for this deployment (`MFA_DISABLED`). | [`ApiError`](#standard-error-envelope)                                                             |
| 500    | Internal server error without stack trace.                                       | [`ApiError`](#standard-error-envelope)                                                             |

### `POST /api/v1/auth/mfa/totp/disable` — Disable the caller's own MFA (high-risk, audited)

- **operationId**: `authMfaTotpDisable`
- **Security**: bearerAuth + tenantHeader

Full-online-only (Issue #589). Self-service: requires an already-valid session (for an identity with active MFA, only obtainable by already passing an MFA challenge). Deletes the factor's recovery codes too. Audited (`mfa_disabled`).

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                                      | Schema                                                                                               |
| ------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 200    | MFA disabled.                                                                    | [`ApiSuccess`](#standard-success-envelope)&lt;[`MfaDisableResponse`](#schema-mfadisableresponse)&gt; |
| 401    | Authentication required or expired.                                              | [`ApiError`](#standard-error-envelope)                                                               |
| 403    | Multi-factor authentication is not enabled for this deployment (`MFA_DISABLED`). | [`ApiError`](#standard-error-envelope)                                                               |
| 409    | No MFA factor is currently active for this account (`MFA_NOT_ACTIVE`).           | [`ApiError`](#standard-error-envelope)                                                               |
| 500    | Internal server error without stack trace.                                       | [`ApiError`](#standard-error-envelope)                                                               |

### `POST /api/v1/auth/mfa/totp/enroll/start` — Generate a new pending TOTP secret for the caller to confirm

- **operationId**: `authMfaTotpEnrollStart`
- **Security**: bearerAuth + tenantHeader

Full-online-only (Issue #589). Returns the plaintext secret/QR URI ONLY here, at enrollment start — never again afterward. The factor is `pending` (unusable for login) until confirmed via `POST /auth/mfa/totp/enroll/verify`. Rejects with `409 MFA_ALREADY_ACTIVE` if the caller already has an active factor — re-enrollment must go through `disable` first.

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                                      | Schema                                                                                                       |
| ------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 200    | Pending TOTP factor created.                                                     | [`ApiSuccess`](#standard-success-envelope)&lt;[`MfaEnrollStartResponse`](#schema-mfaenrollstartresponse)&gt; |
| 400    | Validation or request error.                                                     | [`ApiError`](#standard-error-envelope)                                                                       |
| 401    | Authentication required or expired.                                              | [`ApiError`](#standard-error-envelope)                                                                       |
| 403    | Multi-factor authentication is not enabled for this deployment (`MFA_DISABLED`). | [`ApiError`](#standard-error-envelope)                                                                       |
| 409    | An MFA factor is already active for this account (`MFA_ALREADY_ACTIVE`).         | [`ApiError`](#standard-error-envelope)                                                                       |
| 500    | Internal server error without stack trace.                                       | [`ApiError`](#standard-error-envelope)                                                                       |

### `POST /api/v1/auth/mfa/totp/enroll/verify` — Confirm a pending TOTP enrollment with a live code

- **operationId**: `authMfaTotpEnrollVerify`
- **Security**: bearerAuth + tenantHeader

Full-online-only (Issue #589). Activates the pending factor from `enroll/start` and returns 10 single-use recovery codes shown exactly once (never retrievable again — only `recovery-codes/regenerate` can produce a fresh set afterward).

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): [`MfaEnrollVerifyRequest`](#schema-mfaenrollverifyrequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 200    | MFA activated.                                                                                                                                                                                                   | [`ApiSuccess`](#standard-success-envelope)&lt;[`MfaEnrollVerifyResponse`](#schema-mfaenrollverifyresponse)&gt; |
| 400    | Validation error, or the code is invalid (`MFA_INVALID_CODE`).                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                                         |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                                         |
| 403    | Multi-factor authentication is not enabled for this deployment (`MFA_DISABLED`).                                                                                                                                 | [`ApiError`](#standard-error-envelope)                                                                         |
| 404    | No pending MFA enrollment found (`MFA_ENROLLMENT_NOT_FOUND`).                                                                                                                                                    | [`ApiError`](#standard-error-envelope)                                                                         |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                                         |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                                         |

### `POST /api/v1/auth/mfa/totp/verify` — Complete a login paused by 401 MFA_REQUIRED

- **operationId**: `authMfaTotpVerify`
- **Security**: tenantHeader

Full-online-only (Issue #589). Deliberately NOT authenticated via a session — authenticated instead by possession of `mfaChallengeToken` from `POST /auth/login`'s `MFA_REQUIRED` response, exactly like `password/reset` is authenticated by possession of a reset token. Exactly one of `code` (TOTP) or `recoveryCode` must be provided. On success, creates the real AWCMS-Mini session — same response shape as `POST /auth/login`'s 200. Rate-limited both by source+tenant (`AUTH_MFA_RATE_LIMIT_MAX`/`_WINDOW_SEC`) and by a per-challenge failed-attempt counter.

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): [`MfaChallengeVerifyRequest`](#schema-mfachallengeverifyrequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 200    | Challenge verified; session issued.                                                                                                                                                                              | [`ApiSuccess`](#standard-success-envelope)&lt;[`LoginResponse`](#schema-loginresponse)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                     |
| 401    | The challenge is invalid, expired, already used, or the code/recovery code is wrong (deliberately not distinguished — anti-enumeration, same principle as `password/reset` — `MFA_CHALLENGE_INVALID`).           | [`ApiError`](#standard-error-envelope)                                                     |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                     |
| 429    | Too many verification attempts from this source.                                                                                                                                                                 | [`ApiError`](#standard-error-envelope)                                                     |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                     |

### `POST /api/v1/auth/password/forgot` — Request a password reset email; always returns a generic response regardless of whether the identifier matches an account

- **operationId**: `authPasswordForgot`
- **Security**: tenantHeader

When full-online auth security hardening AND `TURNSTILE_ENABLED=true` are both active (Issue #588), `turnstileToken` is verified before the reset-token DB write/email enqueue: missing -> `400 TURNSTILE_REQUIRED`, invalid -> `400 TURNSTILE_INVALID`.

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): [`ForgotPasswordRequest`](#schema-forgotpasswordrequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                                       |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 200    | Generic acknowledgement — does not reveal whether the account exists.                                                                                                                                            | [`ApiSuccess`](#standard-success-envelope)&lt;[`ForgotPasswordResponse`](#schema-forgotpasswordresponse)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                                       |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                                       |
| 429    | Too many password reset requests from this source.                                                                                                                                                               | [`ApiError`](#standard-error-envelope)                                                                       |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                                       |

### `POST /api/v1/auth/password/reset` — Complete a password reset with a valid one-time token

- **operationId**: `authPasswordReset`
- **Security**: tenantHeader

When full-online auth security hardening AND `TURNSTILE_ENABLED=true` are both active (Issue #588), `turnstileToken` is verified before the token lookup/password update: missing -> `400 TURNSTILE_REQUIRED`, invalid -> `400 TURNSTILE_INVALID`.

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): [`ResetPasswordRequest`](#schema-resetpasswordrequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 200    | Password reset; all active sessions for the identity are revoked.                                                                                                                                                | [`ApiSuccess`](#standard-success-envelope)&lt;[`ResetPasswordResponse`](#schema-resetpasswordresponse)&gt; |
| 400    | Validation error, or the token is invalid/expired/already used (deliberately not distinguished in the response — anti- enumeration, doc 20 §A07 Identification & Auth Failures).                                 | [`ApiError`](#standard-error-envelope)                                                                     |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                                     |
| 429    | Too many password reset attempts from this source.                                                                                                                                                               | [`ApiError`](#standard-error-envelope)                                                                     |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                                     |

### `GET /api/v1/auth/providers/google/callback` — Google's OAuth redirect target — completes login or link

- **operationId**: `authGoogleCallback`
- **Security**: tenantHeader

Full-online-only (Issue #590). A plain top-level browser navigation, never a `fetch()` call — Google redirects here with `code`+`state` (or `error` if the user cancelled consent). Validates `state` (CSRF/replay defense) and the ID token's signature, issuer, audience, expiry, and nonce cryptographically before trusting any claim. For a `login`-purpose request: creates the existing AWCMS-Mini session type (or, if Issue #589's MFA gate is active and the identity has an active factor, returns `401 MFA_REQUIRED` exactly like `POST /auth/login` — Google login never bypasses MFA). For a `link`-purpose request (from `POST .../link`): attaches the verified Google account to the identity captured server-side at link-initiation time.

**Parameters**

| Name    | In    | Required | Type   | Description                                               |
| ------- | ----- | -------- | ------ | --------------------------------------------------------- |
| `code`  | query | no       | string |                                                           |
| `state` | query | yes      | string |                                                           |
| `error` | query | no       | string | Present when the user cancelled/denied consent at Google. |

**Responses**

| Status | Description                                                                                                                                                                                                                                       | Schema                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 302    | Login or link succeeded; redirects to `/admin`.                                                                                                                                                                                                   |                                                                                                            |
| 400    | Missing or malformed `state` (`GOOGLE_OAUTH_STATE_INVALID`).                                                                                                                                                                                      | [`ApiError`](#standard-error-envelope)                                                                     |
| 401    | The state/nonce/ID token could not be verified (`GOOGLE_OAUTH_STATE_INVALID`/`GOOGLE_TOKEN_EXCHANGE_FAILED`/ `GOOGLE_ID_TOKEN_INVALID`/`GOOGLE_ACCOUNT_NOT_LINKED`), or MFA must be completed first (`MFA_REQUIRED`, `LoginMfaRequiredResponse`). | [`ApiError`](#standard-error-envelope) \\\| [`LoginMfaRequiredResponse`](#schema-loginmfarequiredresponse) |
| 403    | Google login is not enabled for this deployment (`GOOGLE_LOGIN_DISABLED`), or the resolved identity/tenant is not active (`ACCESS_DENIED`).                                                                                                       | [`ApiError`](#standard-error-envelope)                                                                     |
| 409    | This Google subject is already linked to a different identity (`GOOGLE_ALREADY_LINKED`).                                                                                                                                                          | [`ApiError`](#standard-error-envelope)                                                                     |
| 500    | Internal server error without stack trace.                                                                                                                                                                                                        | [`ApiError`](#standard-error-envelope)                                                                     |

### `POST /api/v1/auth/providers/google/link` — Start linking the caller's own identity to a Google account

- **operationId**: `authGoogleLink`
- **Security**: bearerAuth + tenantHeader

Full-online-only (Issue #590). Authenticated: creates a `link`-purpose OAuth request bound to the caller's own identity (captured server-side, never trusted from the callback request) and returns the Google authorization URL as JSON — invoked via `fetch()` from an authenticated context, so the client navigates itself (`window.location = data.authorizationUrl`) rather than receiving a redirect.

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                                | Schema                                                                                                         |
| ------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 200    | Link-purpose OAuth request created.                                        | [`ApiSuccess`](#standard-success-envelope)&lt;[`GoogleLinkStartResponse`](#schema-googlelinkstartresponse)&gt; |
| 400    | Validation or request error.                                               | [`ApiError`](#standard-error-envelope)                                                                         |
| 401    | Authentication required or expired.                                        | [`ApiError`](#standard-error-envelope)                                                                         |
| 403    | Google login is not enabled for this deployment (`GOOGLE_LOGIN_DISABLED`). | [`ApiError`](#standard-error-envelope)                                                                         |
| 500    | Internal server error without stack trace.                                 | [`ApiError`](#standard-error-envelope)                                                                         |

### `GET /api/v1/auth/providers/google/start` — Redirect to Google's OAuth Authorization Code endpoint (login)

- **operationId**: `authGoogleStart`
- **Security**: tenantHeader

Full-online-only (Issue #590) — `403 GOOGLE_LOGIN_DISABLED` unless the #587 gate AND `AUTH_GOOGLE_LOGIN_ENABLED=true` are both active. Unauthenticated entry point reached from the "Continue with Google" button on `/login`. Accepts `tenantId` via the `X-AWCMS-Mini-Tenant-ID` header, the tenant cookie, or a `?tenantId=` query param (the login page has no tenant cookie yet, and a plain browser navigation can't set a custom header). Always a `login` intent — see `POST .../link` for the authenticated linking flow.

**Parameters**

| Name       | In    | Required | Type   | Description                                                       |
| ---------- | ----- | -------- | ------ | ----------------------------------------------------------------- |
| `tenantId` | query | no       | string | Fallback tenant id when neither the header nor cookie is present. |

**Responses**

| Status | Description                                                                | Schema                                 |
| ------ | -------------------------------------------------------------------------- | -------------------------------------- |
| 302    | Redirect to Google's authorization endpoint.                               |                                        |
| 400    | Validation or request error.                                               | [`ApiError`](#standard-error-envelope) |
| 403    | Google login is not enabled for this deployment (`GOOGLE_LOGIN_DISABLED`). | [`ApiError`](#standard-error-envelope) |
| 500    | Internal server error without stack trace.                                 | [`ApiError`](#standard-error-envelope) |

### `POST /api/v1/auth/providers/google/unlink` — Unlink the caller's own Google account

- **operationId**: `authGoogleUnlink`
- **Security**: bearerAuth + tenantHeader

Full-online-only (Issue #590). High-risk, audited (`google_account_unlinked`). Never touches local password login — removing a Google link cannot lock an identity out of its own account.

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                                | Schema                                                                                                   |
| ------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 200    | Google account unlinked.                                                   | [`ApiSuccess`](#standard-success-envelope)&lt;[`GoogleUnlinkResponse`](#schema-googleunlinkresponse)&gt; |
| 401    | Authentication required or expired.                                        | [`ApiError`](#standard-error-envelope)                                                                   |
| 403    | Google login is not enabled for this deployment (`GOOGLE_LOGIN_DISABLED`). | [`ApiError`](#standard-error-envelope)                                                                   |
| 409    | No Google account is currently linked (`GOOGLE_NOT_LINKED`).               | [`ApiError`](#standard-error-envelope)                                                                   |
| 500    | Internal server error without stack trace.                                 | [`ApiError`](#standard-error-envelope)                                                                   |

### `GET /api/v1/auth/sso/{providerKey}/callback` — Tenant OIDC provider's redirect target — completes login or link

- **operationId**: `authSsoCallback`
- **Security**: tenantHeader

Full-online-only (Issue #591). A plain top-level browser navigation, never a `fetch()` call — the provider redirects here with `code`+`state` (or `error` if the user cancelled consent). Validates `state` (CSRF/replay defense) and the ID token's signature, issuer, audience, expiry, and nonce cryptographically before trusting any claim — same verification depth as Issue #590's Google callback. For a `login`-purpose request: creates the existing AWCMS-Mini session type (or, if Issue #589's MFA gate is active and the identity has an active factor, returns `401 MFA_REQUIRED` exactly like `POST /auth/login`/Google login — SSO login never bypasses MFA). For a `link`-purpose request (from `POST .../link`): attaches the verified provider account to the identity captured server-side at link-initiation time.

**Parameters**

| Name          | In    | Required | Type   | Description                                                     |
| ------------- | ----- | -------- | ------ | --------------------------------------------------------------- |
| `providerKey` | path  | yes      | string |                                                                 |
| `code`        | query | no       | string |                                                                 |
| `state`       | query | yes      | string |                                                                 |
| `error`       | query | no       | string | Present when the user cancelled/denied consent at the provider. |

**Responses**

| Status | Description                                                                                                                                                                                                                           | Schema                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 302    | Login or link succeeded; redirects to `/admin`.                                                                                                                                                                                       |                                                                                                            |
| 400    | Missing or malformed `state` (`SSO_OAUTH_STATE_INVALID`).                                                                                                                                                                             | [`ApiError`](#standard-error-envelope)                                                                     |
| 401    | The state/nonce/ID token could not be verified (`SSO_OAUTH_STATE_INVALID`/`SSO_TOKEN_EXCHANGE_FAILED`/ `SSO_ID_TOKEN_INVALID`/`SSO_ACCOUNT_NOT_LINKED`), or MFA must be completed first (`MFA_REQUIRED`, `LoginMfaRequiredResponse`). | [`ApiError`](#standard-error-envelope) \\\| [`LoginMfaRequiredResponse`](#schema-loginmfarequiredresponse) |
| 403    | Tenant OIDC SSO is not enabled for this deployment (`SSO_DISABLED`), this provider is disabled (`SSO_PROVIDER_DISABLED`), or the resolved identity/tenant is not active (`ACCESS_DENIED`).                                            | [`ApiError`](#standard-error-envelope)                                                                     |
| 409    | This provider subject is already linked to a different identity (`SSO_ALREADY_LINKED`).                                                                                                                                               | [`ApiError`](#standard-error-envelope)                                                                     |
| 500    | Internal server error without stack trace.                                                                                                                                                                                            | [`ApiError`](#standard-error-envelope)                                                                     |
| 502    | The SSO provider could not be reached (`SSO_PROVIDER_UNAVAILABLE`).                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                                     |

### `POST /api/v1/auth/sso/{providerKey}/link` — Start linking the caller's own identity to a tenant-configured OIDC provider account

- **operationId**: `authSsoLink`
- **Security**: bearerAuth + tenantHeader

Full-online-only (Issue #591). Authenticated: creates a `link`-purpose OAuth request bound to the caller's own identity (captured server-side, never trusted from the callback request) and returns the provider's authorization URL as JSON — same shape as Issue #590's Google `link`.

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `providerKey`      | path   | yes      | string |                                             |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                                              | Schema                                                                                                   |
| ------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 200    | Link-purpose OAuth request created.                                                      | [`ApiSuccess`](#standard-success-envelope)&lt;[`SsoLinkStartResponse`](#schema-ssolinkstartresponse)&gt; |
| 400    | Validation or request error.                                                             | [`ApiError`](#standard-error-envelope)                                                                   |
| 401    | Authentication required or expired.                                                      | [`ApiError`](#standard-error-envelope)                                                                   |
| 403    | Tenant OIDC SSO is not enabled for this deployment (`SSO_DISABLED`).                     | [`ApiError`](#standard-error-envelope)                                                                   |
| 404    | No enabled SSO provider matches this key (`SSO_PROVIDER_NOT_FOUND`).                     | [`ApiError`](#standard-error-envelope)                                                                   |
| 500    | Internal server error without stack trace.                                               | [`ApiError`](#standard-error-envelope)                                                                   |
| 502    | The SSO provider's discovery endpoint could not be reached (`SSO_PROVIDER_UNAVAILABLE`). | [`ApiError`](#standard-error-envelope)                                                                   |

### `GET /api/v1/auth/sso/{providerKey}/start` — Redirect to a tenant-configured OIDC provider's authorization endpoint (login)

- **operationId**: `authSsoStart`
- **Security**: tenantHeader

Full-online-only (Issue #591) — `403 SSO_DISABLED` unless the #587 gate AND `AUTH_SSO_ENABLED=true` are both active. Generalizes Issue #590's Google login to a tenant-configured provider (`awcms_mini_auth_providers`); Google's own `/auth/providers/google/*` endpoints are unaffected. `providerKey` must resolve to an `enabled` provider for this tenant, else `404 SSO_PROVIDER_NOT_FOUND`. Tenant resolved from the `X-AWCMS-Mini-Tenant-ID` header, the tenant cookie, or a `?tenantId=` query param fallback, same as Google's own `start`.

**Parameters**

| Name          | In    | Required | Type   | Description                                                       |
| ------------- | ----- | -------- | ------ | ----------------------------------------------------------------- |
| `providerKey` | path  | yes      | string |                                                                   |
| `tenantId`    | query | no       | string | Fallback tenant id when neither the header nor cookie is present. |

**Responses**

| Status | Description                                                                                                         | Schema                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 302    | Redirect to the provider's authorization endpoint.                                                                  |                                        |
| 400    | Validation or request error.                                                                                        | [`ApiError`](#standard-error-envelope) |
| 403    | Tenant OIDC SSO is not enabled for this deployment (`SSO_DISABLED`), or the tenant is not active (`ACCESS_DENIED`). | [`ApiError`](#standard-error-envelope) |
| 404    | No enabled SSO provider matches this key (`SSO_PROVIDER_NOT_FOUND`).                                                | [`ApiError`](#standard-error-envelope) |
| 429    | Too many requests from this source (`RATE_LIMITED`).                                                                | [`ApiError`](#standard-error-envelope) |
| 500    | Internal server error without stack trace.                                                                          | [`ApiError`](#standard-error-envelope) |
| 502    | The SSO provider's discovery endpoint could not be reached (`SSO_PROVIDER_UNAVAILABLE`).                            | [`ApiError`](#standard-error-envelope) |

### `POST /api/v1/auth/sso/{providerKey}/unlink` — Unlink the caller's own tenant-configured OIDC provider account

- **operationId**: `authSsoUnlink`
- **Security**: bearerAuth + tenantHeader

Full-online-only (Issue #591). High-risk, audited (`sso_account_unlinked`). Never touches local password login — unlinking a provider cannot lock an identity out of its own account (that guarantee is the tenant policy's `sso_required` + break-glass enforcement's job instead).

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `providerKey`      | path   | yes      | string |                                             |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                          | Schema                                                                                             |
| ------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 200    | SSO account unlinked.                                                | [`ApiSuccess`](#standard-success-envelope)&lt;[`SsoUnlinkResponse`](#schema-ssounlinkresponse)&gt; |
| 401    | Authentication required or expired.                                  | [`ApiError`](#standard-error-envelope)                                                             |
| 403    | Tenant OIDC SSO is not enabled for this deployment (`SSO_DISABLED`). | [`ApiError`](#standard-error-envelope)                                                             |
| 409    | No SSO account is currently linked (`SSO_NOT_LINKED`).               | [`ApiError`](#standard-error-envelope)                                                             |
| 500    | Internal server error without stack trace.                           | [`ApiError`](#standard-error-envelope)                                                             |

### `GET /api/v1/identity/sso/policy` — Read this tenant's authentication policy

- **operationId**: `identitySsoPolicyGet`
- **Security**: bearerAuth + tenantHeader

Admin CRUD (Issue #591), protected by ABAC (`identity_access.sso_policy.read`). Falls back to the safe default (password login enabled, SSO disabled) when never configured.

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                    | Schema                                                                                                   |
| ------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 200    | Tenant authentication policy.                  | [`ApiSuccess`](#standard-success-envelope)&lt;[`TenantAuthPolicyView`](#schema-tenantauthpolicyview)&gt; |
| 400    | Validation or request error.                   | [`ApiError`](#standard-error-envelope)                                                                   |
| 401    | Authentication required or expired.            | [`ApiError`](#standard-error-envelope)                                                                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy. | [`ApiError`](#standard-error-envelope)                                                                   |
| 500    | Internal server error without stack trace.     | [`ApiError`](#standard-error-envelope)                                                                   |

### `PATCH /api/v1/identity/sso/policy` — Update this tenant's authentication policy

- **operationId**: `identitySsoPolicyUpdate`
- **Security**: bearerAuth + tenantHeader

Admin CRUD (Issue #591), protected by ABAC (`identity_access.sso_policy.update`). High-risk, audited (`sso_policy_updated`). Server-side break-glass enforcement: `sso_required=true` or `password_login_enabled=false` is rejected (`409 BREAK_GLASS_REQUIRED`) unless at least one currently-active break-glass identity with an active tenant membership is configured.

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): [`UpdateTenantAuthPolicyRequest`](#schema-updatetenantauthpolicyrequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 200    | Tenant authentication policy updated.                                                                                                                                                                            | [`ApiSuccess`](#standard-success-envelope)&lt;[`TenantAuthPolicyView`](#schema-tenantauthpolicyview)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                                   |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                                   |
| 409    | Break-glass requirement not satisfied (`BREAK_GLASS_REQUIRED`).                                                                                                                                                  | [`ApiError`](#standard-error-envelope)                                                                   |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                                   |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                                   |

### `GET /api/v1/identity/sso/providers` — List this tenant's configured OIDC SSO providers

- **operationId**: `identitySsoProvidersList`
- **Security**: bearerAuth + tenantHeader

Admin CRUD (Issue #591), protected by ABAC (`identity_access.sso_providers.read`). Never returns a provider's client secret plaintext — see `AuthProviderView`'s `secretSource`.

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                    | Schema                                                                                                           |
| ------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 200    | SSO providers listed.                          | [`ApiSuccess`](#standard-success-envelope)&lt;[`AuthProviderListResponse`](#schema-authproviderlistresponse)&gt; |
| 400    | Validation or request error.                   | [`ApiError`](#standard-error-envelope)                                                                           |
| 401    | Authentication required or expired.            | [`ApiError`](#standard-error-envelope)                                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy. | [`ApiError`](#standard-error-envelope)                                                                           |
| 500    | Internal server error without stack trace.     | [`ApiError`](#standard-error-envelope)                                                                           |

### `POST /api/v1/identity/sso/providers` — Add a tenant OIDC SSO provider

- **operationId**: `identitySsoProvidersCreate`
- **Security**: bearerAuth + tenantHeader

Admin CRUD (Issue #591), protected by ABAC (`identity_access.sso_providers.create`). High-risk: audited (`sso_provider_created`). Exactly one of `clientSecret`/ `clientSecretEnvVar` must be provided; the secret is encrypted at rest (AES-256-GCM, `AUTH_SSO_CREDENTIAL_ENCRYPTION_KEY`) or stored as an environment variable name reference — never plaintext.

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): [`CreateAuthProviderRequest`](#schema-createauthproviderrequest)

**Responses**

| Status | Description                                                                                                                                                                                                               | Schema                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 200    | SSO provider created.                                                                                                                                                                                                     | [`ApiSuccess`](#standard-success-envelope)&lt;[`AuthProviderView`](#schema-authproviderview)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                           |
| 401    | Authentication required or expired.                                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                            | [`ApiError`](#standard-error-envelope)                                                           |
| 409    | A provider already exists for this `providerKey` (`SSO_PROVIDER_KEY_CONFLICT`), or the tenant has reached its configured provider limit (`SSO_PROVIDER_LIMIT_EXCEEDED`, default 20, `AUTH_SSO_MAX_PROVIDERS_PER_TENANT`). | [`ApiError`](#standard-error-envelope)                                                           |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`.          | [`ApiError`](#standard-error-envelope)                                                           |
| 500    | Internal error, or `AUTH_SSO_CREDENTIAL_ENCRYPTION_KEY` is not configured on this server (`SSO_MISCONFIGURED`).                                                                                                           | [`ApiError`](#standard-error-envelope)                                                           |

### `GET /api/v1/identity/sso/providers/{id}` — Read one tenant OIDC SSO provider

- **operationId**: `identitySsoProvidersGet`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                         | Schema                                                                                           |
| ------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 200    | SSO provider found.                                 | [`ApiSuccess`](#standard-success-envelope)&lt;[`AuthProviderView`](#schema-authproviderview)&gt; |
| 401    | Authentication required or expired.                 | [`ApiError`](#standard-error-envelope)                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy.      | [`ApiError`](#standard-error-envelope)                                                           |
| 404    | Resource not found or hidden by soft-delete policy. | [`ApiError`](#standard-error-envelope)                                                           |
| 500    | Internal server error without stack trace.          | [`ApiError`](#standard-error-envelope)                                                           |

### `PATCH /api/v1/identity/sso/providers/{id}` — Update a tenant OIDC SSO provider

- **operationId**: `identitySsoProvidersUpdate`
- **Security**: bearerAuth + tenantHeader

Admin CRUD (Issue #591), protected by ABAC (`identity_access.sso_providers.update`). Partial update; high-risk, audited (`sso_provider_updated`).

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): [`UpdateAuthProviderRequest`](#schema-updateauthproviderrequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                           |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 200    | SSO provider updated.                                                                                                                                                                                            | [`ApiSuccess`](#standard-success-envelope)&lt;[`AuthProviderView`](#schema-authproviderview)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                           |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                           |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                           |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                           |
| 500    | Internal error, or `AUTH_SSO_CREDENTIAL_ENCRYPTION_KEY` is not configured on this server (`SSO_MISCONFIGURED`).                                                                                                  | [`ApiError`](#standard-error-envelope)                                                           |

### `DELETE /api/v1/identity/sso/providers/{id}` — Soft-delete a tenant OIDC SSO provider

- **operationId**: `identitySsoProvidersDelete`
- **Security**: bearerAuth + tenantHeader

Admin CRUD (Issue #591), protected by ABAC (`identity_access.sso_providers.delete`). High-risk, audited (`sso_provider_deleted`).

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): object

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 200    | SSO provider deleted.                                                                                                                                                                                            | [`ApiSuccess`](#standard-success-envelope)&lt;object&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                   |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                   |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                   |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                   |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                   |

### `GET /api/v1/permissions` — List the global permission catalog

- **operationId**: `accessListPermissions`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                  | Schema                                                                                                       |
| ------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| 200    | Full permission catalog (module_key, activity_code, action). | [`ApiSuccess`](#standard-success-envelope)&lt;[`PermissionListResponse`](#schema-permissionlistresponse)&gt; |
| 401    | Authentication required or expired.                          | [`ApiError`](#standard-error-envelope)                                                                       |
| 403    | Access denied by RBAC, ABAC, or tenant policy.               | [`ApiError`](#standard-error-envelope)                                                                       |
| 500    | Internal server error without stack trace.                   | [`ApiError`](#standard-error-envelope)                                                                       |

### `GET /api/v1/roles` — List tenant roles with their permission ids and assigned user count

- **operationId**: `rolesList`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                    | Schema                                                                                           |
| ------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 200    | All non-deleted roles for the tenant.          | [`ApiSuccess`](#standard-success-envelope)&lt;[`RoleListResponse`](#schema-rolelistresponse)&gt; |
| 401    | Authentication required or expired.            | [`ApiError`](#standard-error-envelope)                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy. | [`ApiError`](#standard-error-envelope)                                                           |
| 500    | Internal server error without stack trace.     | [`ApiError`](#standard-error-envelope)                                                           |

### `POST /api/v1/roles` — Create a role with an initial permission set

- **operationId**: `rolesCreate`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): [`CreateRoleRequest`](#schema-createrolerequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 200    | Role created.                                                                                                                                                                                                    | [`ApiSuccess`](#standard-success-envelope)&lt;[`CreateRoleResponse`](#schema-createroleresponse)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                               |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                               |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                               |
| 409    | A role with that role_code already exists.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                               |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                               |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                               |

### `PATCH /api/v1/roles/{id}` — Rename a role and/or replace its permission set

- **operationId**: `rolesUpdate`
- **Security**: bearerAuth + tenantHeader

System roles (is_system=true, e.g. the owner role seeded at setup) reject permissionIds changes with 409 — renaming is still allowed.

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): [`UpdateRoleRequest`](#schema-updaterolerequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 200    | Role updated.                                                                                                                                                                                                    | [`ApiSuccess`](#standard-success-envelope) |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)     |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)     |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)     |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)     |
| 409    | Cannot modify the permissions of a system role.                                                                                                                                                                  | [`ApiError`](#standard-error-envelope)     |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)     |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)     |

### `DELETE /api/v1/roles/{id}` — Soft-delete a role

- **operationId**: `rolesDelete`
- **Security**: bearerAuth + tenantHeader

Rejects with 409 if the role is a system role, or if it is still assigned to one or more tenant users (unassign first).

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): [`RoleDeleteRequest`](#schema-roledeleterequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 200    | Role soft-deleted.                                                                                                                                                                                               | [`ApiSuccess`](#standard-success-envelope) |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)     |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)     |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)     |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)     |
| 409    | Role is a system role, or still assigned to a tenant user.                                                                                                                                                       | [`ApiError`](#standard-error-envelope)     |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)     |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)     |

### `GET /api/v1/users` — List tenant users and their assigned roles

- **operationId**: `usersList`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                 | Schema                                                                                           |
| ------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 200    | All tenant users for the tenant, with their assigned roles. | [`ApiSuccess`](#standard-success-envelope)&lt;[`UserListResponse`](#schema-userlistresponse)&gt; |
| 401    | Authentication required or expired.                         | [`ApiError`](#standard-error-envelope)                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy.              | [`ApiError`](#standard-error-envelope)                                                           |
| 500    | Internal server error without stack trace.                  | [`ApiError`](#standard-error-envelope)                                                           |

### `POST /api/v1/users` — Create a tenant user (identity + profile + optional role assignment)

- **operationId**: `usersCreate`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): [`CreateUserRequest`](#schema-createuserrequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 200    | User created.                                                                                                                                                                                                    | [`ApiSuccess`](#standard-success-envelope)&lt;[`CreateUserResponse`](#schema-createuserresponse)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                               |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                               |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                               |
| 409    | A user with that login identifier already exists.                                                                                                                                                                | [`ApiError`](#standard-error-envelope)                                                               |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                               |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                               |

### `PATCH /api/v1/users/{id}` — Update a tenant user's display name and/or active status

- **operationId**: `usersUpdate`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): [`UpdateUserRequest`](#schema-updateuserrequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 200    | User updated.                                                                                                                                                                                                    | [`ApiSuccess`](#standard-success-envelope) |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)     |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)     |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)     |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)     |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)     |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)     |

## Sync Storage

Offline-first sync node registration and HMAC-signed push/pull.

### `GET /api/v1/sync/conflicts` — List sync conflicts for the tenant (bearer session, not HMAC)

- **operationId**: `syncListConflicts`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type                     | Description                                 |
| ------------------ | ------ | -------- | ------------------------ | ------------------------------------------- |
| `status`           | query  | no       | enum(`open`, `resolved`) |                                             |
| `X-Correlation-ID` | header | no       | string                   | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string                   | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                     | Schema                                                                                                           |
| ------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 200    | Recent sync conflicts, newest first (limit 50). | [`ApiSuccess`](#standard-success-envelope)&lt;[`SyncConflictListResponse`](#schema-syncconflictlistresponse)&gt; |
| 401    | Authentication required or expired.             | [`ApiError`](#standard-error-envelope)                                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy.  | [`ApiError`](#standard-error-envelope)                                                                           |
| 500    | Internal server error without stack trace.      | [`ApiError`](#standard-error-envelope)                                                                           |

### `POST /api/v1/sync/conflicts/{id}/resolve` — Resolve a sync conflict (bearer session, not HMAC)

- **operationId**: `syncResolveConflict`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): [`SyncConflictResolveRequest`](#schema-syncconflictresolverequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 200    | Conflict resolved.                                                                                                                                                                                               | [`ApiSuccess`](#standard-success-envelope)&lt;[`SyncConflictResolveResponse`](#schema-syncconflictresolveresponse)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                                                 |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                                                 |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                                                 |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                                                 |
| 409    | Conflict is already resolved.                                                                                                                                                                                    | [`ApiError`](#standard-error-envelope)                                                                                 |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                                                 |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                                                 |

### `GET /api/v1/sync/nodes` — List sync nodes for the tenant (bearer session or SSR cookie, not HMAC)

- **operationId**: `syncListNodes`
- **Security**: bearerAuth + tenantHeader

Admin-facing view of node registrations — distinct from the machine-to-machine HMAC endpoints (`/sync/push`, `/sync/pull`, `/sync/status`, `/sync/objects*`).

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                    | Schema                                                                                                   |
| ------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 200    | All sync nodes registered for the tenant.      | [`ApiSuccess`](#standard-success-envelope)&lt;[`SyncNodeListResponse`](#schema-syncnodelistresponse)&gt; |
| 401    | Authentication required or expired.            | [`ApiError`](#standard-error-envelope)                                                                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy. | [`ApiError`](#standard-error-envelope)                                                                   |
| 500    | Internal server error without stack trace.     | [`ApiError`](#standard-error-envelope)                                                                   |

### `PATCH /api/v1/sync/nodes/{id}` — Activate/deactivate or rename a sync node

- **operationId**: `syncUpdateNode`
- **Security**: bearerAuth + tenantHeader

Deactivating a node takes effect immediately: every HMAC sync endpoint already rejects a non-active node with 403. Use this to revoke a lost/retired device.

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): [`UpdateSyncNodeRequest`](#schema-updatesyncnoderequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 200    | Sync node updated.                                                                                                                                                                                               | [`ApiSuccess`](#standard-success-envelope) |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)     |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)     |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)     |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)     |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)     |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)     |

### `GET /api/v1/sync/object-queue` — List object sync queue entries tenant-wide (bearer session, not HMAC)

- **operationId**: `syncListObjectQueue`
- **Security**: bearerAuth + tenantHeader

Admin-facing, all-nodes view — distinct from the node-scoped, HMAC `GET /sync/objects/status` that a single node polls for its own work.

**Parameters**

| Name               | In     | Required | Type                              | Description                                                                                   |
| ------------------ | ------ | -------- | --------------------------------- | --------------------------------------------------------------------------------------------- |
| `status`           | query  | no       | enum(`pending`, `sent`, `failed`) |                                                                                               |
| `cursor`           | query  | no       | string                            | Opaque keyset pagination cursor from a previous page's `nextCursor`. Omit for the first page. |
| `X-Correlation-ID` | header | no       | string                            | Optional server-side trace correlation ID.                                                    |
| `X-Request-ID`     | header | no       | string                            | Optional client-generated request trace ID.                                                   |

**Responses**

| Status | Description                                                      | Schema                                                                                                         |
| ------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 200    | Object sync queue entries tenant-wide (limit 200), newest first. | [`ApiSuccess`](#standard-success-envelope)&lt;[`ObjectQueueListResponse`](#schema-objectqueuelistresponse)&gt; |
| 400    | Validation or request error.                                     | [`ApiError`](#standard-error-envelope)                                                                         |
| 401    | Authentication required or expired.                              | [`ApiError`](#standard-error-envelope)                                                                         |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                   | [`ApiError`](#standard-error-envelope)                                                                         |
| 500    | Internal server error without stack trace.                       | [`ApiError`](#standard-error-envelope)                                                                         |

### `POST /api/v1/sync/object-queue/{id}/retry` — Manually retry a failed object sync queue entry

- **operationId**: `syncRetryObjectQueueEntry`
- **Security**: bearerAuth + tenantHeader

Human override of the automatic exponential-backoff schedule — resets retry_count/next_retry_at/last_error and status back to `pending` so the node's next status poll picks it up. Only `failed` entries are eligible; `pending`/`sent` are rejected with 409.

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                         | Schema                                     |
| ------ | --------------------------------------------------- | ------------------------------------------ |
| 200    | Entry reset to pending.                             | [`ApiSuccess`](#standard-success-envelope) |
| 401    | Authentication required or expired.                 | [`ApiError`](#standard-error-envelope)     |
| 403    | Access denied by RBAC, ABAC, or tenant policy.      | [`ApiError`](#standard-error-envelope)     |
| 404    | Resource not found or hidden by soft-delete policy. | [`ApiError`](#standard-error-envelope)     |
| 409    | Only failed entries can be retried.                 | [`ApiError`](#standard-error-envelope)     |
| 500    | Internal server error without stack trace.          | [`ApiError`](#standard-error-envelope)     |

### `POST /api/v1/sync/objects` — Enqueue local objects for R2 sync (upsert by objectKey)

- **operationId**: `syncEnqueueObjects`
- **Security**: syncHmac + tenantHeader

**Parameters**

| Name                     | In     | Required | Type               | Description                                    |
| ------------------------ | ------ | -------- | ------------------ | ---------------------------------------------- |
| `X-AWCMS-Mini-Node-ID`   | header | yes      | string             | Sync node identifier.                          |
| `X-AWCMS-Mini-Timestamp` | header | yes      | string (date-time) | Request timestamp used for anti-replay checks. |
| `X-AWCMS-Mini-Signature` | header | yes      | string             | HMAC signature over the sync request.          |
| `X-Correlation-ID`       | header | no       | string             | Optional server-side trace correlation ID.     |
| `X-Request-ID`           | header | no       | string             | Optional client-generated request trace ID.    |

**Request body** (required): [`ObjectSyncEnqueueRequest`](#schema-objectsyncenqueuerequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                                             |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 200    | Objects queued (re-enqueuing an existing objectKey upserts it back to pending).                                                                                                                                  | [`ApiSuccess`](#standard-success-envelope)&lt;[`ObjectSyncEnqueueResponse`](#schema-objectsyncenqueueresponse)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                                             |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                                             |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                                             |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                                             |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                                             |

### `GET /api/v1/sync/objects/status` — List this node's pending/failed object sync queue entries

- **operationId**: `syncGetObjectsStatus`
- **Security**: syncHmac + tenantHeader

**Parameters**

| Name                     | In     | Required | Type               | Description                                    |
| ------------------------ | ------ | -------- | ------------------ | ---------------------------------------------- |
| `X-AWCMS-Mini-Node-ID`   | header | yes      | string             | Sync node identifier.                          |
| `X-AWCMS-Mini-Timestamp` | header | yes      | string (date-time) | Request timestamp used for anti-replay checks. |
| `X-AWCMS-Mini-Signature` | header | yes      | string             | HMAC signature over the sync request.          |
| `X-Correlation-ID`       | header | no       | string             | Optional server-side trace correlation ID.     |
| `X-Request-ID`           | header | no       | string             | Optional client-generated request trace ID.    |

**Responses**

| Status | Description                                                                 | Schema                                                                                                           |
| ------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 200    | Non-sent object sync queue entries for this node (limit 100), oldest first. | [`ApiSuccess`](#standard-success-envelope)&lt;[`ObjectSyncStatusResponse`](#schema-objectsyncstatusresponse)&gt; |
| 401    | Authentication required or expired.                                         | [`ApiError`](#standard-error-envelope)                                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                              | [`ApiError`](#standard-error-envelope)                                                                           |
| 500    | Internal server error without stack trace.                                  | [`ApiError`](#standard-error-envelope)                                                                           |

### `POST /api/v1/sync/pull` — Pull events newer than the node's stored checkpoint

- **operationId**: `syncPull`
- **Security**: syncHmac + tenantHeader

**Parameters**

| Name                     | In     | Required | Type               | Description                                    |
| ------------------------ | ------ | -------- | ------------------ | ---------------------------------------------- |
| `X-AWCMS-Mini-Node-ID`   | header | yes      | string             | Sync node identifier.                          |
| `X-AWCMS-Mini-Timestamp` | header | yes      | string (date-time) | Request timestamp used for anti-replay checks. |
| `X-AWCMS-Mini-Signature` | header | yes      | string             | HMAC signature over the sync request.          |
| `X-Correlation-ID`       | header | no       | string             | Optional server-side trace correlation ID.     |
| `X-Request-ID`           | header | no       | string             | Optional client-generated request trace ID.    |

**Request body** (optional): [`SyncPullRequest`](#schema-syncpullrequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                           |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 200    | Events since the node's last checkpoint, and the new checkpoint.                                                                                                                                                 | [`ApiSuccess`](#standard-success-envelope)&lt;[`SyncPullResponse`](#schema-syncpullresponse)&gt; |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                           |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                           |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                           |

### `POST /api/v1/sync/push` — Push a batch of local events to the server (idempotent per batchId)

- **operationId**: `syncPush`
- **Security**: syncHmac + tenantHeader

**Parameters**

| Name                     | In     | Required | Type               | Description                                    |
| ------------------------ | ------ | -------- | ------------------ | ---------------------------------------------- |
| `X-AWCMS-Mini-Node-ID`   | header | yes      | string             | Sync node identifier.                          |
| `X-AWCMS-Mini-Timestamp` | header | yes      | string (date-time) | Request timestamp used for anti-replay checks. |
| `X-AWCMS-Mini-Signature` | header | yes      | string             | HMAC signature over the sync request.          |
| `X-Correlation-ID`       | header | no       | string             | Optional server-side trace correlation ID.     |
| `X-Request-ID`           | header | no       | string             | Optional client-generated request trace ID.    |

**Request body** (required): [`SyncPushRequest`](#schema-syncpushrequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                           |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 200    | Batch accepted (or already applied, if the batchId was seen before).                                                                                                                                             | [`ApiSuccess`](#standard-success-envelope)&lt;[`SyncPushResponse`](#schema-syncpushresponse)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                           |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                           |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                           |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                           |

### `GET /api/v1/sync/status` — Get the calling node's sync status

- **operationId**: `syncGetStatus`
- **Security**: syncHmac + tenantHeader

**Parameters**

| Name                     | In     | Required | Type               | Description                                    |
| ------------------------ | ------ | -------- | ------------------ | ---------------------------------------------- |
| `X-AWCMS-Mini-Node-ID`   | header | yes      | string             | Sync node identifier.                          |
| `X-AWCMS-Mini-Timestamp` | header | yes      | string (date-time) | Request timestamp used for anti-replay checks. |
| `X-AWCMS-Mini-Signature` | header | yes      | string             | HMAC signature over the sync request.          |
| `X-Correlation-ID`       | header | no       | string             | Optional server-side trace correlation ID.     |
| `X-Request-ID`           | header | no       | string             | Optional client-generated request trace ID.    |

**Responses**

| Status | Description                                    | Schema                                                                                               |
| ------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 200    | Sync node status.                              | [`ApiSuccess`](#standard-success-envelope)&lt;[`SyncStatusResponse`](#schema-syncstatusresponse)&gt; |
| 401    | Authentication required or expired.            | [`ApiError`](#standard-error-envelope)                                                               |
| 403    | Access denied by RBAC, ABAC, or tenant policy. | [`ApiError`](#standard-error-envelope)                                                               |
| 500    | Internal server error without stack trace.     | [`ApiError`](#standard-error-envelope)                                                               |

## Management Reporting

Generic read-aggregation reporting views (tenant activity, access/audit summary, sync health, module usage). Live aggregation over existing tables; no dedicated reporting tables, worker, or cache.

### `GET /api/v1/reports/access-audit` — Access/audit summary (ABAC decision counts, profile audit log count)

- **operationId**: `reportsGetAccessAudit`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                    | Schema                                                                                             |
| ------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 200    | Access/audit summary for the caller's tenant.  | [`ApiSuccess`](#standard-success-envelope)&lt;[`AccessAuditReport`](#schema-accessauditreport)&gt; |
| 401    | Authentication required or expired.            | [`ApiError`](#standard-error-envelope)                                                             |
| 403    | Access denied by RBAC, ABAC, or tenant policy. | [`ApiError`](#standard-error-envelope)                                                             |
| 500    | Internal server error without stack trace.     | [`ApiError`](#standard-error-envelope)                                                             |

### `GET /api/v1/reports/email-health` — Email queue health summary (queued/retry/failed/suppressed counts, healthy flag)

- **operationId**: `reportsGetEmailHealth`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                         | Schema                                                                                             |
| ------ | --------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 200    | Email queue health summary for the caller's tenant. | [`ApiSuccess`](#standard-success-envelope)&lt;[`EmailHealthReport`](#schema-emailhealthreport)&gt; |
| 401    | Authentication required or expired.                 | [`ApiError`](#standard-error-envelope)                                                             |
| 403    | Access denied by RBAC, ABAC, or tenant policy.      | [`ApiError`](#standard-error-envelope)                                                             |
| 500    | Internal server error without stack trace.          | [`ApiError`](#standard-error-envelope)                                                             |

### `GET /api/v1/reports/module-usage` — Module usage summary (one row-count signal per registered module)

- **operationId**: `reportsGetModuleUsage`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                    | Schema                                                                                                             |
| ------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 200    | Module usage summary for the caller's tenant.  | [`ApiSuccess`](#standard-success-envelope)&lt;[`ModuleUsageReportResponse`](#schema-moduleusagereportresponse)&gt; |
| 401    | Authentication required or expired.            | [`ApiError`](#standard-error-envelope)                                                                             |
| 403    | Access denied by RBAC, ABAC, or tenant policy. | [`ApiError`](#standard-error-envelope)                                                                             |
| 500    | Internal server error without stack trace.     | [`ApiError`](#standard-error-envelope)                                                                             |

### `GET /api/v1/reports/sync-health` — Sync health summary (node/conflict/object-queue counts, healthy flag)

- **operationId**: `reportsGetSyncHealth`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                    | Schema                                                                                           |
| ------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 200    | Sync health summary for the caller's tenant.   | [`ApiSuccess`](#standard-success-envelope)&lt;[`SyncHealthReport`](#schema-synchealthreport)&gt; |
| 401    | Authentication required or expired.            | [`ApiError`](#standard-error-envelope)                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy. | [`ApiError`](#standard-error-envelope)                                                           |
| 500    | Internal server error without stack trace.     | [`ApiError`](#standard-error-envelope)                                                           |

### `GET /api/v1/reports/tenant-activity` — Tenant activity summary (tenant, active users/offices, most recent login)

- **operationId**: `reportsGetTenantActivity`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                      | Schema                                                                                                   |
| ------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| 200    | Tenant activity summary for the caller's tenant. | [`ApiSuccess`](#standard-success-envelope)&lt;[`TenantActivityReport`](#schema-tenantactivityreport)&gt; |
| 401    | Authentication required or expired.              | [`ApiError`](#standard-error-envelope)                                                                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.   | [`ApiError`](#standard-error-envelope)                                                                   |
| 500    | Internal server error without stack trace.       | [`ApiError`](#standard-error-envelope)                                                                   |

## Logging & Audit

Cross-module audit trail (awcms_mini_audit_events) and its read API. Complements, not replaces, domain events and structured logs.

### `GET /api/v1/logs/audit` — List audit trail events for the tenant (limit 100, newest first)

- **operationId**: `logsGetAuditTrail`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type                                | Description                                                                                   |
| ------------------ | ------ | -------- | ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `resourceType`     | query  | no       | string                              |                                                                                               |
| `action`           | query  | no       | string                              |                                                                                               |
| `severity`         | query  | no       | enum(`info`, `warning`, `critical`) |                                                                                               |
| `cursor`           | query  | no       | string                              | Opaque keyset pagination cursor from a previous page's `nextCursor`. Omit for the first page. |
| `X-Correlation-ID` | header | no       | string                              | Optional server-side trace correlation ID.                                                    |
| `X-Request-ID`     | header | no       | string                              | Optional client-generated request trace ID.                                                   |

**Responses**

| Status | Description                                                     | Schema                                                                                                       |
| ------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 200    | Audit events for the caller's tenant (limit 100, newest first). | [`ApiSuccess`](#standard-success-envelope)&lt;[`AuditEventListResponse`](#schema-auditeventlistresponse)&gt; |
| 400    | Validation or request error.                                    | [`ApiError`](#standard-error-envelope)                                                                       |
| 401    | Authentication required or expired.                             | [`ApiError`](#standard-error-envelope)                                                                       |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                  | [`ApiError`](#standard-error-envelope)                                                                       |
| 500    | Internal server error without stack trace.                      | [`ApiError`](#standard-error-envelope)                                                                       |

## Profile Identity

Profile lifecycle (soft delete/restore/purge) demonstrating the audit trail end-to-end. Full profile CRUD (create/update/list) remains out of scope/backlog.

### `DELETE /api/v1/profiles/{id}` — Soft delete a profile (lifecycle only; no profile CRUD yet)

- **operationId**: `profilesSoftDelete`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): [`ProfileDeleteRequest`](#schema-profiledeleterequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                                           |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 200    | Profile soft-deleted.                                                                                                                                                                                            | [`ApiSuccess`](#standard-success-envelope)&lt;[`ProfileLifecycleResponse`](#schema-profilelifecycleresponse)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                                           |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                                           |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                                           |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                                           |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                                           |

### `POST /api/v1/profiles/{id}/purge` — Permanently purge a soft-deleted profile (hard delete)

- **operationId**: `profilesPurge`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                                                                                       | Schema                                                                                                           |
| ------ | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 200    | Profile purged.                                                                                                                   | [`ApiSuccess`](#standard-success-envelope)&lt;[`ProfileLifecycleResponse`](#schema-profilelifecycleresponse)&gt; |
| 400    | Profile is not currently soft-deleted; purge is only allowed after soft delete.                                                   | [`ApiError`](#standard-error-envelope)                                                                           |
| 401    | Authentication required or expired.                                                                                               | [`ApiError`](#standard-error-envelope)                                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                    | [`ApiError`](#standard-error-envelope)                                                                           |
| 404    | Resource not found or hidden by soft-delete policy.                                                                               | [`ApiError`](#standard-error-envelope)                                                                           |
| 409    | Purge blocked by foreign-key-referencing dependents (identities, identifiers, channels, addresses, entity links, merge requests). | [`ApiError`](#standard-error-envelope)                                                                           |
| 500    | Internal server error without stack trace.                                                                                        | [`ApiError`](#standard-error-envelope)                                                                           |

### `POST /api/v1/profiles/{id}/restore` — Restore a soft-deleted profile

- **operationId**: `profilesRestore`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                         | Schema                                                                                                           |
| ------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 200    | Profile restored.                                   | [`ApiSuccess`](#standard-success-envelope)&lt;[`ProfileLifecycleResponse`](#schema-profilelifecycleresponse)&gt; |
| 401    | Authentication required or expired.                 | [`ApiError`](#standard-error-envelope)                                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy.      | [`ApiError`](#standard-error-envelope)                                                                           |
| 404    | Resource not found or hidden by soft-delete policy. | [`ApiError`](#standard-error-envelope)                                                                           |
| 500    | Internal server error without stack trace.          | [`ApiError`](#standard-error-envelope)                                                                           |

## Database Connectivity

Connection pool config, work-class backpressure gate, and circuit breaker health (Issue 10.2, doc 16 §Connection pooling dan backpressure).

### `GET /api/v1/database/pool/health` — Database pool/backpressure health (circuit breaker state, work-class saturation, DB reachability)

- **operationId**: `getDatabasePoolHealth`
- **Security**: none (public endpoint)

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                                      | Schema                                                                                                               |
| ------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 200    | Aggregate pool/backpressure health. Never includes tenant data or query content. | [`ApiSuccess`](#standard-success-envelope)&lt;[`DatabasePoolHealthResponse`](#schema-databasepoolhealthresponse)&gt; |
| 500    | Internal server error without stack trace.                                       | [`ApiError`](#standard-error-envelope)                                                                               |

## Workflow Approval

Generic multi-step approval engine (definitions, instances, tasks, decisions). Only the decision API is public (doc 17 seed grants no create/configure action for workflow.approval) — no create-definition/start-instance endpoint by design.

### `GET /api/v1/workflows/tasks` — List this tenant's pending workflow tasks (limit 100, oldest first)

- **operationId**: `workflowsGetPendingTasks`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                               | Schema                                                                                                           |
| ------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 200    | Pending workflow tasks for the caller's tenant (limit 100, oldest first). | [`ApiSuccess`](#standard-success-envelope)&lt;[`WorkflowTaskListResponse`](#schema-workflowtasklistresponse)&gt; |
| 400    | Validation or request error.                                              | [`ApiError`](#standard-error-envelope)                                                                           |
| 401    | Authentication required or expired.                                       | [`ApiError`](#standard-error-envelope)                                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                            | [`ApiError`](#standard-error-envelope)                                                                           |
| 500    | Internal server error without stack trace.                                | [`ApiError`](#standard-error-envelope)                                                                           |

### `POST /api/v1/workflows/tasks/{id}/decisions` — Record a decision (approve/reject) for a pending workflow task

- **operationId**: `workflowsRecordTaskDecision`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `Idempotency-Key`  | header | yes      | string        | Required for high-risk mutations.           |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): [`WorkflowTaskDecisionRequest`](#schema-workflowtaskdecisionrequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 200    | Decision recorded. Instance advances to the next step, is approved, or is rejected depending on the decision and remaining steps.                                                                                | [`ApiSuccess`](#standard-success-envelope)&lt;[`WorkflowTaskDecisionResponse`](#schema-workflowtaskdecisionresponse)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                                                   |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                                                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy — including self-approval denial when the caller is the same tenant user who requested the workflow instance.                                                      | [`ApiError`](#standard-error-envelope)                                                                                   |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                                                   |
| 409    | Idempotency-Key reused with a different request, or the task's decision has already been recorded.                                                                                                               | [`ApiError`](#standard-error-envelope)                                                                                   |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                                                   |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                                                   |

## Form Drafts

Generic, domain-agnostic server-side draft store for the reusable wizard pattern (Issue #484) — create/update/read/submit/delete a tenant-scoped JSONB payload. No domain-specific meaning; a derived module decides what a draft's payload contains.

### `GET /api/v1/form-drafts` — List the caller's tenant's non-deleted form drafts

- **operationId**: `formDraftsList`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type                                               | Description                                 |
| ------------------ | ------ | -------- | -------------------------------------------------- | ------------------------------------------- |
| `moduleKey`        | query  | no       | string                                             |                                             |
| `wizardKey`        | query  | no       | string                                             |                                             |
| `status`           | query  | no       | enum(`draft`, `submitted`, `abandoned`, `expired`) |                                             |
| `X-Correlation-ID` | header | no       | string                                             | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string                                             | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                    | Schema                                                                                                     |
| ------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 200    | Form drafts for the caller's tenant (limit 100, newest first). | [`ApiSuccess`](#standard-success-envelope)&lt;[`FormDraftListResponse`](#schema-formdraftlistresponse)&gt; |
| 400    | Validation or request error.                                   | [`ApiError`](#standard-error-envelope)                                                                     |
| 401    | Authentication required or expired.                            | [`ApiError`](#standard-error-envelope)                                                                     |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                 | [`ApiError`](#standard-error-envelope)                                                                     |
| 500    | Internal server error without stack trace.                     | [`ApiError`](#standard-error-envelope)                                                                     |

### `POST /api/v1/form-drafts` — Create a new form draft

- **operationId**: `formDraftsCreate`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): [`CreateFormDraftRequest`](#schema-createformdraftrequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 200    | Form draft created.                                                                                                                                                                                              | [`ApiSuccess`](#standard-success-envelope)&lt;[`FormDraftItem`](#schema-formdraftitem)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                     |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                     |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                     |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                     |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                     |

### `GET /api/v1/form-drafts/{id}` — Read one form draft (resume-on-load)

- **operationId**: `formDraftsGet`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                         | Schema                                                                                     |
| ------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 200    | The requested form draft.                           | [`ApiSuccess`](#standard-success-envelope)&lt;[`FormDraftItem`](#schema-formdraftitem)&gt; |
| 400    | Validation or request error.                        | [`ApiError`](#standard-error-envelope)                                                     |
| 401    | Authentication required or expired.                 | [`ApiError`](#standard-error-envelope)                                                     |
| 403    | Access denied by RBAC, ABAC, or tenant policy.      | [`ApiError`](#standard-error-envelope)                                                     |
| 404    | Resource not found or hidden by soft-delete policy. | [`ApiError`](#standard-error-envelope)                                                     |
| 500    | Internal server error without stack trace.          | [`ApiError`](#standard-error-envelope)                                                     |

### `PATCH /api/v1/form-drafts/{id}` — Update a form draft's step/payload/expiry

- **operationId**: `formDraftsUpdate`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): [`UpdateFormDraftRequest`](#schema-updateformdraftrequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 200    | Form draft updated.                                                                                                                                                                                              | [`ApiSuccess`](#standard-success-envelope)&lt;[`FormDraftItem`](#schema-formdraftitem)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                     |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                     |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                     |
| 404    | Form draft not found, deleted, or no longer editable (already submitted/abandoned/expired).                                                                                                                      | [`ApiError`](#standard-error-envelope)                                                     |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                     |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                     |

### `DELETE /api/v1/form-drafts/{id}` — Soft-delete (abandon) a form draft

- **operationId**: `formDraftsDelete`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (optional): object

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 200    | Form draft deleted.                                                                                                                                                                                              | [`ApiSuccess`](#standard-success-envelope)&lt;object&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                   |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                   |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                   |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                   |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                   |

### `POST /api/v1/form-drafts/{id}/submit` — Submit a form draft (transitions draft -> submitted)

- **operationId**: `formDraftsSubmit`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `Idempotency-Key`  | header | yes      | string        | Required for high-risk mutations.           |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                     | Schema                                                                                     |
| ------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 200    | Form draft submitted.                                           | [`ApiSuccess`](#standard-success-envelope)&lt;[`FormDraftItem`](#schema-formdraftitem)&gt; |
| 400    | Validation or request error.                                    | [`ApiError`](#standard-error-envelope)                                                     |
| 401    | Authentication required or expired.                             | [`ApiError`](#standard-error-envelope)                                                     |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                  | [`ApiError`](#standard-error-envelope)                                                     |
| 404    | Form draft not found, already submitted, or no longer editable. | [`ApiError`](#standard-error-envelope)                                                     |
| 409    | Idempotency-Key reused with a different request.                | [`ApiError`](#standard-error-envelope)                                                     |
| 500    | Internal server error without stack trace.                      | [`ApiError`](#standard-error-envelope)                                                     |

## Email Templates

Tenant email template CRUD, soft-delete/restore, per-category variable allowlists, i18n locale variants, and admin preview (Issue #498).

### `GET /api/v1/email/templates` — List the caller's tenant's email templates

- **operationId**: `emailTemplatesList`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type    | Description                                 |
| ------------------ | ------ | -------- | ------- | ------------------------------------------- |
| `includeInactive`  | query  | no       | boolean |                                             |
| `X-Correlation-ID` | header | no       | string  | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string  | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                        | Schema                                                                                                             |
| ------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| 200    | Email templates for the caller's tenant (limit 100, newest first). | [`ApiSuccess`](#standard-success-envelope)&lt;[`EmailTemplateListResponse`](#schema-emailtemplatelistresponse)&gt; |
| 400    | Validation or request error.                                       | [`ApiError`](#standard-error-envelope)                                                                             |
| 401    | Authentication required or expired.                                | [`ApiError`](#standard-error-envelope)                                                                             |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                     | [`ApiError`](#standard-error-envelope)                                                                             |
| 500    | Internal server error without stack trace.                         | [`ApiError`](#standard-error-envelope)                                                                             |

### `POST /api/v1/email/templates` — Create an email template

- **operationId**: `emailTemplatesCreate`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): [`CreateEmailTemplateRequest`](#schema-createemailtemplaterequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                             |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 200    | Email template created.                                                                                                                                                                                          | [`ApiSuccess`](#standard-success-envelope)&lt;[`EmailTemplateItem`](#schema-emailtemplateitem)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                             |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                             |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                             |
| 409    | An active template already exists for this templateKey.                                                                                                                                                          | [`ApiError`](#standard-error-envelope)                                                             |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                             |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                             |

### `GET /api/v1/email/templates/{id}` — Read one email template

- **operationId**: `emailTemplatesGet`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                         | Schema                                                                                             |
| ------ | --------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 200    | The requested email template.                       | [`ApiSuccess`](#standard-success-envelope)&lt;[`EmailTemplateItem`](#schema-emailtemplateitem)&gt; |
| 400    | Validation or request error.                        | [`ApiError`](#standard-error-envelope)                                                             |
| 401    | Authentication required or expired.                 | [`ApiError`](#standard-error-envelope)                                                             |
| 403    | Access denied by RBAC, ABAC, or tenant policy.      | [`ApiError`](#standard-error-envelope)                                                             |
| 404    | Resource not found or hidden by soft-delete policy. | [`ApiError`](#standard-error-envelope)                                                             |
| 500    | Internal server error without stack trace.          | [`ApiError`](#standard-error-envelope)                                                             |

### `PATCH /api/v1/email/templates/{id}` — Update an email template

- **operationId**: `emailTemplatesUpdate`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): [`UpdateEmailTemplateRequest`](#schema-updateemailtemplaterequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                             |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 200    | Email template updated.                                                                                                                                                                                          | [`ApiSuccess`](#standard-success-envelope)&lt;[`EmailTemplateItem`](#schema-emailtemplateitem)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                             |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                             |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                             |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                             |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                             |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                             |

### `DELETE /api/v1/email/templates/{id}` — Soft-delete an email template

- **operationId**: `emailTemplatesDelete`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): object

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 200    | Email template deleted.                                                                                                                                                                                          | [`ApiSuccess`](#standard-success-envelope)&lt;object&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                   |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                   |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                   |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                   |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                   |

### `POST /api/v1/email/templates/{id}/preview` — Preview a rendered template with synthetic sample data (never real recipient data)

- **operationId**: `emailTemplatesPreview`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (optional): object

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 200    | Rendered preview.                                                                                                                                                                                                | [`ApiSuccess`](#standard-success-envelope)&lt;[`EmailTemplatePreviewResponse`](#schema-emailtemplatepreviewresponse)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                                                   |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                                                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                                                   |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                                                   |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                                                   |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                                                   |

### `POST /api/v1/email/templates/{id}/restore` — Restore a soft-deleted email template

- **operationId**: `emailTemplatesRestore`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                       | Schema                                                                                             |
| ------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 200    | Email template restored.                          | [`ApiSuccess`](#standard-success-envelope)&lt;[`EmailTemplateItem`](#schema-emailtemplateitem)&gt; |
| 400    | Validation or request error.                      | [`ApiError`](#standard-error-envelope)                                                             |
| 401    | Authentication required or expired.               | [`ApiError`](#standard-error-envelope)                                                             |
| 403    | Access denied by RBAC, ABAC, or tenant policy.    | [`ApiError`](#standard-error-envelope)                                                             |
| 404    | Template not found or not currently soft-deleted. | [`ApiError`](#standard-error-envelope)                                                             |
| 500    | Internal server error without stack trace.        | [`ApiError`](#standard-error-envelope)                                                             |

## Email Announcements

Bulk announcement/notification enqueue and dry-run preview, targeting an explicit user list, a role, or the whole tenant with two-tier ABAC (Issue #497).

### `POST /api/v1/email/announcements` — Enqueue a notification/announcement to an explicit user list, a role, or the whole tenant

- **operationId**: `emailAnnouncementsCreate`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `Idempotency-Key`  | header | yes      | string | Required for high-risk mutations.           |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): [`AnnouncementRequest`](#schema-announcementrequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 200    | Announcement enqueued.                                                                                                                                                                                           | [`ApiSuccess`](#standard-success-envelope)&lt;[`AnnouncementCreateResponse`](#schema-announcementcreateresponse)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                                               |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                                               |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                                               |
| 404    | No active template found for the given templateKey.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                                               |
| 409    | Idempotency-Key reused with a different request.                                                                                                                                                                 | [`ApiError`](#standard-error-envelope)                                                                               |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                                               |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                                               |

### `POST /api/v1/email/announcements/preview` — Dry-run: resolves the same targeting criteria as a real send and returns a recipient count plus a synthetic-data sample render — never the actual recipient list

- **operationId**: `emailAnnouncementsPreview`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): [`AnnouncementRequest`](#schema-announcementrequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 200    | Preview result.                                                                                                                                                                                                  | [`ApiSuccess`](#standard-success-envelope)&lt;[`AnnouncementPreviewResponse`](#schema-announcementpreviewresponse)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                                                 |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                                                 |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                                                 |
| 404    | No active template found for the given templateKey.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                                                 |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                                                 |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                                                 |

## Email Messages

Admin queue diagnostics (queue health, failed messages, retry backlog) and cancel-before-send for still-queued messages (Issue #499).

### `GET /api/v1/email/messages` — List tenant-wide email queue diagnostics (queue health, failed messages, retry backlog) — never the raw recipient address

- **operationId**: `emailMessagesList`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type                                                                                 | Description                                                                                   |
| ------------------ | ------ | -------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `status`           | query  | no       | enum(`queued`, `sending`, `sent`, `failed`, `retry_wait`, `cancelled`, `suppressed`) |                                                                                               |
| `cursor`           | query  | no       | string                                                                               | Opaque keyset pagination cursor from a previous page's `nextCursor`. Omit for the first page. |
| `X-Correlation-ID` | header | no       | string                                                                               | Optional server-side trace correlation ID.                                                    |
| `X-Request-ID`     | header | no       | string                                                                               | Optional client-generated request trace ID.                                                   |

**Responses**

| Status | Description                                           | Schema                                                                                                           |
| ------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 200    | Email messages tenant-wide (limit 100), newest first. | [`ApiSuccess`](#standard-success-envelope)&lt;[`EmailMessageListResponse`](#schema-emailmessagelistresponse)&gt; |
| 400    | Validation or request error.                          | [`ApiError`](#standard-error-envelope)                                                                           |
| 401    | Authentication required or expired.                   | [`ApiError`](#standard-error-envelope)                                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy.        | [`ApiError`](#standard-error-envelope)                                                                           |
| 500    | Internal server error without stack trace.            | [`ApiError`](#standard-error-envelope)                                                                           |

### `POST /api/v1/email/messages/{id}/cancel` — Cancel a still-queued (queued/retry_wait) email message before it sends

- **operationId**: `emailMessagesCancel`
- **Security**: bearerAuth + tenantHeader

Technical mitigation for the "accidental bulk send" incident scenario. Only queued/retry_wait messages are eligible; anything already sending/sent/failed/cancelled/suppressed is rejected with 409.

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                 | Schema                                                                                             |
| ------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 200    | Message cancelled.                                          | [`ApiSuccess`](#standard-success-envelope)&lt;[`EmailMessageEntry`](#schema-emailmessageentry)&gt; |
| 401    | Authentication required or expired.                         | [`ApiError`](#standard-error-envelope)                                                             |
| 403    | Access denied by RBAC, ABAC, or tenant policy.              | [`ApiError`](#standard-error-envelope)                                                             |
| 404    | Resource not found or hidden by soft-delete policy.         | [`ApiError`](#standard-error-envelope)                                                             |
| 409    | Message can no longer be cancelled (not queued/retry_wait). | [`ApiError`](#standard-error-envelope)                                                             |
| 500    | Internal server error without stack trace.                  | [`ApiError`](#standard-error-envelope)                                                             |

## Email Suppressions

Manual suppression list read/create/delete — recipients excluded from future sends (bounce/complaint/manual/unsubscribed), Issue #499.

### `GET /api/v1/email/suppressions` — List the tenant's email suppression list (limit 100, newest first)

- **operationId**: `emailSuppressionsList`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                    | Schema                                                                                                         |
| ------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 200    | Suppression list entries — recipient address is always masked. | [`ApiSuccess`](#standard-success-envelope)&lt;[`SuppressionListResponse`](#schema-suppressionlistresponse)&gt; |
| 401    | Authentication required or expired.                            | [`ApiError`](#standard-error-envelope)                                                                         |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                 | [`ApiError`](#standard-error-envelope)                                                                         |
| 500    | Internal server error without stack trace.                     | [`ApiError`](#standard-error-envelope)                                                                         |

### `POST /api/v1/email/suppressions` — Manually suppress a recipient address

- **operationId**: `emailSuppressionsCreate`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): [`SuppressionCreateRequest`](#schema-suppressioncreaterequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                                             |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 200    | Suppression entry created (or already existed).                                                                                                                                                                  | [`ApiSuccess`](#standard-success-envelope)&lt;[`SuppressionCreateResponse`](#schema-suppressioncreateresponse)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                                             |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                                             |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                                             |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                                             |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                                             |

### `DELETE /api/v1/email/suppressions/{id}` — Remove a manual suppression entry

- **operationId**: `emailSuppressionsDelete`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                         | Schema                                     |
| ------ | --------------------------------------------------- | ------------------------------------------ |
| 200    | Suppression entry removed.                          | [`ApiSuccess`](#standard-success-envelope) |
| 401    | Authentication required or expired.                 | [`ApiError`](#standard-error-envelope)     |
| 403    | Access denied by RBAC, ABAC, or tenant policy.      | [`ApiError`](#standard-error-envelope)     |
| 404    | Resource not found or hidden by soft-delete policy. | [`ApiError`](#standard-error-envelope)     |
| 500    | Internal server error without stack trace.          | [`ApiError`](#standard-error-envelope)     |

## Module Management

Database-backed module catalog and descriptor sync (epic #510). Read the module registry, inspect a single module's detail, and trigger a sync of trusted code descriptors into the database — distinct from `GET /api/v1/access/modules`'s permission catalog.

### `GET /api/v1/modules` — List the module catalog — every module currently registered in code, merged with its database-tracked lifecycle state

- **operationId**: `modulesList`
- **Security**: bearerAuth + tenantHeader

Distinct from `GET /api/v1/access/modules` (Issue 12.1's permission catalog grouped by module) — that endpoint's behavior is unchanged by this one.

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                    | Schema                                                                                                             |
| ------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 200    | Module catalog.                                | [`ApiSuccess`](#standard-success-envelope)&lt;[`ModuleCatalogListResponse`](#schema-modulecataloglistresponse)&gt; |
| 400    | Validation or request error.                   | [`ApiError`](#standard-error-envelope)                                                                             |
| 401    | Authentication required or expired.            | [`ApiError`](#standard-error-envelope)                                                                             |
| 403    | Access denied by RBAC, ABAC, or tenant policy. | [`ApiError`](#standard-error-envelope)                                                                             |
| 500    | Internal server error without stack trace.     | [`ApiError`](#standard-error-envelope)                                                                             |

### `GET /api/v1/modules/{moduleKey}` — Module catalog detail

- **operationId**: `modulesGetDetail`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `moduleKey`        | path   | yes      | string |                                             |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                         | Schema                                                                                               |
| ------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 200    | Module catalog entry.                               | [`ApiSuccess`](#standard-success-envelope)&lt;[`ModuleCatalogEntry`](#schema-modulecatalogentry)&gt; |
| 401    | Authentication required or expired.                 | [`ApiError`](#standard-error-envelope)                                                               |
| 403    | Access denied by RBAC, ABAC, or tenant policy.      | [`ApiError`](#standard-error-envelope)                                                               |
| 404    | Resource not found or hidden by soft-delete policy. | [`ApiError`](#standard-error-envelope)                                                               |
| 500    | Internal server error without stack trace.          | [`ApiError`](#standard-error-envelope)                                                               |

### `GET /api/v1/modules/{moduleKey}/health` — Module health/readiness (fast, bounded)

- **operationId**: `modulesGetHealth`
- **Security**: bearerAuth + tenantHeader

Fast, bounded readiness signals (descriptor registered, DB registry synced, migrations applied, permission catalog synced, settings valid, jobs documented, OpenAPI/AsyncAPI documented). Never runs a live provider/network check — that's the explicit `POST .../health/check` action only.

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `moduleKey`        | path   | yes      | string |                                             |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                         | Schema                                                                                               |
| ------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 200    | Health/readiness report for the module.             | [`ApiSuccess`](#standard-success-envelope)&lt;[`ModuleHealthReport`](#schema-modulehealthreport)&gt; |
| 401    | Authentication required or expired.                 | [`ApiError`](#standard-error-envelope)                                                               |
| 403    | Access denied by RBAC, ABAC, or tenant policy.      | [`ApiError`](#standard-error-envelope)                                                               |
| 404    | Resource not found or hidden by soft-delete policy. | [`ApiError`](#standard-error-envelope)                                                               |
| 500    | Internal server error without stack trace.          | [`ApiError`](#standard-error-envelope)                                                               |

### `POST /api/v1/modules/{moduleKey}/health/check` — Trigger an explicit module health check

- **operationId**: `modulesRunHealthCheck`
- **Security**: bearerAuth + tenantHeader

Same generic signals as `GET .../health`, plus a real, bounded, network-calling provider health check where one exists (`email` only today). Deliberately a separate action/permission from the passive `GET` — never invoked automatically from a business transaction path. Audited.

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `moduleKey`        | path   | yes      | string |                                             |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                                                 | Schema                                                                                               |
| ------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 200    | Health/readiness report for the module, including the live provider check where applicable. | [`ApiSuccess`](#standard-success-envelope)&lt;[`ModuleHealthReport`](#schema-modulehealthreport)&gt; |
| 401    | Authentication required or expired.                                                         | [`ApiError`](#standard-error-envelope)                                                               |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                              | [`ApiError`](#standard-error-envelope)                                                               |
| 404    | Resource not found or hidden by soft-delete policy.                                         | [`ApiError`](#standard-error-envelope)                                                               |
| 500    | Internal server error without stack trace.                                                  | [`ApiError`](#standard-error-envelope)                                                               |

### `GET /api/v1/modules/{moduleKey}/jobs` — Module job/command registry

- **operationId**: `modulesGetJobs`
- **Security**: bearerAuth + tenantHeader

The module's declared operational commands (`command`, `purpose`, `recommendedSchedule`, `environmentNotes`, `safeInOfflineLan`). Documentation only — there is no corresponding endpoint to execute a job; running arbitrary commands from a web UI is explicitly out of scope.

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `moduleKey`        | path   | yes      | string |                                             |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                         | Schema                                                                                               |
| ------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 200    | Job registry entries for the module.                | [`ApiSuccess`](#standard-success-envelope)&lt;[`ModuleJobsResponse`](#schema-modulejobsresponse)&gt; |
| 401    | Authentication required or expired.                 | [`ApiError`](#standard-error-envelope)                                                               |
| 403    | Access denied by RBAC, ABAC, or tenant policy.      | [`ApiError`](#standard-error-envelope)                                                               |
| 404    | Resource not found or hidden by soft-delete policy. | [`ApiError`](#standard-error-envelope)                                                               |
| 500    | Internal server error without stack trace.          | [`ApiError`](#standard-error-envelope)                                                               |

### `GET /api/v1/modules/{moduleKey}/permissions` — Module permission sync/status

- **operationId**: `modulesGetPermissionSync`
- **Security**: bearerAuth + tenantHeader

Compares the module's descriptor-declared `permissions` against the `awcms_mini_permissions` catalog and classifies each one `synced`, `missing`, `orphaned`, or `mismatched_description`. Read-only — never writes to the catalog, never changes a role's assigned permissions.

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `moduleKey`        | path   | yes      | string |                                             |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                         | Schema                                                                                                               |
| ------ | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 200    | Permission sync report for the module.              | [`ApiSuccess`](#standard-success-envelope)&lt;[`ModulePermissionSyncReport`](#schema-modulepermissionsyncreport)&gt; |
| 401    | Authentication required or expired.                 | [`ApiError`](#standard-error-envelope)                                                                               |
| 403    | Access denied by RBAC, ABAC, or tenant policy.      | [`ApiError`](#standard-error-envelope)                                                                               |
| 404    | Resource not found or hidden by soft-delete policy. | [`ApiError`](#standard-error-envelope)                                                                               |
| 500    | Internal server error without stack trace.          | [`ApiError`](#standard-error-envelope)                                                                               |

### `POST /api/v1/modules/sync` — Sync trusted code descriptors into the database registry

- **operationId**: `modulesSync`
- **Security**: bearerAuth + tenantHeader

Naturally idempotent — no `Idempotency-Key` required. Running it repeatedly is always safe and reports the same result each time when nothing has changed.

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                    | Schema                                                                                               |
| ------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 200    | Sync result.                                   | [`ApiSuccess`](#standard-success-envelope)&lt;[`ModuleSyncResponse`](#schema-modulesyncresponse)&gt; |
| 401    | Authentication required or expired.            | [`ApiError`](#standard-error-envelope)                                                               |
| 403    | Access denied by RBAC, ABAC, or tenant policy. | [`ApiError`](#standard-error-envelope)                                                               |
| 500    | Internal server error without stack trace.     | [`ApiError`](#standard-error-envelope)                                                               |

### `GET /api/v1/tenant/modules` — List every registered module's enablement state for the caller's tenant

- **operationId**: `tenantModulesList`
- **Security**: bearerAuth + tenantHeader

A module with no explicit state (`tenantEnabled: true`, no `enabledAt`/`disabledAt`) has never been toggled — available by default (backward-compatible with pre-epic behavior).

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                    | Schema                                                                                                           |
| ------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 200    | Tenant module enablement state.                | [`ApiSuccess`](#standard-success-envelope)&lt;[`TenantModuleListResponse`](#schema-tenantmodulelistresponse)&gt; |
| 400    | Validation or request error.                   | [`ApiError`](#standard-error-envelope)                                                                           |
| 401    | Authentication required or expired.            | [`ApiError`](#standard-error-envelope)                                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy. | [`ApiError`](#standard-error-envelope)                                                                           |
| 500    | Internal server error without stack trace.     | [`ApiError`](#standard-error-envelope)                                                                           |

### `POST /api/v1/tenant/modules/{moduleKey}/disable` — Disable a module for the caller's tenant

- **operationId**: `tenantModulesDisable`
- **Security**: bearerAuth + tenantHeader

`reason` required. Never deletes tenant data — only writes `awcms_mini_tenant_modules`. Rejected with `409` if the module is core/system, already disabled, or another still-enabled module depends on it.

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `moduleKey`        | path   | yes      | string |                                             |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): object

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 200    | Module disabled for the tenant.                                                                                                                                                                                  | [`ApiSuccess`](#standard-success-envelope)&lt;[`TenantModuleMutationResponse`](#schema-tenantmodulemutationresponse)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                                                   |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                                                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                                                   |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                                                   |
| 409    | Dependency validation failed (see `error.code`: `MODULE_ALREADY_DISABLED`, `CORE_MODULE_CANNOT_BE_DISABLED`, `MODULE_REVERSE_DEPENDENCY_ACTIVE`).                                                                | [`ApiError`](#standard-error-envelope)                                                                                   |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                                                   |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                                                   |

### `POST /api/v1/tenant/modules/{moduleKey}/enable` — Enable a module for the caller's tenant

- **operationId**: `tenantModulesEnable`
- **Security**: bearerAuth + tenantHeader

Tenant-level availability only, never a runtime code load. Server-side dependency validation rejects the request with `409` if a direct dependency is missing/disabled, the module is part of a dependency cycle, or the module declares an incompatible `minAppVersion`. `404` only for an unknown/globally-disabled module key.

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `moduleKey`        | path   | yes      | string |                                             |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                                                                                                                                                     | Schema                                                                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 200    | Module enabled for the tenant.                                                                                                                                                                  | [`ApiSuccess`](#standard-success-envelope)&lt;[`TenantModuleMutationResponse`](#schema-tenantmodulemutationresponse)&gt; |
| 401    | Authentication required or expired.                                                                                                                                                             | [`ApiError`](#standard-error-envelope)                                                                                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                  | [`ApiError`](#standard-error-envelope)                                                                                   |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                             | [`ApiError`](#standard-error-envelope)                                                                                   |
| 409    | Dependency validation failed (see `error.code`: `MODULE_ALREADY_ENABLED`, `MODULE_DEPENDENCY_MISSING`, `MODULE_DEPENDENCY_DISABLED`, `MODULE_DEPENDENCY_CYCLE`, `MODULE_VERSION_INCOMPATIBLE`). | [`ApiError`](#standard-error-envelope)                                                                                   |
| 500    | Internal server error without stack trace.                                                                                                                                                      | [`ApiError`](#standard-error-envelope)                                                                                   |

### `GET /api/v1/tenant/modules/{moduleKey}/settings` — Read effective tenant module settings

- **operationId**: `tenantModuleSettingsGet`
- **Security**: bearerAuth + tenantHeader

Effective settings = the module's own code-declared defaults with the tenant's stored override applied on top. A module with no override row yet still returns a view (defaults-only `effective`), not a `404` — only an unknown `moduleKey` is `404`.

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `moduleKey`        | path   | yes      | string |                                             |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                         | Schema                                                                                               |
| ------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 200    | Effective module settings for the tenant.           | [`ApiSuccess`](#standard-success-envelope)&lt;[`ModuleSettingsView`](#schema-modulesettingsview)&gt; |
| 400    | Validation or request error.                        | [`ApiError`](#standard-error-envelope)                                                               |
| 401    | Authentication required or expired.                 | [`ApiError`](#standard-error-envelope)                                                               |
| 403    | Access denied by RBAC, ABAC, or tenant policy.      | [`ApiError`](#standard-error-envelope)                                                               |
| 404    | Resource not found or hidden by soft-delete policy. | [`ApiError`](#standard-error-envelope)                                                               |
| 500    | Internal server error without stack trace.          | [`ApiError`](#standard-error-envelope)                                                               |

### `PATCH /api/v1/tenant/modules/{moduleKey}/settings` — Update tenant module settings

- **operationId**: `tenantModuleSettingsUpdate`
- **Security**: bearerAuth + tenantHeader

Merges the body into the tenant's existing settings override (shallow, top-level JSON-merge-patch — omitted keys are left untouched). Rejected with `400 SETTINGS_SENSITIVE_KEY_REJECTED` if any key anywhere in the body looks secret-shaped (matches the shared redaction key list), or `400 SETTINGS_SECRET_SHAPED_VALUE_REJECTED` if any string value anywhere in the body looks credential-shaped regardless of its key's own name (a JWT, a PEM private key block, an AWS access key id, a raw `Bearer`/`Basic` header value, or a connection string with an embedded `user:pass@` credential) — provider secrets belong in environment variables or a secret manager, never tenant-writable settings. Audited with safe diff metadata (changed key names only, never values).

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `moduleKey`        | path   | yes      | string |                                             |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): object

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 200    | Module settings updated for the tenant.                                                                                                                                                                          | [`ApiSuccess`](#standard-success-envelope)&lt;[`ModuleSettingsView`](#schema-modulesettingsview)&gt; |
| 400    | Validation failed (see `error.code`: `VALIDATION_ERROR`, `SETTINGS_SENSITIVE_KEY_REJECTED`, `SETTINGS_SECRET_SHAPED_VALUE_REJECTED`).                                                                            | [`ApiError`](#standard-error-envelope)                                                               |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                               |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                               |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                               |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                               |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                               |

## Blog Posts

Tenant-scoped blog post admin API (epic #536, Issue #538) — CRUD plus lifecycle actions (submit for review, publish, schedule, archive, restore, purge). Builds on the `blog_content` schema/permission foundation from Issue #537; pages, taxonomies, and public routes are separate issues. Revision history is a distinct tag, see Blog Revisions.

### `GET /api/v1/blog/posts` — List this tenant's non-deleted blog posts

- **operationId**: `blogPostsList`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type                                                          | Description                                 |
| ------------------ | ------ | -------- | ------------------------------------------------------------- | ------------------------------------------- |
| `status`           | query  | no       | enum(`draft`, `review`, `scheduled`, `published`, `archived`) |                                             |
| `limit`            | query  | no       | integer                                                       |                                             |
| `X-Correlation-ID` | header | no       | string                                                        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string                                                        | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                           | Schema                                                                                                   |
| ------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 200    | Blog posts for the caller's tenant (limit 100, newest-updated first). | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogPostListResponse`](#schema-blogpostlistresponse)&gt; |
| 400    | Validation or request error.                                          | [`ApiError`](#standard-error-envelope)                                                                   |
| 401    | Authentication required or expired.                                   | [`ApiError`](#standard-error-envelope)                                                                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                        | [`ApiError`](#standard-error-envelope)                                                                   |
| 500    | Internal server error without stack trace.                            | [`ApiError`](#standard-error-envelope)                                                                   |

### `POST /api/v1/blog/posts` — Create a draft blog post

- **operationId**: `blogPostsCreate`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): [`CreateBlogPostRequest`](#schema-createblogpostrequest)

**Responses**

| Status | Description                                                                                                                                                                                                                                        | Schema                                                                                   |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 200    | Blog post created (status "draft").                                                                                                                                                                                                                | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogPostItem`](#schema-blogpostitem)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                   |
| 401    | Authentication required or expired.                                                                                                                                                                                                                | [`ApiError`](#standard-error-envelope)                                                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                   |
| 409    | A post already exists for this slug in this locale.                                                                                                                                                                                                | [`ApiError`](#standard-error-envelope)                                                   |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`.                                   | [`ApiError`](#standard-error-envelope)                                                   |
| 422    | NEWS_MEDIA_REFERENCE_INVALID (Issue #636) — full-online R2-only news portal mode is active for this tenant and featuredMediaId or a contentJson image gallery item does not reference an existing, same-tenant, verified/attached R2 media object. | [`ApiError`](#standard-error-envelope)                                                   |
| 500    | Internal server error without stack trace.                                                                                                                                                                                                         | [`ApiError`](#standard-error-envelope)                                                   |

### `GET /api/v1/blog/posts/{id}` — Read one blog post

- **operationId**: `blogPostsGet`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                         | Schema                                                                                   |
| ------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 200    | The requested blog post.                            | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogPostItem`](#schema-blogpostitem)&gt; |
| 400    | Validation or request error.                        | [`ApiError`](#standard-error-envelope)                                                   |
| 401    | Authentication required or expired.                 | [`ApiError`](#standard-error-envelope)                                                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.      | [`ApiError`](#standard-error-envelope)                                                   |
| 404    | Resource not found or hidden by soft-delete policy. | [`ApiError`](#standard-error-envelope)                                                   |
| 500    | Internal server error without stack trace.          | [`ApiError`](#standard-error-envelope)                                                   |

### `PATCH /api/v1/blog/posts/{id}` — Update a blog post (any field). Author may edit their own not-yet-published post even without blog_content.posts.update

- **operationId**: `blogPostsUpdate`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): [`UpdateBlogPostRequest`](#schema-updateblogpostrequest)

**Responses**

| Status | Description                                                                                                                                                                                                                                                  | Schema                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 200    | Blog post updated.                                                                                                                                                                                                                                           | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogPostItem`](#schema-blogpostitem)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                                                                 | [`ApiError`](#standard-error-envelope)                                                   |
| 401    | Authentication required or expired.                                                                                                                                                                                                                          | [`ApiError`](#standard-error-envelope)                                                   |
| 403    | Access denied — the caller neither holds blog_content.posts.update nor is the post's author editing their own not-yet-published post.                                                                                                                        | [`ApiError`](#standard-error-envelope)                                                   |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                                                                          | [`ApiError`](#standard-error-envelope)                                                   |
| 409    | A post already exists for this slug in this locale.                                                                                                                                                                                                          | [`ApiError`](#standard-error-envelope)                                                   |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`.                                             | [`ApiError`](#standard-error-envelope)                                                   |
| 422    | NEWS_MEDIA_REFERENCE_INVALID (Issue #636) — full-online R2-only news portal mode is active for this tenant and a submitted featuredMediaId or contentJson image gallery item does not reference an existing, same-tenant, verified/attached R2 media object. | [`ApiError`](#standard-error-envelope)                                                   |
| 500    | Internal server error without stack trace.                                                                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                   |

### `DELETE /api/v1/blog/posts/{id}` — Soft-delete a blog post

- **operationId**: `blogPostsDelete`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): object

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 200    | Blog post deleted.                                                                                                                                                                                               | [`ApiSuccess`](#standard-success-envelope)&lt;object&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                   |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                   |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                   |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                   |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                   |

### `POST /api/v1/blog/posts/{id}/archive` — Archive a blog post

- **operationId**: `blogPostsArchive`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `Idempotency-Key`  | header | yes      | string        | Required for high-risk mutations.           |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                                                                    | Schema                                                                                   |
| ------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 200    | Blog post moved to status "archived".                                                                          | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogPostItem`](#schema-blogpostitem)&gt; |
| 400    | Validation or request error.                                                                                   | [`ApiError`](#standard-error-envelope)                                                   |
| 401    | Authentication required or expired.                                                                            | [`ApiError`](#standard-error-envelope)                                                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                 | [`ApiError`](#standard-error-envelope)                                                   |
| 404    | Resource not found or hidden by soft-delete policy.                                                            | [`ApiError`](#standard-error-envelope)                                                   |
| 409    | Idempotency-Key reused with a different request, or the post's current status cannot transition to "archived". | [`ApiError`](#standard-error-envelope)                                                   |
| 500    | Internal server error without stack trace.                                                                     | [`ApiError`](#standard-error-envelope)                                                   |

### `POST /api/v1/blog/posts/{id}/publish` — Publish a blog post

- **operationId**: `blogPostsPublish`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `Idempotency-Key`  | header | yes      | string        | Required for high-risk mutations.           |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                                                                     | Schema                                                                                   |
| ------ | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 200    | Blog post moved to status "published".                                                                          | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogPostItem`](#schema-blogpostitem)&gt; |
| 400    | Validation or request error.                                                                                    | [`ApiError`](#standard-error-envelope)                                                   |
| 401    | Authentication required or expired.                                                                             | [`ApiError`](#standard-error-envelope)                                                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                  | [`ApiError`](#standard-error-envelope)                                                   |
| 404    | Resource not found or hidden by soft-delete policy.                                                             | [`ApiError`](#standard-error-envelope)                                                   |
| 409    | Idempotency-Key reused with a different request, or the post's current status cannot transition to "published". | [`ApiError`](#standard-error-envelope)                                                   |
| 500    | Internal server error without stack trace.                                                                      | [`ApiError`](#standard-error-envelope)                                                   |

### `POST /api/v1/blog/posts/{id}/purge` — Purge (hard delete) a blog post

- **operationId**: `blogPostsPurge`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `Idempotency-Key`  | header | yes      | string        | Required for high-risk mutations.           |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                                                   | Schema                                                   |
| ------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 200    | Blog post purged.                                                                             | [`ApiSuccess`](#standard-success-envelope)&lt;object&gt; |
| 400    | Validation or request error.                                                                  | [`ApiError`](#standard-error-envelope)                   |
| 401    | Authentication required or expired.                                                           | [`ApiError`](#standard-error-envelope)                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                | [`ApiError`](#standard-error-envelope)                   |
| 404    | Resource not found or hidden by soft-delete policy.                                           | [`ApiError`](#standard-error-envelope)                   |
| 409    | Idempotency-Key reused with a different request, or the post is not archived or soft-deleted. | [`ApiError`](#standard-error-envelope)                   |
| 500    | Internal server error without stack trace.                                                    | [`ApiError`](#standard-error-envelope)                   |

### `POST /api/v1/blog/posts/{id}/restore` — Restore a soft-deleted blog post

- **operationId**: `blogPostsRestore`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `Idempotency-Key`  | header | yes      | string        | Required for high-risk mutations.           |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                      | Schema                                                                                   |
| ------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 200    | Blog post restored.                              | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogPostItem`](#schema-blogpostitem)&gt; |
| 400    | Validation or request error.                     | [`ApiError`](#standard-error-envelope)                                                   |
| 401    | Authentication required or expired.              | [`ApiError`](#standard-error-envelope)                                                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.   | [`ApiError`](#standard-error-envelope)                                                   |
| 404    | Post not found or not currently soft-deleted.    | [`ApiError`](#standard-error-envelope)                                                   |
| 409    | Idempotency-Key reused with a different request. | [`ApiError`](#standard-error-envelope)                                                   |
| 500    | Internal server error without stack trace.       | [`ApiError`](#standard-error-envelope)                                                   |

### `POST /api/v1/blog/posts/{id}/schedule` — Schedule a blog post for future publishing

- **operationId**: `blogPostsSchedule`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `Idempotency-Key`  | header | yes      | string        | Required for high-risk mutations.           |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): [`ScheduleBlogPostRequest`](#schema-scheduleblogpostrequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 200    | Blog post moved to status "scheduled".                                                                                                                                                                           | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogPostItem`](#schema-blogpostitem)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                   |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                   |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                   |
| 409    | Idempotency-Key reused with a different request, or the post's current status cannot transition to "scheduled".                                                                                                  | [`ApiError`](#standard-error-envelope)                                                   |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                   |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                   |

### `POST /api/v1/blog/posts/{id}/submit-review` — Submit a draft blog post for review

- **operationId**: `blogPostsSubmitReview`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                              | Schema                                                                                   |
| ------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 200    | Blog post moved to status "review".                      | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogPostItem`](#schema-blogpostitem)&gt; |
| 400    | Validation or request error.                             | [`ApiError`](#standard-error-envelope)                                                   |
| 401    | Authentication required or expired.                      | [`ApiError`](#standard-error-envelope)                                                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.           | [`ApiError`](#standard-error-envelope)                                                   |
| 404    | Resource not found or hidden by soft-delete policy.      | [`ApiError`](#standard-error-envelope)                                                   |
| 409    | The post's current status cannot transition to "review". | [`ApiError`](#standard-error-envelope)                                                   |
| 500    | Internal server error without stack trace.               | [`ApiError`](#standard-error-envelope)                                                   |

## Blog Pages

Tenant-scoped static page admin API (epic #536, Issue #539) — plain CRUD only (no publish/schedule/archive/restore/purge lifecycle actions in this issue, unlike Blog Posts). Supports `pageType` (standard/landing/legal/system), `parentPageId`, and `menuOrder`.

### `GET /api/v1/blog/pages` — List this tenant's non-deleted blog pages

- **operationId**: `blogPagesList`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type                                                          | Description                                 |
| ------------------ | ------ | -------- | ------------------------------------------------------------- | ------------------------------------------- |
| `status`           | query  | no       | enum(`draft`, `review`, `scheduled`, `published`, `archived`) |                                             |
| `pageType`         | query  | no       | enum(`standard`, `landing`, `legal`, `system`)                |                                             |
| `limit`            | query  | no       | integer                                                       |                                             |
| `X-Correlation-ID` | header | no       | string                                                        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string                                                        | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                                           | Schema                                                                                                   |
| ------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 200    | Blog pages for the caller's tenant (limit 100, menu order then newest-updated first). | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogPageListResponse`](#schema-blogpagelistresponse)&gt; |
| 400    | Validation or request error.                                                          | [`ApiError`](#standard-error-envelope)                                                                   |
| 401    | Authentication required or expired.                                                   | [`ApiError`](#standard-error-envelope)                                                                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                        | [`ApiError`](#standard-error-envelope)                                                                   |
| 500    | Internal server error without stack trace.                                            | [`ApiError`](#standard-error-envelope)                                                                   |

### `POST /api/v1/blog/pages` — Create a draft blog page

- **operationId**: `blogPagesCreate`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): [`CreateBlogPageRequest`](#schema-createblogpagerequest)

**Responses**

| Status | Description                                                                                                                                                                                                                                        | Schema                                                                                   |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 200    | Blog page created (status "draft").                                                                                                                                                                                                                | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogPageItem`](#schema-blogpageitem)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                   |
| 401    | Authentication required or expired.                                                                                                                                                                                                                | [`ApiError`](#standard-error-envelope)                                                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                   |
| 409    | A page already exists for this slug in this locale.                                                                                                                                                                                                | [`ApiError`](#standard-error-envelope)                                                   |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`.                                   | [`ApiError`](#standard-error-envelope)                                                   |
| 422    | NEWS_MEDIA_REFERENCE_INVALID (Issue #636) — full-online R2-only news portal mode is active for this tenant and featuredMediaId or a contentJson image gallery item does not reference an existing, same-tenant, verified/attached R2 media object. | [`ApiError`](#standard-error-envelope)                                                   |
| 500    | Internal server error without stack trace.                                                                                                                                                                                                         | [`ApiError`](#standard-error-envelope)                                                   |

### `GET /api/v1/blog/pages/{id}` — Read one blog page

- **operationId**: `blogPagesGet`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                         | Schema                                                                                   |
| ------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 200    | The requested blog page.                            | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogPageItem`](#schema-blogpageitem)&gt; |
| 400    | Validation or request error.                        | [`ApiError`](#standard-error-envelope)                                                   |
| 401    | Authentication required or expired.                 | [`ApiError`](#standard-error-envelope)                                                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.      | [`ApiError`](#standard-error-envelope)                                                   |
| 404    | Resource not found or hidden by soft-delete policy. | [`ApiError`](#standard-error-envelope)                                                   |
| 500    | Internal server error without stack trace.          | [`ApiError`](#standard-error-envelope)                                                   |

### `PATCH /api/v1/blog/pages/{id}` — Update a blog page (any field). Author may edit their own not-yet-published page even without blog_content.pages.update

- **operationId**: `blogPagesUpdate`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): [`UpdateBlogPageRequest`](#schema-updateblogpagerequest)

**Responses**

| Status | Description                                                                                                                                                                                                                                                  | Schema                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 200    | Blog page updated.                                                                                                                                                                                                                                           | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogPageItem`](#schema-blogpageitem)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                                                                 | [`ApiError`](#standard-error-envelope)                                                   |
| 401    | Authentication required or expired.                                                                                                                                                                                                                          | [`ApiError`](#standard-error-envelope)                                                   |
| 403    | Access denied — the caller neither holds blog_content.pages.update nor is the page's author editing their own not-yet-published page.                                                                                                                        | [`ApiError`](#standard-error-envelope)                                                   |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                                                                          | [`ApiError`](#standard-error-envelope)                                                   |
| 409    | A page already exists for this slug in this locale.                                                                                                                                                                                                          | [`ApiError`](#standard-error-envelope)                                                   |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`.                                             | [`ApiError`](#standard-error-envelope)                                                   |
| 422    | NEWS_MEDIA_REFERENCE_INVALID (Issue #636) — full-online R2-only news portal mode is active for this tenant and a submitted featuredMediaId or contentJson image gallery item does not reference an existing, same-tenant, verified/attached R2 media object. | [`ApiError`](#standard-error-envelope)                                                   |
| 500    | Internal server error without stack trace.                                                                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                   |

### `DELETE /api/v1/blog/pages/{id}` — Soft-delete a blog page

- **operationId**: `blogPagesDelete`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): object

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 200    | Blog page deleted.                                                                                                                                                                                               | [`ApiSuccess`](#standard-success-envelope)&lt;object&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                   |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                   |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                   |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                   |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                   |

## Blog Taxonomies

Tenant-scoped category/tag admin API (epic #536, Issue #539). Categories support parent-child hierarchy; tags must not have a parent. No restore/purge — soft-delete only.

### `GET /api/v1/blog/terms` — List this tenant's non-deleted categories/tags

- **operationId**: `blogTermsList`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type                    | Description                                 |
| ------------------ | ------ | -------- | ----------------------- | ------------------------------------------- |
| `taxonomyType`     | query  | no       | enum(`category`, `tag`) |                                             |
| `X-Correlation-ID` | header | no       | string                  | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string                  | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                | Schema                                                                                                   |
| ------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 200    | Terms for the caller's tenant (limit 100, name ascending). | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogTermListResponse`](#schema-blogtermlistresponse)&gt; |
| 400    | Validation or request error.                               | [`ApiError`](#standard-error-envelope)                                                                   |
| 401    | Authentication required or expired.                        | [`ApiError`](#standard-error-envelope)                                                                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.             | [`ApiError`](#standard-error-envelope)                                                                   |
| 500    | Internal server error without stack trace.                 | [`ApiError`](#standard-error-envelope)                                                                   |

### `POST /api/v1/blog/terms` — Create a category or tag

- **operationId**: `blogTermsCreate`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): [`CreateBlogTermRequest`](#schema-createblogtermrequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 200    | Term created.                                                                                                                                                                                                    | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogTermItem`](#schema-blogtermitem)&gt; |
| 400    | Validation error, including a tag with a non-null parentId.                                                                                                                                                      | [`ApiError`](#standard-error-envelope)                                                   |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                   |
| 409    | A term already exists for this slug in this taxonomy type.                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                   |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                   |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                   |

### `PATCH /api/v1/blog/terms/{id}` — Update a category or tag

- **operationId**: `blogTermsUpdate`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): [`UpdateBlogTermRequest`](#schema-updateblogtermrequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 200    | Term updated.                                                                                                                                                                                                    | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogTermItem`](#schema-blogtermitem)&gt; |
| 400    | Validation error, including a tag with a non-null parentId.                                                                                                                                                      | [`ApiError`](#standard-error-envelope)                                                   |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                   |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                   |
| 409    | A term already exists for this slug in this taxonomy type.                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                   |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                   |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                   |

### `DELETE /api/v1/blog/terms/{id}` — Soft-delete a category or tag

- **operationId**: `blogTermsDelete`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): object

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 200    | Term deleted.                                                                                                                                                                                                    | [`ApiSuccess`](#standard-success-envelope)&lt;object&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                   |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                   |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                   |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                   |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                   |

## Blog Search

Tenant-scoped PostgreSQL full-text admin search across posts and pages (epic #536, Issue #539), keyset-paginated. May return content of any status per the caller's `blog_content.search.read` grant. The public-safe search predicate (published + public content only) is a backend helper only in this issue — no public route yet (Issue #540).

### `GET /api/v1/blog/search` — Admin full-text search across blog posts and pages

- **operationId**: `blogSearch`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type                                                          | Description                                 |
| ------------------ | ------ | -------- | ------------------------------------------------------------- | ------------------------------------------- |
| `q`                | query  | yes      | string                                                        |                                             |
| `type`             | query  | no       | enum(`post`, `page`)                                          |                                             |
| `status`           | query  | no       | enum(`draft`, `review`, `scheduled`, `published`, `archived`) |                                             |
| `cursor`           | query  | no       | string                                                        |                                             |
| `limit`            | query  | no       | integer                                                       |                                             |
| `X-Correlation-ID` | header | no       | string                                                        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string                                                        | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                               | Schema                                                                                               |
| ------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 200    | Matching posts and pages, newest first, keyset-paginated. | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogSearchResponse`](#schema-blogsearchresponse)&gt; |
| 400    | Validation or request error.                              | [`ApiError`](#standard-error-envelope)                                                               |
| 401    | Authentication required or expired.                       | [`ApiError`](#standard-error-envelope)                                                               |
| 403    | Access denied by RBAC, ABAC, or tenant policy.            | [`ApiError`](#standard-error-envelope)                                                               |
| 500    | Internal server error without stack trace.                | [`ApiError`](#standard-error-envelope)                                                               |

## Blog Revisions

Append-only revision history for blog posts (epic #536, Issue #541). List/read revisions, restore a revision (never overwrites history — restoring appends a new revision with the restored content). `awcms_mini_blog_revisions` also stores page revisions, but only post revision routes are exposed in this issue.

### `GET /api/v1/blog/posts/{id}/revisions` — List a blog post's revision history

- **operationId**: `blogPostRevisionsList`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `limit`            | query  | no       | integer       |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                         | Schema                                                   |
| ------ | --------------------------------------------------- | -------------------------------------------------------- |
| 200    | Revisions, newest first.                            | [`ApiSuccess`](#standard-success-envelope)&lt;object&gt; |
| 400    | Validation or request error.                        | [`ApiError`](#standard-error-envelope)                   |
| 401    | Authentication required or expired.                 | [`ApiError`](#standard-error-envelope)                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.      | [`ApiError`](#standard-error-envelope)                   |
| 404    | Resource not found or hidden by soft-delete policy. | [`ApiError`](#standard-error-envelope)                   |
| 500    | Internal server error without stack trace.          | [`ApiError`](#standard-error-envelope)                   |

### `GET /api/v1/blog/posts/{id}/revisions/{revisionId}` — Read one revision's full content snapshot

- **operationId**: `blogPostRevisionsGet`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `revisionId`       | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                          | Schema                                                                                           |
| ------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 200    | Revision detail.                                     | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogRevisionItem`](#schema-blogrevisionitem)&gt; |
| 400    | Validation or request error.                         | [`ApiError`](#standard-error-envelope)                                                           |
| 401    | Authentication required or expired.                  | [`ApiError`](#standard-error-envelope)                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy.       | [`ApiError`](#standard-error-envelope)                                                           |
| 404    | Post not found, or revision not found for this post. | [`ApiError`](#standard-error-envelope)                                                           |
| 500    | Internal server error without stack trace.           | [`ApiError`](#standard-error-envelope)                                                           |

### `POST /api/v1/blog/posts/{id}/revisions/{revisionId}/restore` — Restore a revision onto the live post (appends a new revision)

- **operationId**: `blogPostRevisionsRestore`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `revisionId`       | path   | yes      | string (uuid) |                                             |
| `Idempotency-Key`  | header | yes      | string        | Required for high-risk mutations.           |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                                                                                                                                                                                                                                                                 | Schema                                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 200    | Post updated with the revision's content; a new revision was appended recording the restore.                                                                                                                                                                                                                | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogPostItem`](#schema-blogpostitem)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                                                                                                                | [`ApiError`](#standard-error-envelope)                                                   |
| 401    | Authentication required or expired.                                                                                                                                                                                                                                                                         | [`ApiError`](#standard-error-envelope)                                                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                   |
| 404    | Post not found, or revision not found for this post.                                                                                                                                                                                                                                                        | [`ApiError`](#standard-error-envelope)                                                   |
| 409    | Idempotency-Key reused with a different request.                                                                                                                                                                                                                                                            | [`ApiError`](#standard-error-envelope)                                                   |
| 422    | NEWS_MEDIA_REFERENCE_INVALID (Issue #636) — full-online R2-only news portal mode is active for this tenant and the revision's contentJson references image(s) that are not valid R2 media objects (e.g. a raw URL from before the mode was activated) — the revision cannot be restored onto the live post. | [`ApiError`](#standard-error-envelope)                                                   |
| 500    | Internal server error without stack trace.                                                                                                                                                                                                                                                                  | [`ApiError`](#standard-error-envelope)                                                   |

## Blog Presentation

Tenant-scoped presentation/monetization admin API (epic #536, Issue #542): templates (whitelisted layout config), hierarchical navigation menus, position-based widgets, and advertisements (placement targeting + scheduling), plus a per-tenant blog theme mode override. Per doc issue #542's own Scope Control, none of this rebuilds the base media library, tenant system, RBAC/ABAC, audit, or theme engine — the blog theme endpoint overrides `awcms_mini_tenants.default_theme`, it does not replace it.

### `GET /api/v1/blog/ads` — List this tenant's advertisements

- **operationId**: `blogAdsList`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                    | Schema                                                   |
| ------ | ---------------------------------------------- | -------------------------------------------------------- |
| 200    | Ads.                                           | [`ApiSuccess`](#standard-success-envelope)&lt;object&gt; |
| 400    | Validation or request error.                   | [`ApiError`](#standard-error-envelope)                   |
| 401    | Authentication required or expired.            | [`ApiError`](#standard-error-envelope)                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy. | [`ApiError`](#standard-error-envelope)                   |
| 500    | Internal server error without stack trace.     | [`ApiError`](#standard-error-envelope)                   |

### `POST /api/v1/blog/ads` — Create an advertisement, optionally with its initial placements

- **operationId**: `blogAdsCreate`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): object

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 200    | Ad created.                                                                                                                                                                                                      | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogAdItem`](#schema-blogaditem)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                               |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                               |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                               |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                               |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                               |

### `PATCH /api/v1/blog/ads/{id}` — Update an advertisement and/or fully replace its placements

- **operationId**: `blogAdsUpdate`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): object

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 200    | Ad updated.                                                                                                                                                                                                      | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogAdItem`](#schema-blogaditem)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                               |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                               |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                               |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                               |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                               |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                               |

### `DELETE /api/v1/blog/ads/{id}` — Soft-delete an advertisement

- **operationId**: `blogAdsDelete`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): object

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 200    | Ad deleted.                                                                                                                                                                                                      | [`ApiSuccess`](#standard-success-envelope)&lt;object&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                   |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                   |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                   |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                   |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                   |

### `GET /api/v1/blog/menus` — List this tenant's navigation menus (with items)

- **operationId**: `blogMenusList`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                    | Schema                                                   |
| ------ | ---------------------------------------------- | -------------------------------------------------------- |
| 200    | Menus, each with its item tree.                | [`ApiSuccess`](#standard-success-envelope)&lt;object&gt; |
| 400    | Validation or request error.                   | [`ApiError`](#standard-error-envelope)                   |
| 401    | Authentication required or expired.            | [`ApiError`](#standard-error-envelope)                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy. | [`ApiError`](#standard-error-envelope)                   |
| 500    | Internal server error without stack trace.     | [`ApiError`](#standard-error-envelope)                   |

### `POST /api/v1/blog/menus` — Create a navigation menu, optionally with its initial item tree

- **operationId**: `blogMenusCreate`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): object

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 200    | Menu created.                                                                                                                                                                                                    | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogMenuItem`](#schema-blogmenuitem)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                   |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                   |
| 409    | A menu already exists for this key.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                   |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                   |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                   |

### `PATCH /api/v1/blog/menus/{id}` — Update a menu and/or fully replace its item tree

- **operationId**: `blogMenusUpdate`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): object

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 200    | Menu updated.                                                                                                                                                                                                    | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogMenuItem`](#schema-blogmenuitem)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                   |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                   |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                   |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                   |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                   |

### `DELETE /api/v1/blog/menus/{id}` — Soft-delete a navigation menu

- **operationId**: `blogMenusDelete`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): object

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 200    | Menu deleted.                                                                                                                                                                                                    | [`ApiSuccess`](#standard-success-envelope)&lt;object&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                   |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                   |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                   |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                   |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                   |

### `GET /api/v1/blog/templates` — List this tenant's presentation templates

- **operationId**: `blogTemplatesList`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                    | Schema                                                   |
| ------ | ---------------------------------------------- | -------------------------------------------------------- |
| 200    | Templates.                                     | [`ApiSuccess`](#standard-success-envelope)&lt;object&gt; |
| 400    | Validation or request error.                   | [`ApiError`](#standard-error-envelope)                   |
| 401    | Authentication required or expired.            | [`ApiError`](#standard-error-envelope)                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy. | [`ApiError`](#standard-error-envelope)                   |
| 500    | Internal server error without stack trace.     | [`ApiError`](#standard-error-envelope)                   |

### `POST /api/v1/blog/templates` — Create a presentation template

- **operationId**: `blogTemplatesCreate`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): object

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                           |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 200    | Template created.                                                                                                                                                                                                | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogTemplateItem`](#schema-blogtemplateitem)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                           |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                           |
| 409    | A template already exists for this key.                                                                                                                                                                          | [`ApiError`](#standard-error-envelope)                                                           |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                           |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                           |

### `PATCH /api/v1/blog/templates/{id}` — Update a presentation template

- **operationId**: `blogTemplatesUpdate`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): object

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                           |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 200    | Template updated.                                                                                                                                                                                                | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogTemplateItem`](#schema-blogtemplateitem)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                           |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                           |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                           |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                           |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                           |

### `DELETE /api/v1/blog/templates/{id}` — Soft-delete a presentation template

- **operationId**: `blogTemplatesDelete`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): object

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 200    | Template deleted.                                                                                                                                                                                                | [`ApiSuccess`](#standard-success-envelope)&lt;object&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                   |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                   |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                   |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                   |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                   |

### `GET /api/v1/blog/theme` — Read this tenant's blog theme mode

- **operationId**: `blogThemeGet`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                    | Schema                                                                                             |
| ------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 200    | Theme settings.                                | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogThemeSettings`](#schema-blogthemesettings)&gt; |
| 400    | Validation or request error.                   | [`ApiError`](#standard-error-envelope)                                                             |
| 401    | Authentication required or expired.            | [`ApiError`](#standard-error-envelope)                                                             |
| 403    | Access denied by RBAC, ABAC, or tenant policy. | [`ApiError`](#standard-error-envelope)                                                             |
| 500    | Internal server error without stack trace.     | [`ApiError`](#standard-error-envelope)                                                             |

### `PATCH /api/v1/blog/theme` — Set this tenant's blog theme mode override

- **operationId**: `blogThemeUpdate`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): object

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                             |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 200    | Theme settings updated.                                                                                                                                                                                          | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogThemeSettings`](#schema-blogthemesettings)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                             |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                             |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                             |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                             |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                             |

### `GET /api/v1/blog/widgets` — List this tenant's widgets

- **operationId**: `blogWidgetsList`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type                                                                   | Description                                 |
| ------------------ | ------ | -------- | ---------------------------------------------------------------------- | ------------------------------------------- |
| `position`         | query  | no       | enum(`header`, `sidebar`, `footer`, `content_before`, `content_after`) |                                             |
| `X-Correlation-ID` | header | no       | string                                                                 | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string                                                                 | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                    | Schema                                                   |
| ------ | ---------------------------------------------- | -------------------------------------------------------- |
| 200    | Widgets.                                       | [`ApiSuccess`](#standard-success-envelope)&lt;object&gt; |
| 400    | Validation or request error.                   | [`ApiError`](#standard-error-envelope)                   |
| 401    | Authentication required or expired.            | [`ApiError`](#standard-error-envelope)                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy. | [`ApiError`](#standard-error-envelope)                   |
| 500    | Internal server error without stack trace.     | [`ApiError`](#standard-error-envelope)                   |

### `POST /api/v1/blog/widgets` — Create a widget

- **operationId**: `blogWidgetsCreate`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): object

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                       |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 200    | Widget created.                                                                                                                                                                                                  | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogWidgetItem`](#schema-blogwidgetitem)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                       |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                       |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                       |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                       |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                       |

### `PATCH /api/v1/blog/widgets/{id}` — Update a widget

- **operationId**: `blogWidgetsUpdate`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): object

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                       |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 200    | Widget updated.                                                                                                                                                                                                  | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogWidgetItem`](#schema-blogwidgetitem)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                       |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                       |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                       |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                       |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                       |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                       |

### `DELETE /api/v1/blog/widgets/{id}` — Soft-delete a widget

- **operationId**: `blogWidgetsDelete`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): object

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 200    | Widget deleted.                                                                                                                                                                                                  | [`ApiSuccess`](#standard-success-envelope)&lt;object&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                   |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                   |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                   |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                   |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                   |

## Blog Settings

Tenant-scoped blog settings admin API (epic #536, Issue #543) — one row per tenant (`awcms_mini_blog_settings`, schema present since Issue #537 but unwired until this issue). Blog title/description and RSS/sitemap enabled flags live in the row's catch-all `settings` jsonb column; default locale/visibility and SEO title/description defaults have their own typed columns. `rssEnabled`/`sitemapEnabled` also gate `GET /blog/{tenantCode}/feed.xml` and `.../sitemap-blog.xml` (Issue #540) — disabled looks identical to an unknown tenant (404), no distinguishing signal leaked.

### `GET /api/v1/blog/settings` — Read this tenant's blog settings

- **operationId**: `blogSettingsGet`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                                  | Schema                                                                                           |
| ------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 200    | Blog settings, falling back to schema/domain defaults when never configured. | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogSettingsView`](#schema-blogsettingsview)&gt; |
| 400    | Validation or request error.                                                 | [`ApiError`](#standard-error-envelope)                                                           |
| 401    | Authentication required or expired.                                          | [`ApiError`](#standard-error-envelope)                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                               | [`ApiError`](#standard-error-envelope)                                                           |
| 500    | Internal server error without stack trace.                                   | [`ApiError`](#standard-error-envelope)                                                           |

### `PATCH /api/v1/blog/settings` — Update this tenant's blog settings

- **operationId**: `blogSettingsUpdate`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): [`UpdateBlogSettingsInput`](#schema-updateblogsettingsinput)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                           |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 200    | Blog settings updated (partial update — only fields present in the request body are changed).                                                                                                                    | [`ApiSuccess`](#standard-success-envelope)&lt;[`BlogSettingsView`](#schema-blogsettingsview)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                           |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                           |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                           |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                           |

## Visitor Analytics

Tenant-scoped visitor analytics API (epic: visitor analytics #617-#624, Issue #621) — realtime presence, range-bounded summary/ pages/devices/locations/security aggregates, keyset-paginated sessions/events, settings, and on-demand retention purge. Raw detail (IP address, user-agent hash, login identifier snapshot) on sessions/events is omitted unless the caller holds the separate `visitor_analytics.raw_detail.read` permission, independent of `sessions.read`/`events.read`.

### `GET /api/v1/analytics/devices` — Browser and device-type breakdown within a range

- **operationId**: `analyticsDevices`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type                            | Description                                                                                    |
| ------------------ | ------ | -------- | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `range`            | query  | no       | enum(`24h`, `7d`, `30d`, `12m`) | Aggregate window. An unrecognized value is a `400 VALIDATION_ERROR`, never silently defaulted. |
| `X-Correlation-ID` | header | no       | string                          | Optional server-side trace correlation ID.                                                     |
| `X-Request-ID`     | header | no       | string                          | Optional client-generated request trace ID.                                                    |

**Responses**

| Status | Description                                       | Schema                                                                                                           |
| ------ | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 200    | Browser/device breakdown for the requested range. | [`ApiSuccess`](#standard-success-envelope)&lt;[`AnalyticsDevicesResponse`](#schema-analyticsdevicesresponse)&gt; |
| 400    | Validation or request error.                      | [`ApiError`](#standard-error-envelope)                                                                           |
| 401    | Authentication required or expired.               | [`ApiError`](#standard-error-envelope)                                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy.    | [`ApiError`](#standard-error-envelope)                                                                           |
| 500    | Internal server error without stack trace.        | [`ApiError`](#standard-error-envelope)                                                                           |

### `GET /api/v1/analytics/events` — List page-view/API visit events (keyset-paginated, newest first)

- **operationId**: `analyticsEventsList`
- **Security**: bearerAuth + tenantHeader

Raw detail (`ipHash`, `userAgentHash`) is `null` unless the caller also holds `visitor_analytics.raw_detail.read`, independent of `events.read`.

**Parameters**

| Name               | In     | Required | Type   | Description                                                                                   |
| ------------------ | ------ | -------- | ------ | --------------------------------------------------------------------------------------------- |
| `cursor`           | query  | no       | string | Opaque keyset pagination cursor from a previous page's `nextCursor`. Omit for the first page. |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.                                                    |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID.                                                   |

**Responses**

| Status | Description                                    | Schema                                                                                                       |
| ------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 200    | Visit events (limit 50), newest first.         | [`ApiSuccess`](#standard-success-envelope)&lt;[`VisitEventListResponse`](#schema-visiteventlistresponse)&gt; |
| 400    | Validation or request error.                   | [`ApiError`](#standard-error-envelope)                                                                       |
| 401    | Authentication required or expired.            | [`ApiError`](#standard-error-envelope)                                                                       |
| 403    | Access denied by RBAC, ABAC, or tenant policy. | [`ApiError`](#standard-error-envelope)                                                                       |
| 500    | Internal server error without stack trace.     | [`ApiError`](#standard-error-envelope)                                                                       |

### `GET /api/v1/analytics/locations` — Country breakdown within a range

- **operationId**: `analyticsLocations`
- **Security**: bearerAuth + tenantHeader

Always empty until Issue #623 (geolocation enrichment) populates `visit_events.geo` — not an error, just no data yet.

**Parameters**

| Name               | In     | Required | Type                            | Description                                                                                    |
| ------------------ | ------ | -------- | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `range`            | query  | no       | enum(`24h`, `7d`, `30d`, `12m`) | Aggregate window. An unrecognized value is a `400 VALIDATION_ERROR`, never silently defaulted. |
| `X-Correlation-ID` | header | no       | string                          | Optional server-side trace correlation ID.                                                     |
| `X-Request-ID`     | header | no       | string                          | Optional client-generated request trace ID.                                                    |

**Responses**

| Status | Description                                    | Schema                                                                                                               |
| ------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 200    | Country breakdown for the requested range.     | [`ApiSuccess`](#standard-success-envelope)&lt;[`AnalyticsLocationsResponse`](#schema-analyticslocationsresponse)&gt; |
| 400    | Validation or request error.                   | [`ApiError`](#standard-error-envelope)                                                                               |
| 401    | Authentication required or expired.            | [`ApiError`](#standard-error-envelope)                                                                               |
| 403    | Access denied by RBAC, ABAC, or tenant policy. | [`ApiError`](#standard-error-envelope)                                                                               |
| 500    | Internal server error without stack trace.     | [`ApiError`](#standard-error-envelope)                                                                               |

### `GET /api/v1/analytics/pages` — Top pages by human pageviews within a range

- **operationId**: `analyticsPages`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type                            | Description                                                                                    |
| ------------------ | ------ | -------- | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `range`            | query  | no       | enum(`24h`, `7d`, `30d`, `12m`) | Aggregate window. An unrecognized value is a `400 VALIDATION_ERROR`, never silently defaulted. |
| `X-Correlation-ID` | header | no       | string                          | Optional server-side trace correlation ID.                                                     |
| `X-Request-ID`     | header | no       | string                          | Optional client-generated request trace ID.                                                    |

**Responses**

| Status | Description                                    | Schema                                                                                                       |
| ------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 200    | Top pages for the requested range.             | [`ApiSuccess`](#standard-success-envelope)&lt;[`AnalyticsPagesResponse`](#schema-analyticspagesresponse)&gt; |
| 400    | Validation or request error.                   | [`ApiError`](#standard-error-envelope)                                                                       |
| 401    | Authentication required or expired.            | [`ApiError`](#standard-error-envelope)                                                                       |
| 403    | Access denied by RBAC, ABAC, or tenant policy. | [`ApiError`](#standard-error-envelope)                                                                       |
| 500    | Internal server error without stack trace.     | [`ApiError`](#standard-error-envelope)                                                                       |

### `GET /api/v1/analytics/realtime` — Online-now presence counts

- **operationId**: `analyticsRealtime`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                          | Schema                                                                                                       |
| ------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 200    | Presence counts within the configured online window. | [`ApiSuccess`](#standard-success-envelope)&lt;[`AnalyticsRealtimeStats`](#schema-analyticsrealtimestats)&gt; |
| 401    | Authentication required or expired.                  | [`ApiError`](#standard-error-envelope)                                                                       |
| 403    | Access denied by RBAC, ABAC, or tenant policy.       | [`ApiError`](#standard-error-envelope)                                                                       |
| 500    | Internal server error without stack trace.           | [`ApiError`](#standard-error-envelope)                                                                       |

### `POST /api/v1/analytics/retention/purge` — Purge visitor analytics data past its configured retention window

- **operationId**: `analyticsRetentionPurge`
- **Security**: bearerAuth + tenantHeader

Destructive, high-risk mutation — requires `Idempotency-Key` and is recorded as a `critical` audit event. Uses Issue #617's `VISITOR_ANALYTICS_EVENT_RETENTION_DAYS`/`_RAW_DETAIL_RETENTION_DAYS`/ `_ROLLUP_RETENTION_DAYS` config as the cutoffs — no request body.

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `Idempotency-Key`  | header | yes      | string | Required for high-risk mutations.           |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                                            | Schema                                                                                                                     |
| ------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 200    | Purge result (also returned unchanged on an idempotent replay).                        | [`ApiSuccess`](#standard-success-envelope)&lt;[`AnalyticsRetentionPurgeResult`](#schema-analyticsretentionpurgeresult)&gt; |
| 400    | Validation or request error.                                                           | [`ApiError`](#standard-error-envelope)                                                                                     |
| 401    | Authentication required or expired.                                                    | [`ApiError`](#standard-error-envelope)                                                                                     |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                         | [`ApiError`](#standard-error-envelope)                                                                                     |
| 409    | IDEMPOTENCY_CONFLICT — this Idempotency-Key was already used with a different request. | [`ApiError`](#standard-error-envelope)                                                                                     |
| 500    | Internal server error without stack trace.                                             | [`ApiError`](#standard-error-envelope)                                                                                     |

### `GET /api/v1/analytics/security` — Bot/crawler traffic breakdown within a range

- **operationId**: `analyticsSecurity`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type                            | Description                                                                                    |
| ------------------ | ------ | -------- | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `range`            | query  | no       | enum(`24h`, `7d`, `30d`, `12m`) | Aggregate window. An unrecognized value is a `400 VALIDATION_ERROR`, never silently defaulted. |
| `X-Correlation-ID` | header | no       | string                          | Optional server-side trace correlation ID.                                                     |
| `X-Request-ID`     | header | no       | string                          | Optional client-generated request trace ID.                                                    |

**Responses**

| Status | Description                                    | Schema                                                                                                     |
| ------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 200    | Bot traffic breakdown for the requested range. | [`ApiSuccess`](#standard-success-envelope)&lt;[`AnalyticsSecurityView`](#schema-analyticssecurityview)&gt; |
| 400    | Validation or request error.                   | [`ApiError`](#standard-error-envelope)                                                                     |
| 401    | Authentication required or expired.            | [`ApiError`](#standard-error-envelope)                                                                     |
| 403    | Access denied by RBAC, ABAC, or tenant policy. | [`ApiError`](#standard-error-envelope)                                                                     |
| 500    | Internal server error without stack trace.     | [`ApiError`](#standard-error-envelope)                                                                     |

### `GET /api/v1/analytics/sessions` — List visitor sessions (keyset-paginated, most recently active first)

- **operationId**: `analyticsSessionsList`
- **Security**: bearerAuth + tenantHeader

Raw detail (`ipHash`, `ipAddress`, `userAgentHash`, `loginIdentifierSnapshot`) is `null` unless the caller also holds `visitor_analytics.raw_detail.read`, independent of `sessions.read`.

**Parameters**

| Name               | In     | Required | Type   | Description                                                                                   |
| ------------------ | ------ | -------- | ------ | --------------------------------------------------------------------------------------------- |
| `cursor`           | query  | no       | string | Opaque keyset pagination cursor from a previous page's `nextCursor`. Omit for the first page. |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.                                                    |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID.                                                   |

**Responses**

| Status | Description                                              | Schema                                                                                                               |
| ------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 200    | Visitor sessions (limit 50), most recently active first. | [`ApiSuccess`](#standard-success-envelope)&lt;[`VisitorSessionListResponse`](#schema-visitorsessionlistresponse)&gt; |
| 400    | Validation or request error.                             | [`ApiError`](#standard-error-envelope)                                                                               |
| 401    | Authentication required or expired.                      | [`ApiError`](#standard-error-envelope)                                                                               |
| 403    | Access denied by RBAC, ABAC, or tenant policy.           | [`ApiError`](#standard-error-envelope)                                                                               |
| 500    | Internal server error without stack trace.               | [`ApiError`](#standard-error-envelope)                                                                               |

### `GET /api/v1/analytics/settings` — Read effective visitor analytics module settings for this tenant

- **operationId**: `analyticsSettingsGet`
- **Security**: bearerAuth + tenantHeader

Thin wrapper around Module Management's generic per-tenant settings storage (Issue #516), gated by `visitor_analytics.settings.read` instead of the generic endpoint's `module_management.settings.read`.

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                       | Schema                                                                                               |
| ------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 200    | Effective settings (defaults merged with this tenant's override). | [`ApiSuccess`](#standard-success-envelope)&lt;[`ModuleSettingsView`](#schema-modulesettingsview)&gt; |
| 401    | Authentication required or expired.                               | [`ApiError`](#standard-error-envelope)                                                               |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                    | [`ApiError`](#standard-error-envelope)                                                               |
| 404    | Resource not found or hidden by soft-delete policy.               | [`ApiError`](#standard-error-envelope)                                                               |
| 500    | Internal server error without stack trace.                        | [`ApiError`](#standard-error-envelope)                                                               |

### `PATCH /api/v1/analytics/settings` — Update visitor analytics module settings for this tenant

- **operationId**: `analyticsSettingsUpdate`
- **Security**: bearerAuth + tenantHeader

Shallow JSON-merge patch. Rejects any secret-shaped key or value anywhere in the body regardless of the field's own name (`400 SETTINGS_SENSITIVE_KEY_REJECTED` / `SETTINGS_SECRET_SHAPED_VALUE_REJECTED`) — real provider secrets belong in environment variables, never tenant settings. Audited.

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): object

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 200    | Settings updated.                                                                                                                                                                                                | [`ApiSuccess`](#standard-success-envelope)&lt;[`ModuleSettingsView`](#schema-modulesettingsview)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                               |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                               |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                               |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                               |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                               |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                               |

### `GET /api/v1/analytics/summary` — Range-bounded visitor/pageview summary with top paths/browsers/devices/countries

- **operationId**: `analyticsSummary`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type                            | Description                                                                                    |
| ------------------ | ------ | -------- | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `range`            | query  | no       | enum(`24h`, `7d`, `30d`, `12m`) | Aggregate window. An unrecognized value is a `400 VALIDATION_ERROR`, never silently defaulted. |
| `X-Correlation-ID` | header | no       | string                          | Optional server-side trace correlation ID.                                                     |
| `X-Request-ID`     | header | no       | string                          | Optional client-generated request trace ID.                                                    |

**Responses**

| Status | Description                                    | Schema                                                                                           |
| ------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 200    | Summary for the requested range.               | [`ApiSuccess`](#standard-success-envelope)&lt;[`AnalyticsSummary`](#schema-analyticssummary)&gt; |
| 400    | Validation or request error.                   | [`ApiError`](#standard-error-envelope)                                                           |
| 401    | Authentication required or expired.            | [`ApiError`](#standard-error-envelope)                                                           |
| 403    | Access denied by RBAC, ABAC, or tenant policy. | [`ApiError`](#standard-error-envelope)                                                           |
| 500    | Internal server error without stack trace.     | [`ApiError`](#standard-error-envelope)                                                           |

## News Media

Direct-to-R2 presigned upload flow for news images (epic `news_portal` #631-#642/#649, Issue #634) — create an upload session (server-generated object key + short-lived presigned `PUT` URL), finalize (real R2 `GET` + magic-byte MIME sniffing + server-side SHA-256 checksum — never a bare `HEAD`, per the security-auditor Critical finding on Issue #631), and cancel a still-`pending_upload` session. R2 credentials are never exposed to the browser; only a scoped, expiring presigned URL is returned.

### `POST /api/v1/media/news-images/upload-sessions` — Create a direct-to-R2 presigned upload session for a news image

- **operationId**: `newsMediaUploadSessionsCreate`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): [`CreateNewsMediaUploadSessionRequest`](#schema-createnewsmediauploadsessionrequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 200    | Upload session created — a `pending_upload` metadata row plus a short-lived presigned PUT URL scoped to exactly one server-generated object key. Never includes raw R2 credentials.                              | [`ApiSuccess`](#standard-success-envelope)&lt;[`NewsMediaUploadSessionCreated`](#schema-newsmediauploadsessioncreated)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                                                     |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                                                     |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                                                     |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                                                     |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                                                     |
| 502    | News media R2 storage is not configured/enabled for this deployment.                                                                                                                                             | [`ApiError`](#standard-error-envelope)                                                                                     |

### `POST /api/v1/media/news-images/upload-sessions/{id}/cancel` — Cancel a still-pending-upload session

- **operationId**: `newsMediaUploadSessionsCancel`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                                                         | Schema                                                                                                 |
| ------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 200    | Upload session cancelled (status `failed`).                                         | [`ApiSuccess`](#standard-success-envelope)&lt;[`NewsMediaObjectItem`](#schema-newsmediaobjectitem)&gt; |
| 400    | Validation or request error.                                                        | [`ApiError`](#standard-error-envelope)                                                                 |
| 401    | Authentication required or expired.                                                 | [`ApiError`](#standard-error-envelope)                                                                 |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                      | [`ApiError`](#standard-error-envelope)                                                                 |
| 404    | Resource not found or hidden by soft-delete policy.                                 | [`ApiError`](#standard-error-envelope)                                                                 |
| 409    | Upload session is not `pending_upload` (already uploaded/verified/attached/failed). | [`ApiError`](#standard-error-envelope)                                                                 |
| 500    | Internal server error without stack trace.                                          | [`ApiError`](#standard-error-envelope)                                                                 |

### `POST /api/v1/media/news-images/upload-sessions/{id}/finalize` — Finalize an upload session — real R2 GET + magic-byte MIME sniffing + server-side SHA-256 checksum (never a bare HEAD)

- **operationId**: `newsMediaUploadSessionsFinalize`
- **Security**: bearerAuth + tenantHeader

Verifies the object actually uploaded to R2 by performing a HEAD (existence + real size) followed by a FULL GET, sniffing the MIME type from the object's actual magic bytes, and computing a SHA-256 checksum server-side from the bytes read. A client-claimed `checksumSha256` (if supplied) is compared only as a transport- corruption check — it is never a substitute for the MIME sniff. This closes the security-auditor Critical finding on Issue #631: `HEAD` alone can never promote a media object to `verified`.

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `Idempotency-Key`  | header | yes      | string        | Required for high-risk mutations.           |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (optional): [`FinalizeNewsMediaUploadSessionRequest`](#schema-finalizenewsmediauploadsessionrequest)

**Responses**

| Status | Description                                                                                                                                                                                                                                                                                                                                                          | Schema                                                                                                 |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 200    | Object verified — media object status is now `verified`.                                                                                                                                                                                                                                                                                                             | [`ApiSuccess`](#standard-success-envelope)&lt;[`NewsMediaObjectItem`](#schema-newsmediaobjectitem)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                                                                                                                                                                         | [`ApiError`](#standard-error-envelope)                                                                 |
| 401    | Authentication required or expired.                                                                                                                                                                                                                                                                                                                                  | [`ApiError`](#standard-error-envelope)                                                                 |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                                 |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                                                                                                                                                                                  | [`ApiError`](#standard-error-envelope)                                                                 |
| 409    | Upload session is not `pending_upload`, has expired (`UPLOAD_SESSION_EXPIRED`), or the Idempotency-Key was reused with a different request (`IDEMPOTENCY_CONFLICT`).                                                                                                                                                                                                 | [`ApiError`](#standard-error-envelope)                                                                 |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`.                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                                 |
| 422    | Uploaded object failed content verification (`UPLOAD_VERIFICATION_FAILED`) — MIME sniff did not match the allow-list/claimed mime type, checksum mismatch, size exceeded, or the object does not exist in R2. `error.details.reason` is one of `object_not_found`, `size_exceeded`, `mime_not_recognized`, `mime_not_allowed`, `mime_mismatch`, `checksum_mismatch`. | [`ApiError`](#standard-error-envelope)                                                                 |
| 500    | Internal server error without stack trace.                                                                                                                                                                                                                                                                                                                           | [`ApiError`](#standard-error-envelope)                                                                 |
| 502    | Unable to verify the uploaded object right now (R2 provider error/circuit breaker open) — retry shortly.                                                                                                                                                                                                                                                             | [`ApiError`](#standard-error-envelope)                                                                 |

## News Portal Homepage Sections

Editorial homepage section composer for `/news` (epic `news_portal` #631-#642/#649, Issue #637) — tenant-scoped, RLS-protected CRUD for configurable homepage sections (headline, latest_posts, featured_posts, editor_picks, category_grid, gallery_block). `config` shape is validated per `sectionType` server-side; every post/category/media reference in `config` must already exist for the same tenant, and (for `gallery_block`) be a verified R2 media object. `sectionType` is immutable after creation. Reordering is just another patchable field (`sortOrder`) — there is no separate bulk-reorder endpoint.

### `GET /api/v1/news-portal/homepage-sections` — List this tenant's homepage sections (admin view)

- **operationId**: `newsPortalHomepageSectionsList`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Responses**

| Status | Description                                    | Schema                                                   |
| ------ | ---------------------------------------------- | -------------------------------------------------------- |
| 200    | Homepage sections.                             | [`ApiSuccess`](#standard-success-envelope)&lt;object&gt; |
| 400    | Validation or request error.                   | [`ApiError`](#standard-error-envelope)                   |
| 401    | Authentication required or expired.            | [`ApiError`](#standard-error-envelope)                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy. | [`ApiError`](#standard-error-envelope)                   |
| 500    | Internal server error without stack trace.     | [`ApiError`](#standard-error-envelope)                   |

### `POST /api/v1/news-portal/homepage-sections` — Create a homepage section

- **operationId**: `newsPortalHomepageSectionsCreate`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type   | Description                                 |
| ------------------ | ------ | -------- | ------ | ------------------------------------------- |
| `X-Correlation-ID` | header | no       | string | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string | Optional client-generated request trace ID. |

**Request body** (required): [`HomepageSectionCreateRequest`](#schema-homepagesectioncreaterequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 200    | Homepage section created.                                                                                                                                                                                        | [`ApiSuccess`](#standard-success-envelope)&lt;[`HomepageSectionItem`](#schema-homepagesectionitem)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                                 |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                                 |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                                 |
| 409    | sectionKey is already in use for this tenant.                                                                                                                                                                    | [`ApiError`](#standard-error-envelope)                                                                 |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                                 |
| 422    | config references content that does not exist, does not belong to this tenant, or (for gallery_block) is not a verified R2 media object.                                                                         | [`ApiError`](#standard-error-envelope)                                                                 |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                                 |

### `PATCH /api/v1/news-portal/homepage-sections/{id}` — Update a homepage section (title/config/sortOrder/isEnabled/schedule) — sectionType is immutable

- **operationId**: `newsPortalHomepageSectionsUpdate`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): [`HomepageSectionUpdateRequest`](#schema-homepagesectionupdaterequest)

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 200    | Homepage section updated.                                                                                                                                                                                        | [`ApiSuccess`](#standard-success-envelope)&lt;[`HomepageSectionItem`](#schema-homepagesectionitem)&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                                                                 |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                                 |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                                                                 |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                                                                 |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                                                                 |
| 422    | config references content that does not exist, does not belong to this tenant, or (for gallery_block) is not a verified R2 media object.                                                                         | [`ApiError`](#standard-error-envelope)                                                                 |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                                                                 |

### `DELETE /api/v1/news-portal/homepage-sections/{id}` — Soft-delete a homepage section

- **operationId**: `newsPortalHomepageSectionsDelete`
- **Security**: bearerAuth + tenantHeader

**Parameters**

| Name               | In     | Required | Type          | Description                                 |
| ------------------ | ------ | -------- | ------------- | ------------------------------------------- |
| `id`               | path   | yes      | string (uuid) |                                             |
| `X-Correlation-ID` | header | no       | string        | Optional server-side trace correlation ID.  |
| `X-Request-ID`     | header | no       | string        | Optional client-generated request trace ID. |

**Request body** (required): object

**Responses**

| Status | Description                                                                                                                                                                                                      | Schema                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 200    | Homepage section deleted.                                                                                                                                                                                        | [`ApiSuccess`](#standard-success-envelope)&lt;object&gt; |
| 400    | Validation or request error.                                                                                                                                                                                     | [`ApiError`](#standard-error-envelope)                   |
| 401    | Authentication required or expired.                                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                   |
| 403    | Access denied by RBAC, ABAC, or tenant policy.                                                                                                                                                                   | [`ApiError`](#standard-error-envelope)                   |
| 404    | Resource not found or hidden by soft-delete policy.                                                                                                                                                              | [`ApiError`](#standard-error-envelope)                   |
| 413    | Request body exceeds the endpoint's size limit (Issue #686, epic #679) — either its declared `Content-Length` or, for a chunked/ unlabeled body, the actual streamed byte count. Error code `PAYLOAD_TOO_LARGE`. | [`ApiError`](#standard-error-envelope)                   |
| 500    | Internal server error without stack trace.                                                                                                                                                                       | [`ApiError`](#standard-error-envelope)                   |

## Schema appendix

Every schema referenced by at least one operation above (excluding the standard envelope schemas, covered in §Standard success/error envelope).

### Schema: AccessAssignmentRequest

| Field          | Type          | Required | Nullable | Description |
| -------------- | ------------- | -------- | -------- | ----------- |
| `tenantUserId` | string (uuid) | yes      | no       |             |
| `roleId`       | string (uuid) | yes      | no       |             |

**Example**

```json
{
  "tenantUserId": "00000000-0000-0000-0000-000000000000",
  "roleId": "00000000-0000-0000-0000-000000000000"
}
```

### Schema: AccessAssignmentResponse

| Field          | Type          | Required | Nullable | Description |
| -------------- | ------------- | -------- | -------- | ----------- |
| `assignmentId` | string (uuid) | yes      | no       |             |

**Example**

```json
{
  "assignmentId": "00000000-0000-0000-0000-000000000000"
}
```

### Schema: AccessAuditReport

| Field                  | Type    | Required | Nullable | Description                                                             |
| ---------------------- | ------- | -------- | -------- | ----------------------------------------------------------------------- |
| `decisionWindowDays`   | integer | yes      | no       | Window (in days) covered by allowCount/denyCount.                       |
| `allowCount`           | integer | yes      | no       |                                                                         |
| `denyCount`            | integer | yes      | no       |                                                                         |
| `totalDecisionCount`   | integer | yes      | no       | All-time ABAC decision log count (not windowed).                        |
| `profileAuditLogCount` | integer | yes      | no       | All-time profile audit log entry count, a generic audit-activity proxy. |

**Example**

```json
{
  "decisionWindowDays": 1,
  "allowCount": 0,
  "denyCount": 0,
  "totalDecisionCount": 0,
  "profileAuditLogCount": 0
}
```

### Schema: AccessEvaluateRequest

| Field                   | Type                                                                                                                        | Required | Nullable | Description |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------- | -------- | ----------- |
| `moduleKey`             | string                                                                                                                      | yes      | no       |             |
| `activityCode`          | string                                                                                                                      | yes      | no       |             |
| `action`                | enum(`read`, `create`, `update`, `delete`, `post`, `cancel`, `approve`, `export`, `send`, `configure`, `analyze`, `assign`) | yes      | no       |             |
| `resourceType`          | string                                                                                                                      | no       | no       |             |
| `resourceId`            | string                                                                                                                      | no       | no       |             |
| `resourceAttributes`    | object                                                                                                                      | no       | no       |             |
| `environmentAttributes` | object                                                                                                                      | no       | no       |             |

**Example**

```json
{
  "moduleKey": "string",
  "activityCode": "string",
  "action": "read",
  "resourceType": "string",
  "resourceId": "string",
  "resourceAttributes": "(operation-specific payload)",
  "environmentAttributes": "(operation-specific payload)"
}
```

### Schema: AccessEvaluateResponse

| Field           | Type    | Required | Nullable | Description |
| --------------- | ------- | -------- | -------- | ----------- |
| `allowed`       | boolean | yes      | no       |             |
| `reason`        | string  | yes      | no       |             |
| `matchedPolicy` | string  | no       | no       |             |

**Example**

```json
{
  "allowed": false,
  "reason": "string",
  "matchedPolicy": "string"
}
```

### Schema: AnalyticsDevicesResponse

| Field      | Type                                                          | Required | Nullable | Description |
| ---------- | ------------------------------------------------------------- | -------- | -------- | ----------- |
| `range`    | enum(`24h`, `7d`, `30d`, `12m`)                               | yes      | no       |             |
| `browsers` | array of [`AnalyticsNamedCount`](#schema-analyticsnamedcount) | yes      | no       |             |
| `devices`  | array of [`AnalyticsNamedCount`](#schema-analyticsnamedcount) | yes      | no       |             |

**Example**

```json
{
  "range": "24h",
  "browsers": [
    {
      "name": "string",
      "count": 0
    }
  ],
  "devices": [
    {
      "name": "string",
      "count": 0
    }
  ]
}
```

### Schema: AnalyticsLocationsResponse

| Field       | Type                                                          | Required | Nullable | Description |
| ----------- | ------------------------------------------------------------- | -------- | -------- | ----------- |
| `range`     | enum(`24h`, `7d`, `30d`, `12m`)                               | yes      | no       |             |
| `countries` | array of [`AnalyticsNamedCount`](#schema-analyticsnamedcount) | yes      | no       |             |

**Example**

```json
{
  "range": "24h",
  "countries": [
    {
      "name": "string",
      "count": 0
    }
  ]
}
```

### Schema: AnalyticsNamedCount

| Field   | Type    | Required | Nullable | Description |
| ------- | ------- | -------- | -------- | ----------- |
| `name`  | string  | yes      | no       |             |
| `count` | integer | yes      | no       |             |

**Example**

```json
{
  "name": "string",
  "count": 0
}
```

### Schema: AnalyticsPagesResponse

| Field   | Type                                                          | Required | Nullable | Description |
| ------- | ------------------------------------------------------------- | -------- | -------- | ----------- |
| `range` | enum(`24h`, `7d`, `30d`, `12m`)                               | yes      | no       |             |
| `pages` | array of [`AnalyticsNamedCount`](#schema-analyticsnamedcount) | yes      | no       |             |

**Example**

```json
{
  "range": "24h",
  "pages": [
    {
      "name": "string",
      "count": 0
    }
  ]
}
```

### Schema: AnalyticsRealtimeStats

| Field                 | Type               | Required | Nullable | Description |
| --------------------- | ------------------ | -------- | -------- | ----------- |
| `onlineHumanCount`    | integer            | yes      | no       |             |
| `onlineAdminCount`    | integer            | yes      | no       |             |
| `onlinePublicCount`   | integer            | yes      | no       |             |
| `onlineApiCount`      | integer            | yes      | no       |             |
| `onlineWindowSeconds` | integer            | yes      | no       |             |
| `lastUpdatedAt`       | string (date-time) | yes      | no       |             |

**Example**

```json
{
  "onlineHumanCount": 0,
  "onlineAdminCount": 0,
  "onlinePublicCount": 0,
  "onlineApiCount": 0,
  "onlineWindowSeconds": 0,
  "lastUpdatedAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: AnalyticsRetentionPurgeResult

| Field                      | Type    | Required | Nullable | Description |
| -------------------------- | ------- | -------- | -------- | ----------- |
| `eventsDeleted`            | integer | yes      | no       |             |
| `sessionsRawDetailCleared` | integer | yes      | no       |             |
| `sessionsDeleted`          | integer | yes      | no       |             |
| `rollupsDeleted`           | integer | yes      | no       |             |

**Example**

```json
{
  "eventsDeleted": 0,
  "sessionsRawDetailCleared": 0,
  "sessionsDeleted": 0,
  "rollupsDeleted": 0
}
```

### Schema: AnalyticsSecurityView

| Field                | Type                                                          | Required | Nullable | Description |
| -------------------- | ------------------------------------------------------------- | -------- | -------- | ----------- |
| `range`              | enum(`24h`, `7d`, `30d`, `12m`)                               | yes      | no       |             |
| `botPageviews`       | integer                                                       | yes      | no       |             |
| `topBotReasons`      | array of [`AnalyticsNamedCount`](#schema-analyticsnamedcount) | yes      | no       |             |
| `botPageviewsByArea` | array of [`AnalyticsNamedCount`](#schema-analyticsnamedcount) | yes      | no       |             |

**Example**

```json
{
  "range": "24h",
  "botPageviews": 0,
  "topBotReasons": [
    {
      "name": "string",
      "count": 0
    }
  ],
  "botPageviewsByArea": [
    {
      "name": "string",
      "count": 0
    }
  ]
}
```

### Schema: AnalyticsSummary

| Field                  | Type                                                          | Required | Nullable | Description |
| ---------------------- | ------------------------------------------------------------- | -------- | -------- | ----------- |
| `range`                | enum(`24h`, `7d`, `30d`, `12m`)                               | yes      | no       |             |
| `humanUniqueVisitors`  | integer                                                       | yes      | no       |             |
| `humanPageviews`       | integer                                                       | yes      | no       |             |
| `botPageviews`         | integer                                                       | yes      | no       |             |
| `adminUniqueUsers`     | integer                                                       | yes      | no       |             |
| `publicUniqueVisitors` | integer                                                       | yes      | no       |             |
| `topPaths`             | array of [`AnalyticsNamedCount`](#schema-analyticsnamedcount) | yes      | no       |             |
| `topBrowsers`          | array of [`AnalyticsNamedCount`](#schema-analyticsnamedcount) | yes      | no       |             |
| `topDevices`           | array of [`AnalyticsNamedCount`](#schema-analyticsnamedcount) | yes      | no       |             |
| `topCountries`         | array of [`AnalyticsNamedCount`](#schema-analyticsnamedcount) | yes      | no       |             |

**Example**

```json
{
  "range": "24h",
  "humanUniqueVisitors": 0,
  "humanPageviews": 0,
  "botPageviews": 0,
  "adminUniqueUsers": 0,
  "publicUniqueVisitors": 0,
  "topPaths": [
    {
      "name": "string",
      "count": 0
    }
  ],
  "topBrowsers": [
    {
      "name": "string",
      "count": 0
    }
  ],
  "topDevices": [
    {
      "name": "string",
      "count": 0
    }
  ],
  "topCountries": [
    {
      "name": "string",
      "count": 0
    }
  ]
}
```

### Schema: AnnouncementCreateResponse

| Field            | Type    | Required | Nullable | Description |
| ---------------- | ------- | -------- | -------- | ----------- |
| `recipientCount` | integer | yes      | no       |             |
| `correlationId`  | string  | yes      | no       |             |

**Example**

```json
{
  "recipientCount": 0,
  "correlationId": "string"
}
```

### Schema: AnnouncementPreviewResponse

| Field          | Type    | Required | Nullable | Description                                                                    |
| -------------- | ------- | -------- | -------- | ------------------------------------------------------------------------------ |
| `matchedCount` | integer | yes      | no       | Recipient count only — the actual recipient list/addresses are never returned. |
| `sample`       | object  | yes      | no       |                                                                                |

**Example**

```json
{
  "matchedCount": 0,
  "sample": {
    "subject": "string",
    "textBody": "string",
    "htmlBody": "string"
  }
}
```

### Schema: AnnouncementRequest

| Field         | Type                                               | Required | Nullable | Description                                                    |
| ------------- | -------------------------------------------------- | -------- | -------- | -------------------------------------------------------------- |
| `templateKey` | string                                             | yes      | no       | A recognized base category or registered "derived.*" category. |
| `variables`   | object                                             | no       | no       |                                                                |
| `target`      | [`AnnouncementTarget`](#schema-announcementtarget) | yes      | no       |                                                                |
| `locale`      | string                                             | no       | no       |                                                                |

**Example**

```json
{
  "templateKey": "string",
  "variables": "(operation-specific payload)",
  "target": {
    "type": "users",
    "userIds": ["00000000-0000-0000-0000-000000000000"],
    "roleId": "00000000-0000-0000-0000-000000000000"
  },
  "locale": "string"
}
```

### Schema: AnnouncementTarget

| Field     | Type                            | Required | Nullable | Description                    |
| --------- | ------------------------------- | -------- | -------- | ------------------------------ |
| `type`    | enum(`users`, `role`, `tenant`) | yes      | no       |                                |
| `userIds` | array of string (uuid)          | no       | no       | Required when type is "users". |
| `roleId`  | string (uuid)                   | no       | no       | Required when type is "role".  |

**Example**

```json
{
  "type": "users",
  "userIds": ["00000000-0000-0000-0000-000000000000"],
  "roleId": "00000000-0000-0000-0000-000000000000"
}
```

### Schema: AuditEventEntry

| Field               | Type                                | Required | Nullable | Description                                             |
| ------------------- | ----------------------------------- | -------- | -------- | ------------------------------------------------------- |
| `id`                | string (uuid)                       | yes      | no       |                                                         |
| `actorTenantUserId` | string (uuid)                       | no       | no       |                                                         |
| `moduleKey`         | string                              | yes      | no       |                                                         |
| `action`            | string                              | yes      | no       |                                                         |
| `resourceType`      | string                              | yes      | no       |                                                         |
| `resourceId`        | string                              | no       | no       |                                                         |
| `severity`          | enum(`info`, `warning`, `critical`) | yes      | no       |                                                         |
| `message`           | string                              | yes      | no       |                                                         |
| `attributes`        | object                              | no       | no       | Already redacted at write time — never raw PII/secrets. |
| `correlationId`     | string                              | no       | no       |                                                         |
| `createdAt`         | string (date-time)                  | yes      | no       |                                                         |

**Example**

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "actorTenantUserId": "00000000-0000-0000-0000-000000000000",
  "moduleKey": "string",
  "action": "string",
  "resourceType": "string",
  "resourceId": "string",
  "severity": "info",
  "message": "string",
  "attributes": "(operation-specific payload)",
  "correlationId": "string",
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: AuditEventListResponse

| Field        | Type                                                  | Required | Nullable | Description                                                                                                                           |
| ------------ | ----------------------------------------------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `events`     | array of [`AuditEventEntry`](#schema-auditevententry) | yes      | no       |                                                                                                                                       |
| `nextCursor` | string                                                | yes      | yes      | Opaque keyset pagination cursor; pass back as the `cursor` query parameter to fetch the next page. `null` when this is the last page. |

**Example**

```json
{
  "events": [
    {
      "id": "00000000-0000-0000-0000-000000000000",
      "actorTenantUserId": "00000000-0000-0000-0000-000000000000",
      "moduleKey": "string",
      "action": "string",
      "resourceType": "string",
      "resourceId": "string",
      "severity": "info",
      "message": "string",
      "attributes": "(operation-specific payload)",
      "correlationId": "string",
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "nextCursor": "string"
}
```

### Schema: AuthProviderListResponse

| Field       | Type                                                    | Required | Nullable | Description |
| ----------- | ------------------------------------------------------- | -------- | -------- | ----------- |
| `providers` | array of [`AuthProviderView`](#schema-authproviderview) | yes      | no       |             |

**Example**

```json
{
  "providers": [
    {
      "id": "00000000-0000-0000-0000-000000000000",
      "providerKey": "string",
      "providerType": "oidc",
      "displayName": "string",
      "issuerUrl": "https://example.com/resource",
      "clientId": "string",
      "secretSource": "encrypted",
      "clientSecretEnvVar": "string",
      "scopes": "string",
      "allowedEmailDomains": [],
      "enabled": false,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

### Schema: AuthProviderView

| Field                 | Type                     | Required | Nullable | Description                                                                                                                                                                                                          |
| --------------------- | ------------------------ | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                  | string (uuid)            | yes      | no       |                                                                                                                                                                                                                      |
| `providerKey`         | string                   | yes      | no       |                                                                                                                                                                                                                      |
| `providerType`        | enum(`oidc`)             | yes      | no       |                                                                                                                                                                                                                      |
| `displayName`         | string                   | yes      | no       |                                                                                                                                                                                                                      |
| `issuerUrl`           | string                   | yes      | no       |                                                                                                                                                                                                                      |
| `clientId`            | string                   | yes      | no       |                                                                                                                                                                                                                      |
| `secretSource`        | enum(`encrypted`, `env`) | yes      | no       | Never the secret itself — `encrypted` means a client secret is stored encrypted at rest (AES-256-GCM); `env` means the secret is read from the named environment variable (`clientSecretEnvVar`) at OAuth-call time. |
| `clientSecretEnvVar`  | string                   | yes      | yes      | The environment variable NAME (never a secret value) when `secretSource` is `env`.                                                                                                                                   |
| `scopes`              | string                   | yes      | no       |                                                                                                                                                                                                                      |
| `allowedEmailDomains` | array of string          | yes      | no       |                                                                                                                                                                                                                      |
| `enabled`             | boolean                  | yes      | no       |                                                                                                                                                                                                                      |
| `createdAt`           | string (date-time)       | yes      | no       |                                                                                                                                                                                                                      |
| `updatedAt`           | string (date-time)       | yes      | no       |                                                                                                                                                                                                                      |

**Example**

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "providerKey": "string",
  "providerType": "oidc",
  "displayName": "string",
  "issuerUrl": "https://example.com/resource",
  "clientId": "string",
  "secretSource": "encrypted",
  "clientSecretEnvVar": "string",
  "scopes": "string",
  "allowedEmailDomains": ["user@example.com"],
  "enabled": false,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: BlogAdItem

| Field        | Type                                                            | Required | Nullable | Description |
| ------------ | --------------------------------------------------------------- | -------- | -------- | ----------- |
| `id`         | string (uuid)                                                   | yes      | no       |             |
| `tenantId`   | string (uuid)                                                   | yes      | no       |             |
| `name`       | string                                                          | yes      | no       |             |
| `imageUrl`   | string                                                          | yes      | no       |             |
| `linkUrl`    | string                                                          | yes      | yes      |             |
| `isActive`   | boolean                                                         | yes      | no       |             |
| `startsAt`   | string (date-time)                                              | yes      | yes      |             |
| `endsAt`     | string (date-time)                                              | yes      | yes      |             |
| `createdAt`  | string (date-time)                                              | yes      | no       |             |
| `updatedAt`  | string (date-time)                                              | yes      | no       |             |
| `placements` | array of [`BlogAdPlacementEntry`](#schema-blogadplacemententry) | yes      | no       |             |

**Example**

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "name": "string",
  "imageUrl": "https://example.com/resource",
  "linkUrl": "https://example.com/resource",
  "isActive": false,
  "startsAt": "2026-01-01T00:00:00.000Z",
  "endsAt": "2026-01-01T00:00:00.000Z",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "placements": [
    {
      "id": "00000000-0000-0000-0000-000000000000",
      "tenantId": "00000000-0000-0000-0000-000000000000",
      "adId": "00000000-0000-0000-0000-000000000000",
      "placementType": "global",
      "targetId": "00000000-0000-0000-0000-000000000000"
    }
  ]
}
```

### Schema: BlogAdPlacementEntry

| Field           | Type                                     | Required | Nullable | Description |
| --------------- | ---------------------------------------- | -------- | -------- | ----------- |
| `id`            | string (uuid)                            | yes      | no       |             |
| `tenantId`      | string (uuid)                            | yes      | no       |             |
| `adId`          | string (uuid)                            | yes      | no       |             |
| `placementType` | enum(`global`, `widget`, `post`, `page`) | yes      | no       |             |
| `targetId`      | string (uuid)                            | yes      | yes      |             |

**Example**

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "adId": "00000000-0000-0000-0000-000000000000",
  "placementType": "global",
  "targetId": "00000000-0000-0000-0000-000000000000"
}
```

### Schema: BlogMenuItem

| Field       | Type                                                      | Required | Nullable | Description |
| ----------- | --------------------------------------------------------- | -------- | -------- | ----------- |
| `id`        | string (uuid)                                             | yes      | no       |             |
| `tenantId`  | string (uuid)                                             | yes      | no       |             |
| `key`       | string                                                    | yes      | no       |             |
| `name`      | string                                                    | yes      | no       |             |
| `createdAt` | string (date-time)                                        | yes      | no       |             |
| `updatedAt` | string (date-time)                                        | yes      | no       |             |
| `items`     | array of [`BlogMenuItemEntry`](#schema-blogmenuitementry) | yes      | no       |             |

**Example**

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "key": "string",
  "name": "string",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "items": [
    {
      "id": "00000000-0000-0000-0000-000000000000",
      "tenantId": "00000000-0000-0000-0000-000000000000",
      "menuId": "00000000-0000-0000-0000-000000000000",
      "parentItemId": "00000000-0000-0000-0000-000000000000",
      "label": "string",
      "linkType": "post",
      "targetId": "00000000-0000-0000-0000-000000000000",
      "url": "https://example.com/resource",
      "sortOrder": 0
    }
  ]
}
```

### Schema: BlogMenuItemEntry

| Field          | Type                        | Required | Nullable | Description |
| -------------- | --------------------------- | -------- | -------- | ----------- |
| `id`           | string (uuid)               | yes      | no       |             |
| `tenantId`     | string (uuid)               | yes      | no       |             |
| `menuId`       | string (uuid)               | yes      | no       |             |
| `parentItemId` | string (uuid)               | yes      | yes      |             |
| `label`        | string                      | yes      | no       |             |
| `linkType`     | enum(`post`, `page`, `url`) | yes      | no       |             |
| `targetId`     | string (uuid)               | yes      | yes      |             |
| `url`          | string                      | yes      | yes      |             |
| `sortOrder`    | integer                     | yes      | no       |             |

**Example**

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "menuId": "00000000-0000-0000-0000-000000000000",
  "parentItemId": "00000000-0000-0000-0000-000000000000",
  "label": "string",
  "linkType": "post",
  "targetId": "00000000-0000-0000-0000-000000000000",
  "url": "https://example.com/resource",
  "sortOrder": 0
}
```

### Schema: BlogPageItem

| Field                | Type                                                          | Required | Nullable | Description                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | string (uuid)                                                 | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `tenantId`           | string (uuid)                                                 | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `authorTenantUserId` | string (uuid)                                                 | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `title`              | string                                                        | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `slug`               | string                                                        | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `excerpt`            | string                                                        | yes      | yes      |                                                                                                                                                                                                                                                                                                                                                                         |
| `contentJson`        | object                                                        | yes      | no       | When full-online R2-only news portal mode is active for this tenant (Issue #636), an image gallery block item (mediaType image) must use mediaObjectId referencing a verified/attached same-tenant media object, never a raw url.                                                                                                                                       |
| `contentText`        | string                                                        | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `status`             | enum(`draft`, `review`, `scheduled`, `published`, `archived`) | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `visibility`         | enum(`public`, `private`, `unlisted`)                         | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `featuredMediaId`    | string (uuid)                                                 | yes      | yes      | When full-online R2-only news portal mode is active for this tenant (Issue #636), must reference an existing, same-tenant media object (Issue #633) with status verified or attached — never a local path or arbitrary external URL. A non-conforming reference is rejected with 422 NEWS_MEDIA_REFERENCE_INVALID. Outside that mode, only the UUID shape is validated. |
| `seoTitle`           | string                                                        | yes      | yes      |                                                                                                                                                                                                                                                                                                                                                                         |
| `metaDescription`    | string                                                        | yes      | yes      |                                                                                                                                                                                                                                                                                                                                                                         |
| `canonicalUrl`       | string                                                        | yes      | yes      |                                                                                                                                                                                                                                                                                                                                                                         |
| `locale`             | string                                                        | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `pageType`           | enum(`standard`, `landing`, `legal`, `system`)                | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `parentPageId`       | string (uuid)                                                 | yes      | yes      |                                                                                                                                                                                                                                                                                                                                                                         |
| `menuOrder`          | integer                                                       | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `publishedAt`        | string (date-time)                                            | yes      | yes      |                                                                                                                                                                                                                                                                                                                                                                         |
| `scheduledAt`        | string (date-time)                                            | yes      | yes      |                                                                                                                                                                                                                                                                                                                                                                         |
| `createdAt`          | string (date-time)                                            | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `updatedAt`          | string (date-time)                                            | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `deletedAt`          | string (date-time)                                            | yes      | yes      |                                                                                                                                                                                                                                                                                                                                                                         |
| `deletedBy`          | string (uuid)                                                 | yes      | yes      |                                                                                                                                                                                                                                                                                                                                                                         |
| `deleteReason`       | string                                                        | yes      | yes      |                                                                                                                                                                                                                                                                                                                                                                         |
| `restoredAt`         | string (date-time)                                            | yes      | yes      |                                                                                                                                                                                                                                                                                                                                                                         |
| `restoredBy`         | string (uuid)                                                 | yes      | yes      |                                                                                                                                                                                                                                                                                                                                                                         |
| `version`            | integer                                                       | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                         |

**Example**

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "authorTenantUserId": "00000000-0000-0000-0000-000000000000",
  "title": "string",
  "slug": "example-slug",
  "excerpt": "string",
  "contentJson": "(operation-specific payload)",
  "contentText": "string",
  "status": "draft",
  "visibility": "public",
  "featuredMediaId": "00000000-0000-0000-0000-000000000000",
  "seoTitle": "string",
  "metaDescription": "string",
  "canonicalUrl": "https://example.com/resource",
  "locale": "string",
  "pageType": "standard",
  "parentPageId": "00000000-0000-0000-0000-000000000000",
  "menuOrder": 0,
  "publishedAt": "2026-01-01T00:00:00.000Z",
  "scheduledAt": "2026-01-01T00:00:00.000Z",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "deletedAt": "2026-01-01T00:00:00.000Z",
  "deletedBy": "00000000-0000-0000-0000-000000000000",
  "deleteReason": "string",
  "restoredAt": "2026-01-01T00:00:00.000Z",
  "restoredBy": "00000000-0000-0000-0000-000000000000",
  "version": 1
}
```

### Schema: BlogPageListItem

| Field          | Type                                                          | Required | Nullable | Description |
| -------------- | ------------------------------------------------------------- | -------- | -------- | ----------- |
| `id`           | string (uuid)                                                 | yes      | no       |             |
| `tenantId`     | string (uuid)                                                 | yes      | no       |             |
| `title`        | string                                                        | yes      | no       |             |
| `slug`         | string                                                        | yes      | no       |             |
| `status`       | enum(`draft`, `review`, `scheduled`, `published`, `archived`) | yes      | no       |             |
| `visibility`   | enum(`public`, `private`, `unlisted`)                         | yes      | no       |             |
| `pageType`     | enum(`standard`, `landing`, `legal`, `system`)                | yes      | no       |             |
| `parentPageId` | string (uuid)                                                 | yes      | yes      |             |
| `menuOrder`    | integer                                                       | yes      | no       |             |
| `locale`       | string                                                        | yes      | no       |             |
| `updatedAt`    | string (date-time)                                            | yes      | no       |             |

**Example**

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "title": "string",
  "slug": "example-slug",
  "status": "draft",
  "visibility": "public",
  "pageType": "standard",
  "parentPageId": "00000000-0000-0000-0000-000000000000",
  "menuOrder": 0,
  "locale": "string",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: BlogPageListResponse

| Field   | Type                                                    | Required | Nullable | Description |
| ------- | ------------------------------------------------------- | -------- | -------- | ----------- |
| `pages` | array of [`BlogPageListItem`](#schema-blogpagelistitem) | yes      | no       |             |

**Example**

```json
{
  "pages": [
    {
      "id": "00000000-0000-0000-0000-000000000000",
      "tenantId": "00000000-0000-0000-0000-000000000000",
      "title": "string",
      "slug": "example-slug",
      "status": "draft",
      "visibility": "public",
      "pageType": "standard",
      "parentPageId": "00000000-0000-0000-0000-000000000000",
      "menuOrder": 0,
      "locale": "string",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

### Schema: BlogPostItem

| Field                | Type                                                          | Required | Nullable | Description                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | string (uuid)                                                 | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                                     |
| `tenantId`           | string (uuid)                                                 | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                                     |
| `authorTenantUserId` | string (uuid)                                                 | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                                     |
| `title`              | string                                                        | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                                     |
| `slug`               | string                                                        | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                                     |
| `excerpt`            | string                                                        | yes      | yes      |                                                                                                                                                                                                                                                                                                                                                                                     |
| `contentJson`        | object                                                        | yes      | no       | Structured content (e.g. block/rich-text tree). Opaque to the API. When full-online R2-only news portal mode is active for this tenant (Issue #636), an image gallery block item (mediaType image) must use mediaObjectId referencing a verified/attached same-tenant media object, never a raw url — a non-conforming reference is rejected with 422 NEWS_MEDIA_REFERENCE_INVALID. |
| `contentText`        | string                                                        | yes      | no       | Plain-text extraction of contentJson, used for search.                                                                                                                                                                                                                                                                                                                              |
| `status`             | enum(`draft`, `review`, `scheduled`, `published`, `archived`) | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                                     |
| `visibility`         | enum(`public`, `private`, `unlisted`)                         | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                                     |
| `featuredMediaId`    | string (uuid)                                                 | yes      | yes      | When full-online R2-only news portal mode is active for this tenant (Issue #636), must reference an existing, same-tenant media object (Issue #633) with status verified or attached — never a local path or arbitrary external URL. A non-conforming reference is rejected with 422 NEWS_MEDIA_REFERENCE_INVALID. Outside that mode, only the UUID shape is validated.             |
| `seoTitle`           | string                                                        | yes      | yes      |                                                                                                                                                                                                                                                                                                                                                                                     |
| `metaDescription`    | string                                                        | yes      | yes      |                                                                                                                                                                                                                                                                                                                                                                                     |
| `canonicalUrl`       | string                                                        | yes      | yes      |                                                                                                                                                                                                                                                                                                                                                                                     |
| `locale`             | string                                                        | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                                     |
| `publishedAt`        | string (date-time)                                            | yes      | yes      |                                                                                                                                                                                                                                                                                                                                                                                     |
| `scheduledAt`        | string (date-time)                                            | yes      | yes      |                                                                                                                                                                                                                                                                                                                                                                                     |
| `createdAt`          | string (date-time)                                            | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                                     |
| `updatedAt`          | string (date-time)                                            | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                                     |
| `deletedAt`          | string (date-time)                                            | yes      | yes      |                                                                                                                                                                                                                                                                                                                                                                                     |
| `deletedBy`          | string (uuid)                                                 | yes      | yes      |                                                                                                                                                                                                                                                                                                                                                                                     |
| `deleteReason`       | string                                                        | yes      | yes      |                                                                                                                                                                                                                                                                                                                                                                                     |
| `restoredAt`         | string (date-time)                                            | yes      | yes      |                                                                                                                                                                                                                                                                                                                                                                                     |
| `restoredBy`         | string (uuid)                                                 | yes      | yes      |                                                                                                                                                                                                                                                                                                                                                                                     |
| `version`            | integer                                                       | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                                     |
| `termIds`            | array of string (uuid)                                        | no       | no       | Category/tag ids currently assigned to this post (Issue #539). Only present on responses from endpoints that compute it (create/update/get detail), not on the list endpoint.                                                                                                                                                                                                       |

**Example**

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "authorTenantUserId": "00000000-0000-0000-0000-000000000000",
  "title": "string",
  "slug": "example-slug",
  "excerpt": "string",
  "contentJson": "(operation-specific payload)",
  "contentText": "string",
  "status": "draft",
  "visibility": "public",
  "featuredMediaId": "00000000-0000-0000-0000-000000000000",
  "seoTitle": "string",
  "metaDescription": "string",
  "canonicalUrl": "https://example.com/resource",
  "locale": "string",
  "publishedAt": "2026-01-01T00:00:00.000Z",
  "scheduledAt": "2026-01-01T00:00:00.000Z",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "deletedAt": "2026-01-01T00:00:00.000Z",
  "deletedBy": "00000000-0000-0000-0000-000000000000",
  "deleteReason": "string",
  "restoredAt": "2026-01-01T00:00:00.000Z",
  "restoredBy": "00000000-0000-0000-0000-000000000000",
  "version": 1,
  "termIds": ["00000000-0000-0000-0000-000000000000"]
}
```

### Schema: BlogPostListItem

| Field         | Type                                                          | Required | Nullable | Description |
| ------------- | ------------------------------------------------------------- | -------- | -------- | ----------- |
| `id`          | string (uuid)                                                 | yes      | no       |             |
| `tenantId`    | string (uuid)                                                 | yes      | no       |             |
| `title`       | string                                                        | yes      | no       |             |
| `slug`        | string                                                        | yes      | no       |             |
| `status`      | enum(`draft`, `review`, `scheduled`, `published`, `archived`) | yes      | no       |             |
| `visibility`  | enum(`public`, `private`, `unlisted`)                         | yes      | no       |             |
| `locale`      | string                                                        | yes      | no       |             |
| `publishedAt` | string (date-time)                                            | yes      | yes      |             |
| `updatedAt`   | string (date-time)                                            | yes      | no       |             |

**Example**

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "title": "string",
  "slug": "example-slug",
  "status": "draft",
  "visibility": "public",
  "locale": "string",
  "publishedAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: BlogPostListResponse

| Field   | Type                                                    | Required | Nullable | Description |
| ------- | ------------------------------------------------------- | -------- | -------- | ----------- |
| `posts` | array of [`BlogPostListItem`](#schema-blogpostlistitem) | yes      | no       |             |

**Example**

```json
{
  "posts": [
    {
      "id": "00000000-0000-0000-0000-000000000000",
      "tenantId": "00000000-0000-0000-0000-000000000000",
      "title": "string",
      "slug": "example-slug",
      "status": "draft",
      "visibility": "public",
      "locale": "string",
      "publishedAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

### Schema: BlogRevisionItem

Full revision detail — `GET /api/v1/blog/posts/{id}/revisions/{revisionId}`.

| Field                   | Type                 | Required | Nullable | Description                                                                     |
| ----------------------- | -------------------- | -------- | -------- | ------------------------------------------------------------------------------- |
| `id`                    | string (uuid)        | yes      | no       |                                                                                 |
| `tenantId`              | string (uuid)        | yes      | no       |                                                                                 |
| `resourceType`          | enum(`post`, `page`) | yes      | no       |                                                                                 |
| `resourceId`            | string (uuid)        | yes      | no       |                                                                                 |
| `revisionNumber`        | integer              | yes      | no       |                                                                                 |
| `title`                 | string               | yes      | no       |                                                                                 |
| `contentJson`           | object               | yes      | no       | Structured content snapshot at the time this revision was captured.             |
| `contentText`           | string               | yes      | no       |                                                                                 |
| `excerpt`               | string               | yes      | yes      |                                                                                 |
| `seoTitle`              | string               | yes      | yes      |                                                                                 |
| `metaDescription`       | string               | yes      | yes      |                                                                                 |
| `canonicalUrl`          | string               | yes      | yes      |                                                                                 |
| `status`                | string               | yes      | no       | The resource's lifecycle status at the moment this revision was captured.       |
| `changeNote`            | string               | yes      | yes      | Set when a revision is created by a restore (e.g. "Restored from revision 3."). |
| `createdByTenantUserId` | string (uuid)        | yes      | no       |                                                                                 |
| `createdAt`             | string (date-time)   | yes      | no       |                                                                                 |

**Example**

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "resourceType": "post",
  "resourceId": "00000000-0000-0000-0000-000000000000",
  "revisionNumber": 1,
  "title": "string",
  "contentJson": "(operation-specific payload)",
  "contentText": "string",
  "excerpt": "string",
  "seoTitle": "string",
  "metaDescription": "string",
  "canonicalUrl": "https://example.com/resource",
  "status": "string",
  "changeNote": "string",
  "createdByTenantUserId": "00000000-0000-0000-0000-000000000000",
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: BlogSearchResponse

| Field        | Type                                                            | Required | Nullable | Description |
| ------------ | --------------------------------------------------------------- | -------- | -------- | ----------- |
| `items`      | array of [`BlogSearchResultItem`](#schema-blogsearchresultitem) | yes      | no       |             |
| `nextCursor` | string                                                          | yes      | yes      |             |

**Example**

```json
{
  "items": [
    {
      "resourceType": "post",
      "id": "00000000-0000-0000-0000-000000000000",
      "title": "string",
      "slug": "example-slug",
      "excerpt": "string",
      "status": "draft",
      "visibility": "public",
      "locale": "string",
      "publishedAt": "2026-01-01T00:00:00.000Z",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "nextCursor": "string"
}
```

### Schema: BlogSearchResultItem

| Field          | Type                                                          | Required | Nullable | Description |
| -------------- | ------------------------------------------------------------- | -------- | -------- | ----------- |
| `resourceType` | enum(`post`, `page`)                                          | yes      | no       |             |
| `id`           | string (uuid)                                                 | yes      | no       |             |
| `title`        | string                                                        | yes      | no       |             |
| `slug`         | string                                                        | yes      | no       |             |
| `excerpt`      | string                                                        | yes      | yes      |             |
| `status`       | enum(`draft`, `review`, `scheduled`, `published`, `archived`) | yes      | no       |             |
| `visibility`   | enum(`public`, `private`, `unlisted`)                         | yes      | no       |             |
| `locale`       | string                                                        | yes      | no       |             |
| `publishedAt`  | string (date-time)                                            | yes      | yes      |             |
| `createdAt`    | string (date-time)                                            | yes      | no       |             |
| `updatedAt`    | string (date-time)                                            | yes      | no       |             |

**Example**

```json
{
  "resourceType": "post",
  "id": "00000000-0000-0000-0000-000000000000",
  "title": "string",
  "slug": "example-slug",
  "excerpt": "string",
  "status": "draft",
  "visibility": "public",
  "locale": "string",
  "publishedAt": "2026-01-01T00:00:00.000Z",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: BlogSettingsView

| Field                   | Type                                  | Required | Nullable | Description |
| ----------------------- | ------------------------------------- | -------- | -------- | ----------- |
| `tenantId`              | string (uuid)                         | yes      | no       |             |
| `blogTitle`             | string                                | yes      | no       |             |
| `blogDescription`       | string                                | yes      | yes      |             |
| `postsPerPage`          | integer                               | yes      | no       |             |
| `rssEnabled`            | boolean                               | yes      | no       |             |
| `sitemapEnabled`        | boolean                               | yes      | no       |             |
| `defaultLocale`         | string                                | yes      | no       |             |
| `defaultVisibility`     | enum(`public`, `private`, `unlisted`) | yes      | no       |             |
| `seoDefaultTitle`       | string                                | yes      | yes      |             |
| `seoDefaultDescription` | string                                | yes      | yes      |             |
| `updatedAt`             | string (date-time)                    | yes      | yes      |             |

**Example**

```json
{
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "blogTitle": "string",
  "blogDescription": "string",
  "postsPerPage": 1,
  "rssEnabled": false,
  "sitemapEnabled": false,
  "defaultLocale": "string",
  "defaultVisibility": "public",
  "seoDefaultTitle": "string",
  "seoDefaultDescription": "string",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: BlogTemplateItem

| Field        | Type                                               | Required | Nullable | Description |
| ------------ | -------------------------------------------------- | -------- | -------- | ----------- |
| `id`         | string (uuid)                                      | yes      | no       |             |
| `tenantId`   | string (uuid)                                      | yes      | no       |             |
| `key`        | string                                             | yes      | no       |             |
| `name`       | string                                             | yes      | no       |             |
| `layoutJson` | [`BlogTemplateLayout`](#schema-blogtemplatelayout) | yes      | no       |             |
| `isActive`   | boolean                                            | yes      | no       |             |
| `createdAt`  | string (date-time)                                 | yes      | no       |             |
| `updatedAt`  | string (date-time)                                 | yes      | no       |             |

**Example**

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "key": "string",
  "name": "string",
  "layoutJson": {
    "columns": 1,
    "sidebarPosition": "left"
  },
  "isActive": false,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: BlogTemplateLayout

Whitelisted layout shape (Issue

| Field             | Type                          | Required | Nullable | Description |
| ----------------- | ----------------------------- | -------- | -------- | ----------- |
| `columns`         | enum(`1`, `2`, `3`)           | yes      | no       |             |
| `sidebarPosition` | enum(`left`, `right`, `none`) | yes      | no       |             |

**Example**

```json
{
  "columns": 1,
  "sidebarPosition": "left"
}
```

### Schema: BlogTermItem

| Field          | Type                    | Required | Nullable | Description |
| -------------- | ----------------------- | -------- | -------- | ----------- |
| `id`           | string (uuid)           | yes      | no       |             |
| `tenantId`     | string (uuid)           | yes      | no       |             |
| `taxonomyType` | enum(`category`, `tag`) | yes      | no       |             |
| `parentId`     | string (uuid)           | yes      | yes      |             |
| `name`         | string                  | yes      | no       |             |
| `slug`         | string                  | yes      | no       |             |
| `description`  | string                  | yes      | yes      |             |
| `createdAt`    | string (date-time)      | yes      | no       |             |
| `updatedAt`    | string (date-time)      | yes      | no       |             |
| `deletedAt`    | string (date-time)      | yes      | yes      |             |
| `deletedBy`    | string (uuid)           | yes      | yes      |             |
| `deleteReason` | string                  | yes      | yes      |             |

**Example**

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "taxonomyType": "category",
  "parentId": "00000000-0000-0000-0000-000000000000",
  "name": "string",
  "slug": "example-slug",
  "description": "string",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "deletedAt": "2026-01-01T00:00:00.000Z",
  "deletedBy": "00000000-0000-0000-0000-000000000000",
  "deleteReason": "string"
}
```

### Schema: BlogTermListResponse

| Field   | Type                                            | Required | Nullable | Description |
| ------- | ----------------------------------------------- | -------- | -------- | ----------- |
| `terms` | array of [`BlogTermItem`](#schema-blogtermitem) | yes      | no       |             |

**Example**

```json
{
  "terms": [
    {
      "id": "00000000-0000-0000-0000-000000000000",
      "tenantId": "00000000-0000-0000-0000-000000000000",
      "taxonomyType": "category",
      "parentId": "00000000-0000-0000-0000-000000000000",
      "name": "string",
      "slug": "example-slug",
      "description": "string",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z",
      "deletedAt": "2026-01-01T00:00:00.000Z",
      "deletedBy": "00000000-0000-0000-0000-000000000000",
      "deleteReason": "string"
    }
  ]
}
```

### Schema: BlogThemeSettings

| Field        | Type                            | Required | Nullable | Description                                                                             |
| ------------ | ------------------------------- | -------- | -------- | --------------------------------------------------------------------------------------- |
| `mode`       | enum(`light`, `dark`, `system`) | yes      | no       |                                                                                         |
| `isOverride` | boolean                         | yes      | no       | false means this is the tenant's inherited default_theme, not a blog-specific override. |

**Example**

```json
{
  "mode": "light",
  "isOverride": false
}
```

### Schema: BlogWidgetItem

| Field       | Type                                                                   | Required | Nullable | Description |
| ----------- | ---------------------------------------------------------------------- | -------- | -------- | ----------- |
| `id`        | string (uuid)                                                          | yes      | no       |             |
| `tenantId`  | string (uuid)                                                          | yes      | no       |             |
| `position`  | enum(`header`, `sidebar`, `footer`, `content_before`, `content_after`) | yes      | no       |             |
| `title`     | string                                                                 | yes      | no       |             |
| `bodyText`  | string                                                                 | yes      | no       |             |
| `isActive`  | boolean                                                                | yes      | no       |             |
| `sortOrder` | integer                                                                | yes      | no       |             |
| `createdAt` | string (date-time)                                                     | yes      | no       |             |
| `updatedAt` | string (date-time)                                                     | yes      | no       |             |

**Example**

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "position": "header",
  "title": "string",
  "bodyText": "string",
  "isActive": false,
  "sortOrder": 0,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: CreateAuthProviderRequest

| Field                 | Type            | Required | Nullable | Description                                                                                                                                            |
| --------------------- | --------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `providerKey`         | string          | yes      | no       |                                                                                                                                                        |
| `displayName`         | string          | yes      | no       |                                                                                                                                                        |
| `issuerUrl`           | string          | yes      | no       | Must be an `https://` URL.                                                                                                                             |
| `clientId`            | string          | yes      | no       |                                                                                                                                                        |
| `clientSecret`        | string          | no       | no       | Plaintext secret, encrypted at rest immediately — never returned by any endpoint. Exactly one of `clientSecret`/`clientSecretEnvVar` must be provided. |
| `clientSecretEnvVar`  | string          | no       | no       | Name of an environment variable holding the secret. Exactly one of `clientSecret`/`clientSecretEnvVar` must be provided.                               |
| `scopes`              | string          | no       | no       |                                                                                                                                                        |
| `allowedEmailDomains` | array of string | no       | no       |                                                                                                                                                        |
| `enabled`             | boolean         | no       | no       |                                                                                                                                                        |

**Example**

```json
{
  "providerKey": "string",
  "displayName": "string",
  "issuerUrl": "https://example.com/resource",
  "clientId": "string",
  "clientSecret": "string",
  "clientSecretEnvVar": "string",
  "scopes": "string",
  "allowedEmailDomains": ["user@example.com"],
  "enabled": false
}
```

### Schema: CreateBlogPageRequest

| Field             | Type                                           | Required | Nullable | Description                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ---------------------------------------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`           | string                                         | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `slug`            | string                                         | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `excerpt`         | string                                         | no       | yes      |                                                                                                                                                                                                                                                                                                                                                                         |
| `contentJson`     | object                                         | yes      | no       | When full-online R2-only news portal mode is active for this tenant (Issue #636), an image gallery block item (mediaType image) must use mediaObjectId referencing a verified/attached same-tenant media object, never a raw url.                                                                                                                                       |
| `contentText`     | string                                         | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `locale`          | string                                         | no       | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `visibility`      | enum(`public`, `private`, `unlisted`)          | no       | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `featuredMediaId` | string (uuid)                                  | no       | yes      | When full-online R2-only news portal mode is active for this tenant (Issue #636), must reference an existing, same-tenant media object (Issue #633) with status verified or attached — never a local path or arbitrary external URL. A non-conforming reference is rejected with 422 NEWS_MEDIA_REFERENCE_INVALID. Outside that mode, only the UUID shape is validated. |
| `seoTitle`        | string                                         | no       | yes      |                                                                                                                                                                                                                                                                                                                                                                         |
| `metaDescription` | string                                         | no       | yes      |                                                                                                                                                                                                                                                                                                                                                                         |
| `canonicalUrl`    | string                                         | no       | yes      |                                                                                                                                                                                                                                                                                                                                                                         |
| `pageType`        | enum(`standard`, `landing`, `legal`, `system`) | no       | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `parentPageId`    | string (uuid)                                  | no       | yes      |                                                                                                                                                                                                                                                                                                                                                                         |
| `menuOrder`       | integer                                        | no       | no       |                                                                                                                                                                                                                                                                                                                                                                         |

**Example**

```json
{
  "title": "string",
  "slug": "example-slug",
  "excerpt": "string",
  "contentJson": "(operation-specific payload)",
  "contentText": "string",
  "locale": "string",
  "visibility": "public",
  "featuredMediaId": "00000000-0000-0000-0000-000000000000",
  "seoTitle": "string",
  "metaDescription": "string",
  "canonicalUrl": "https://example.com/resource",
  "pageType": "standard",
  "parentPageId": "00000000-0000-0000-0000-000000000000",
  "menuOrder": 0
}
```

### Schema: CreateBlogPostRequest

| Field             | Type                                  | Required | Nullable | Description                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ------------------------------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`           | string                                | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `slug`            | string                                | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `excerpt`         | string                                | no       | yes      |                                                                                                                                                                                                                                                                                                                                                                         |
| `contentJson`     | object                                | yes      | no       | When full-online R2-only news portal mode is active for this tenant (Issue #636), an image gallery block item (mediaType image) must use mediaObjectId referencing a verified/attached same-tenant media object, never a raw url.                                                                                                                                       |
| `contentText`     | string                                | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `locale`          | string                                | no       | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `visibility`      | enum(`public`, `private`, `unlisted`) | no       | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `featuredMediaId` | string (uuid)                         | no       | yes      | When full-online R2-only news portal mode is active for this tenant (Issue #636), must reference an existing, same-tenant media object (Issue #633) with status verified or attached — never a local path or arbitrary external URL. A non-conforming reference is rejected with 422 NEWS_MEDIA_REFERENCE_INVALID. Outside that mode, only the UUID shape is validated. |
| `seoTitle`        | string                                | no       | yes      |                                                                                                                                                                                                                                                                                                                                                                         |
| `metaDescription` | string                                | no       | yes      |                                                                                                                                                                                                                                                                                                                                                                         |
| `canonicalUrl`    | string                                | no       | yes      |                                                                                                                                                                                                                                                                                                                                                                         |
| `termIds`         | array of string (uuid)                | no       | no       | Category/tag ids to assign to this post (Issue                                                                                                                                                                                                                                                                                                                          |

**Example**

```json
{
  "title": "string",
  "slug": "example-slug",
  "excerpt": "string",
  "contentJson": "(operation-specific payload)",
  "contentText": "string",
  "locale": "string",
  "visibility": "public",
  "featuredMediaId": "00000000-0000-0000-0000-000000000000",
  "seoTitle": "string",
  "metaDescription": "string",
  "canonicalUrl": "https://example.com/resource",
  "termIds": ["00000000-0000-0000-0000-000000000000"]
}
```

### Schema: CreateBlogTermRequest

| Field          | Type                    | Required | Nullable | Description             |
| -------------- | ----------------------- | -------- | -------- | ----------------------- |
| `taxonomyType` | enum(`category`, `tag`) | yes      | no       |                         |
| `parentId`     | string (uuid)           | no       | yes      | Must be null for a tag. |
| `name`         | string                  | yes      | no       |                         |
| `slug`         | string                  | yes      | no       |                         |
| `description`  | string                  | no       | yes      |                         |

**Example**

```json
{
  "taxonomyType": "category",
  "parentId": "00000000-0000-0000-0000-000000000000",
  "name": "string",
  "slug": "example-slug",
  "description": "string"
}
```

### Schema: CreateEmailTemplateRequest

| Field              | Type                                                     | Required | Nullable | Description                                                              |
| ------------------ | -------------------------------------------------------- | -------- | -------- | ------------------------------------------------------------------------ |
| `templateKey`      | string                                                   | yes      | no       | Must be a recognized base category or a registered "derived.*" category. |
| `name`             | string                                                   | yes      | no       |                                                                          |
| `subjectTemplate`  | [`LocalizedTemplateText`](#schema-localizedtemplatetext) | yes      | no       |                                                                          |
| `textBodyTemplate` | [`LocalizedTemplateText`](#schema-localizedtemplatetext) | no       | no       |                                                                          |
| `htmlBodyTemplate` | [`LocalizedTemplateText`](#schema-localizedtemplatetext) | no       | no       |                                                                          |
| `isActive`         | boolean                                                  | no       | no       |                                                                          |

**Example**

```json
{
  "templateKey": "string",
  "name": "string",
  "subjectTemplate": {
    "en": "Reset your password",
    "id": "Atur ulang kata sandi Anda"
  },
  "textBodyTemplate": {
    "en": "Reset your password",
    "id": "Atur ulang kata sandi Anda"
  },
  "htmlBodyTemplate": {
    "en": "Reset your password",
    "id": "Atur ulang kata sandi Anda"
  },
  "isActive": false
}
```

### Schema: CreateFormDraftRequest

| Field          | Type               | Required | Nullable | Description                                                                                                                                                                                         |
| -------------- | ------------------ | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `moduleKey`    | string             | yes      | no       |                                                                                                                                                                                                     |
| `wizardKey`    | string             | yes      | no       |                                                                                                                                                                                                     |
| `resourceType` | string             | yes      | no       |                                                                                                                                                                                                     |
| `resourceId`   | string             | no       | no       |                                                                                                                                                                                                     |
| `currentStep`  | string             | yes      | no       |                                                                                                                                                                                                     |
| `payload`      | object             | yes      | no       | Arbitrary JSON scratch state up to 32KB serialized. Must never contain a field resembling a secret (password, token, credential, apiKey, privateKey) — rejected with 400 VALIDATION_ERROR if found. |
| `expiresAt`    | string (date-time) | no       | no       |                                                                                                                                                                                                     |

**Example**

```json
{
  "moduleKey": "string",
  "wizardKey": "string",
  "resourceType": "string",
  "resourceId": "string",
  "currentStep": "string",
  "payload": "(operation-specific payload)",
  "expiresAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: CreateNewsMediaUploadSessionRequest

| Field              | Type    | Required | Nullable | Description                                                                                                                                                                      |
| ------------------ | ------- | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mimeType`         | string  | yes      | no       | Must be one of the deployment's configured NEWS_MEDIA_R2_ALLOWED_MIME_TYPES (default: image/jpeg, image/png, image/webp, image/gif — image/svg+xml is never allowed by default). |
| `byteSize`         | integer | yes      | no       | Claimed size in bytes — shape-only check against NEWS_MEDIA_R2_MAX_UPLOAD_BYTES; the real size is re-checked from R2 itself at finalize time.                                    |
| `originalFilename` | string  | no       | yes      | Stored as display-only metadata — never part of the server-generated object key.                                                                                                 |
| `altText`          | string  | no       | yes      |                                                                                                                                                                                  |
| `caption`          | string  | no       | yes      |                                                                                                                                                                                  |

**Example**

```json
{
  "mimeType": "image/jpeg",
  "byteSize": 1,
  "originalFilename": "string",
  "altText": "string",
  "caption": "string"
}
```

### Schema: CreateRoleRequest

| Field           | Type                   | Required | Nullable | Description |
| --------------- | ---------------------- | -------- | -------- | ----------- |
| `roleCode`      | string                 | yes      | no       |             |
| `roleName`      | string                 | yes      | no       |             |
| `permissionIds` | array of string (uuid) | no       | no       |             |

**Example**

```json
{
  "roleCode": "string",
  "roleName": "string",
  "permissionIds": ["00000000-0000-0000-0000-000000000000"]
}
```

### Schema: CreateRoleResponse

| Field    | Type          | Required | Nullable | Description |
| -------- | ------------- | -------- | -------- | ----------- |
| `roleId` | string (uuid) | yes      | no       |             |

**Example**

```json
{
  "roleId": "00000000-0000-0000-0000-000000000000"
}
```

### Schema: CreateTenantDomainRequest

| Field                     | Type                                           | Required | Nullable | Description                                                                                                                               |
| ------------------------- | ---------------------------------------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `hostname`                | string                                         | yes      | no       | A valid DNS hostname (no port, no IPv6 literal) — reuses the same shape check the public host resolver applies to an inbound Host header. |
| `domainType`              | enum(`subdomain`, `custom_domain`)             | no       | no       | Defaults to custom_domain.                                                                                                                |
| `routeMode`               | enum(`canonical`, `legacy_blog`)               | no       | no       | Defaults to canonical.                                                                                                                    |
| `verificationMethod`      | enum(`dns_txt`, `dns_cname`, `file`, `manual`) | no       | yes      |                                                                                                                                           |
| `verificationRecordName`  | string                                         | no       | yes      |                                                                                                                                           |
| `verificationRecordValue` | string                                         | no       | yes      |                                                                                                                                           |
| `redirectToPrimary`       | boolean                                        | no       | no       | Defaults to false.                                                                                                                        |

**Example**

```json
{
  "hostname": "tenant.example.com",
  "domainType": "subdomain",
  "routeMode": "canonical",
  "verificationMethod": "dns_txt",
  "verificationRecordName": "string",
  "verificationRecordValue": "string",
  "redirectToPrimary": false
}
```

### Schema: CreateUserRequest

| Field             | Type                   | Required | Nullable | Description                                         |
| ----------------- | ---------------------- | -------- | -------- | --------------------------------------------------- |
| `displayName`     | string                 | yes      | no       |                                                     |
| `loginIdentifier` | string                 | yes      | no       |                                                     |
| `password`        | string                 | yes      | no       |                                                     |
| `roleIds`         | array of string (uuid) | no       | no       | Roles to assign immediately at creation (optional). |

**Example**

```json
{
  "displayName": "string",
  "loginIdentifier": "string",
  "password": "string",
  "roleIds": ["00000000-0000-0000-0000-000000000000"]
}
```

### Schema: CreateUserResponse

| Field          | Type          | Required | Nullable | Description |
| -------------- | ------------- | -------- | -------- | ----------- |
| `tenantUserId` | string (uuid) | yes      | no       |             |
| `identityId`   | string (uuid) | yes      | no       |             |
| `profileId`    | string (uuid) | yes      | no       |             |

**Example**

```json
{
  "tenantUserId": "00000000-0000-0000-0000-000000000000",
  "identityId": "00000000-0000-0000-0000-000000000000",
  "profileId": "00000000-0000-0000-0000-000000000000"
}
```

### Schema: DatabasePoolHealthResponse

| Field                 | Type                                                          | Required | Nullable | Description |
| --------------------- | ------------------------------------------------------------- | -------- | -------- | ----------- |
| `status`              | enum(`healthy`, `degraded`, `unhealthy`)                      | yes      | no       |             |
| `databaseReachable`   | boolean                                                       | yes      | no       |             |
| `circuitBreakerState` | enum(`closed`, `open`, `half_open`)                           | yes      | no       |             |
| `workClasses`         | array of [`WorkClassSaturation`](#schema-workclasssaturation) | yes      | no       |             |
| `generatedAt`         | string (date-time)                                            | yes      | no       |             |

**Example**

```json
{
  "status": "healthy",
  "databaseReachable": false,
  "circuitBreakerState": "closed",
  "workClasses": [
    {
      "workClass": "critical_transaction",
      "active": 0,
      "max": 0,
      "queued": 0
    }
  ],
  "generatedAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: DecisionLogEntry

| Field           | Type                  | Required | Nullable | Description |
| --------------- | --------------------- | -------- | -------- | ----------- |
| `id`            | string (uuid)         | yes      | no       |             |
| `tenantUserId`  | string (uuid)         | no       | no       |             |
| `moduleKey`     | string                | yes      | no       |             |
| `activityCode`  | string                | yes      | no       |             |
| `action`        | string                | yes      | no       |             |
| `decision`      | enum(`allow`, `deny`) | yes      | no       |             |
| `reason`        | string                | yes      | no       |             |
| `matchedPolicy` | string                | no       | no       |             |
| `createdAt`     | string (date-time)    | yes      | no       |             |

**Example**

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "tenantUserId": "00000000-0000-0000-0000-000000000000",
  "moduleKey": "string",
  "activityCode": "string",
  "action": "string",
  "decision": "allow",
  "reason": "string",
  "matchedPolicy": "string",
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: DecisionLogListResponse

| Field          | Type                                                    | Required | Nullable | Description                                                                                                                           |
| -------------- | ------------------------------------------------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `decisionLogs` | array of [`DecisionLogEntry`](#schema-decisionlogentry) | yes      | no       |                                                                                                                                       |
| `nextCursor`   | string                                                  | yes      | yes      | Opaque keyset pagination cursor; pass back as the `cursor` query parameter to fetch the next page. `null` when this is the last page. |

**Example**

```json
{
  "decisionLogs": [
    {
      "id": "00000000-0000-0000-0000-000000000000",
      "tenantUserId": "00000000-0000-0000-0000-000000000000",
      "moduleKey": "string",
      "activityCode": "string",
      "action": "string",
      "decision": "allow",
      "reason": "string",
      "matchedPolicy": "string",
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "nextCursor": "string"
}
```

### Schema: EmailHealthReport

| Field               | Type               | Required | Nullable | Description                              |
| ------------------- | ------------------ | -------- | -------- | ---------------------------------------- |
| `queuedCount`       | integer            | yes      | no       |                                          |
| `retryWaitCount`    | integer            | yes      | no       |                                          |
| `failedCount`       | integer            | yes      | no       |                                          |
| `suppressedCount`   | integer            | yes      | no       |                                          |
| `sentLast24hCount`  | integer            | yes      | no       |                                          |
| `hasFailedMessages` | boolean            | yes      | no       |                                          |
| `hasRetryBacklog`   | boolean            | yes      | no       |                                          |
| `isHealthy`         | boolean            | yes      | no       | No failed messages and no retry backlog. |
| `oldestQueuedAt`    | string (date-time) | no       | yes      |                                          |
| `mostRecentSentAt`  | string (date-time) | no       | yes      |                                          |
| `emailEnabled`      | boolean            | yes      | no       |                                          |
| `provider`          | string             | no       | yes      |                                          |

**Example**

```json
{
  "queuedCount": 0,
  "retryWaitCount": 0,
  "failedCount": 0,
  "suppressedCount": 0,
  "sentLast24hCount": 0,
  "hasFailedMessages": false,
  "hasRetryBacklog": false,
  "isHealthy": false,
  "oldestQueuedAt": "2026-01-01T00:00:00.000Z",
  "mostRecentSentAt": "2026-01-01T00:00:00.000Z",
  "emailEnabled": false,
  "provider": "string"
}
```

### Schema: EmailMessageEntry

| Field             | Type                                                                                 | Required | Nullable | Description |
| ----------------- | ------------------------------------------------------------------------------------ | -------- | -------- | ----------- |
| `id`              | string (uuid)                                                                        | yes      | no       |             |
| `correlationId`   | string                                                                               | no       | yes      |             |
| `category`        | string                                                                               | yes      | no       |             |
| `status`          | enum(`queued`, `sending`, `sent`, `failed`, `retry_wait`, `cancelled`, `suppressed`) | yes      | no       |             |
| `priority`        | enum(`low`, `normal`, `high`)                                                        | yes      | no       |             |
| `toAddressMasked` | string                                                                               | yes      | no       |             |
| `subject`         | string                                                                               | yes      | no       |             |
| `retryCount`      | integer                                                                              | yes      | no       |             |
| `lastError`       | string                                                                               | no       | yes      |             |
| `createdAt`       | string (date-time)                                                                   | yes      | no       |             |
| `sentAt`          | string (date-time)                                                                   | no       | yes      |             |

**Example**

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "correlationId": "string",
  "category": "string",
  "status": "queued",
  "priority": "low",
  "toAddressMasked": "string",
  "subject": "string",
  "retryCount": 0,
  "lastError": "string",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "sentAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: EmailMessageListResponse

| Field        | Type                                                      | Required | Nullable | Description                                                                                                                           |
| ------------ | --------------------------------------------------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `messages`   | array of [`EmailMessageEntry`](#schema-emailmessageentry) | yes      | no       |                                                                                                                                       |
| `nextCursor` | string                                                    | yes      | yes      | Opaque keyset pagination cursor; pass back as the `cursor` query parameter to fetch the next page. `null` when this is the last page. |

**Example**

```json
{
  "messages": [
    {
      "id": "00000000-0000-0000-0000-000000000000",
      "correlationId": "string",
      "category": "string",
      "status": "queued",
      "priority": "low",
      "toAddressMasked": "string",
      "subject": "string",
      "retryCount": 0,
      "lastError": "string",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "sentAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "nextCursor": "string"
}
```

### Schema: EmailTemplateItem

| Field              | Type                                                     | Required | Nullable | Description                                                                                                             |
| ------------------ | -------------------------------------------------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `id`               | string (uuid)                                            | yes      | no       |                                                                                                                         |
| `tenantId`         | string (uuid)                                            | yes      | no       |                                                                                                                         |
| `templateKey`      | string                                                   | yes      | no       | Dot-separated category key, e.g. "auth.password_reset" — also the category used for the render-time variable allowlist. |
| `name`             | string                                                   | yes      | no       |                                                                                                                         |
| `subjectTemplate`  | [`LocalizedTemplateText`](#schema-localizedtemplatetext) | yes      | no       |                                                                                                                         |
| `textBodyTemplate` | [`LocalizedTemplateText`](#schema-localizedtemplatetext) | yes      | yes      |                                                                                                                         |
| `htmlBodyTemplate` | [`LocalizedTemplateText`](#schema-localizedtemplatetext) | yes      | yes      |                                                                                                                         |
| `isActive`         | boolean                                                  | yes      | no       |                                                                                                                         |
| `createdBy`        | string (uuid)                                            | yes      | no       |                                                                                                                         |
| `updatedBy`        | string (uuid)                                            | yes      | no       |                                                                                                                         |
| `createdAt`        | string (date-time)                                       | yes      | no       |                                                                                                                         |
| `updatedAt`        | string (date-time)                                       | yes      | no       |                                                                                                                         |
| `deletedAt`        | string (date-time)                                       | yes      | yes      |                                                                                                                         |
| `deletedBy`        | string (uuid)                                            | yes      | yes      |                                                                                                                         |
| `deleteReason`     | string                                                   | yes      | yes      |                                                                                                                         |
| `restoredAt`       | string (date-time)                                       | yes      | yes      |                                                                                                                         |
| `restoredBy`       | string (uuid)                                            | yes      | yes      |                                                                                                                         |

**Example**

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "templateKey": "string",
  "name": "string",
  "subjectTemplate": {
    "en": "Reset your password",
    "id": "Atur ulang kata sandi Anda"
  },
  "textBodyTemplate": {
    "en": "Reset your password",
    "id": "Atur ulang kata sandi Anda"
  },
  "htmlBodyTemplate": {
    "en": "Reset your password",
    "id": "Atur ulang kata sandi Anda"
  },
  "isActive": false,
  "createdBy": "00000000-0000-0000-0000-000000000000",
  "updatedBy": "00000000-0000-0000-0000-000000000000",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "deletedAt": "2026-01-01T00:00:00.000Z",
  "deletedBy": "00000000-0000-0000-0000-000000000000",
  "deleteReason": "string",
  "restoredAt": "2026-01-01T00:00:00.000Z",
  "restoredBy": "00000000-0000-0000-0000-000000000000"
}
```

### Schema: EmailTemplateListResponse

| Field       | Type                                                      | Required | Nullable | Description |
| ----------- | --------------------------------------------------------- | -------- | -------- | ----------- |
| `templates` | array of [`EmailTemplateItem`](#schema-emailtemplateitem) | yes      | no       |             |

**Example**

```json
{
  "templates": [
    {
      "id": "00000000-0000-0000-0000-000000000000",
      "tenantId": "00000000-0000-0000-0000-000000000000",
      "templateKey": "string",
      "name": "string",
      "subjectTemplate": {
        "en": "Reset your password",
        "id": "Atur ulang kata sandi Anda"
      },
      "textBodyTemplate": {
        "en": "Reset your password",
        "id": "Atur ulang kata sandi Anda"
      },
      "htmlBodyTemplate": {
        "en": "Reset your password",
        "id": "Atur ulang kata sandi Anda"
      },
      "isActive": false,
      "createdBy": "00000000-0000-0000-0000-000000000000",
      "updatedBy": "00000000-0000-0000-0000-000000000000",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z",
      "deletedAt": "2026-01-01T00:00:00.000Z",
      "deletedBy": "00000000-0000-0000-0000-000000000000",
      "deleteReason": "string",
      "restoredAt": "2026-01-01T00:00:00.000Z",
      "restoredBy": "00000000-0000-0000-0000-000000000000"
    }
  ]
}
```

### Schema: EmailTemplatePreviewResponse

| Field      | Type   | Required | Nullable | Description |
| ---------- | ------ | -------- | -------- | ----------- |
| `locale`   | string | yes      | no       |             |
| `subject`  | string | yes      | no       |             |
| `textBody` | string | no       | no       |             |
| `htmlBody` | string | no       | no       |             |

**Example**

```json
{
  "locale": "string",
  "subject": "string",
  "textBody": "string",
  "htmlBody": "string"
}
```

### Schema: FinalizeNewsMediaUploadSessionRequest

| Field            | Type   | Required | Nullable | Description                                                                                                                                                                                                      |
| ---------------- | ------ | -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checksumSha256` | string | no       | yes      | Optional. When supplied, compared against the checksum computed server-side from the bytes actually read from R2 — this is a transport-corruption check only, never a substitute for the server-side MIME sniff. |

**Example**

```json
{
  "checksumSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
}
```

### Schema: ForgotPasswordRequest

| Field             | Type   | Required | Nullable | Description                                                                                                                                                                                                             |
| ----------------- | ------ | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loginIdentifier` | string | yes      | no       |                                                                                                                                                                                                                         |
| `turnstileToken`  | string | no       | no       | Cloudflare Turnstile response token (Issue #588). Required only when full-online auth security hardening AND `TURNSTILE_ENABLED=true` are both active — see `LoginRequest`'s `turnstileToken` for the full gating rule. |

**Example**

```json
{
  "loginIdentifier": "string",
  "turnstileToken": "string"
}
```

### Schema: ForgotPasswordResponse

| Field       | Type    | Required | Nullable | Description                                                                |
| ----------- | ------- | -------- | -------- | -------------------------------------------------------------------------- |
| `requested` | boolean | yes      | no       |                                                                            |
| `message`   | string  | yes      | no       | Generic text — never indicates whether loginIdentifier matched an account. |

**Example**

```json
{
  "requested": false,
  "message": "string"
}
```

### Schema: FormDraftItem

| Field          | Type                                               | Required | Nullable | Description |
| -------------- | -------------------------------------------------- | -------- | -------- | ----------- |
| `id`           | string (uuid)                                      | yes      | no       |             |
| `tenantId`     | string (uuid)                                      | yes      | no       |             |
| `moduleKey`    | string                                             | yes      | no       |             |
| `wizardKey`    | string                                             | yes      | no       |             |
| `resourceType` | string                                             | yes      | no       |             |
| `resourceId`   | string                                             | yes      | yes      |             |
| `currentStep`  | string                                             | yes      | no       |             |
| `payload`      | object                                             | yes      | no       |             |
| `status`       | enum(`draft`, `submitted`, `abandoned`, `expired`) | yes      | no       |             |
| `createdBy`    | string (uuid)                                      | yes      | no       |             |
| `updatedBy`    | string (uuid)                                      | yes      | no       |             |
| `submittedBy`  | string (uuid)                                      | yes      | yes      |             |
| `expiresAt`    | string (date-time)                                 | yes      | yes      |             |
| `createdAt`    | string (date-time)                                 | yes      | no       |             |
| `updatedAt`    | string (date-time)                                 | yes      | no       |             |
| `submittedAt`  | string (date-time)                                 | yes      | yes      |             |

**Example**

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "moduleKey": "string",
  "wizardKey": "string",
  "resourceType": "string",
  "resourceId": "string",
  "currentStep": "string",
  "payload": "(operation-specific payload)",
  "status": "draft",
  "createdBy": "00000000-0000-0000-0000-000000000000",
  "updatedBy": "00000000-0000-0000-0000-000000000000",
  "submittedBy": "00000000-0000-0000-0000-000000000000",
  "expiresAt": "2026-01-01T00:00:00.000Z",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "submittedAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: FormDraftListResponse

| Field    | Type                                              | Required | Nullable | Description |
| -------- | ------------------------------------------------- | -------- | -------- | ----------- |
| `drafts` | array of [`FormDraftItem`](#schema-formdraftitem) | yes      | no       |             |

**Example**

```json
{
  "drafts": [
    {
      "id": "00000000-0000-0000-0000-000000000000",
      "tenantId": "00000000-0000-0000-0000-000000000000",
      "moduleKey": "string",
      "wizardKey": "string",
      "resourceType": "string",
      "resourceId": "string",
      "currentStep": "string",
      "payload": "(operation-specific payload)",
      "status": "draft",
      "createdBy": "00000000-0000-0000-0000-000000000000",
      "updatedBy": "00000000-0000-0000-0000-000000000000",
      "submittedBy": "00000000-0000-0000-0000-000000000000",
      "expiresAt": "2026-01-01T00:00:00.000Z",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z",
      "submittedAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

### Schema: GoogleLinkStartResponse

| Field              | Type   | Required | Nullable | Description                                                                                           |
| ------------------ | ------ | -------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `authorizationUrl` | string | yes      | no       | Google's authorization URL — the client navigates itself here (`window.location = authorizationUrl`). |

**Example**

```json
{
  "authorizationUrl": "https://example.com/resource"
}
```

### Schema: GoogleUnlinkResponse

| Field      | Type    | Required | Nullable | Description |
| ---------- | ------- | -------- | -------- | ----------- |
| `unlinked` | boolean | yes      | no       |             |

**Example**

```json
{
  "unlinked": false
}
```

### Schema: HealthResponse

| Field         | Type               | Required | Nullable | Description |
| ------------- | ------------------ | -------- | -------- | ----------- |
| `status`      | enum(`ok`)         | yes      | no       |             |
| `service`     | string             | yes      | no       |             |
| `runtime`     | string             | yes      | no       |             |
| `buildMode`   | string             | yes      | no       |             |
| `moduleCount` | integer            | yes      | no       |             |
| `generatedAt` | string (date-time) | yes      | no       |             |

**Example**

```json
{
  "status": "ok",
  "service": "awcms-mini",
  "runtime": "bun",
  "buildMode": "string",
  "moduleCount": 0,
  "generatedAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: HomepageSectionConfig

Shape depends on sectionType — headline: {postId}; latest_posts: {limit?, categorySlug?}; featured_posts/editor_picks: {postIds: []}; category_grid: {categorySlugs: [], postsPerCategory?}; gallery_block: {mediaObjectIds: [], caption?}. Validated server-side per sectionType (`homepage-section-policy.ts`); every id/slug must already exist for the same tenant (`homepage-section-reference- validation.ts`), and gallery_block's mediaObjectIds must each be a verified R2 media object.

Shape depends on sectionType — headline: {postId}; latest_posts: {limit?, categorySlug?}; featured_posts/editor_picks: {postIds: []}; category_grid: {categorySlugs: [], postsPerCategory?}; gallery_block: {mediaObjectIds: [], caption?}. Validated server-side per sectionType (`homepage-section-policy.ts`); every id/slug must already exist for the same tenant (`homepage-section-reference- validation.ts`), and gallery_block's mediaObjectIds must each be a verified R2 media object.

**Example**

```json
{}
```

### Schema: HomepageSectionCreateRequest

| Field         | Type                                                                                                 | Required | Nullable | Description |
| ------------- | ---------------------------------------------------------------------------------------------------- | -------- | -------- | ----------- |
| `sectionKey`  | string                                                                                               | yes      | no       |             |
| `sectionType` | enum(`headline`, `latest_posts`, `featured_posts`, `editor_picks`, `category_grid`, `gallery_block`) | yes      | no       |             |
| `title`       | string                                                                                               | no       | yes      |             |
| `config`      | [`HomepageSectionConfig`](#schema-homepagesectionconfig)                                             | yes      | no       |             |
| `sortOrder`   | integer                                                                                              | no       | no       |             |
| `isEnabled`   | boolean                                                                                              | no       | no       |             |
| `startsAt`    | string (date-time)                                                                                   | no       | yes      |             |
| `endsAt`      | string (date-time)                                                                                   | no       | yes      |             |

**Example**

```json
{
  "sectionKey": "string",
  "sectionType": "headline",
  "title": "string",
  "config": "(operation-specific payload)",
  "sortOrder": 0,
  "isEnabled": false,
  "startsAt": "2026-01-01T00:00:00.000Z",
  "endsAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: HomepageSectionItem

| Field         | Type                                                                                                 | Required | Nullable | Description |
| ------------- | ---------------------------------------------------------------------------------------------------- | -------- | -------- | ----------- |
| `id`          | string (uuid)                                                                                        | yes      | no       |             |
| `tenantId`    | string (uuid)                                                                                        | yes      | no       |             |
| `sectionKey`  | string                                                                                               | yes      | no       |             |
| `sectionType` | enum(`headline`, `latest_posts`, `featured_posts`, `editor_picks`, `category_grid`, `gallery_block`) | yes      | no       |             |
| `title`       | string                                                                                               | no       | yes      |             |
| `config`      | [`HomepageSectionConfig`](#schema-homepagesectionconfig)                                             | yes      | no       |             |
| `sortOrder`   | integer                                                                                              | yes      | no       |             |
| `isEnabled`   | boolean                                                                                              | yes      | no       |             |
| `startsAt`    | string (date-time)                                                                                   | no       | yes      |             |
| `endsAt`      | string (date-time)                                                                                   | no       | yes      |             |
| `createdAt`   | string (date-time)                                                                                   | yes      | no       |             |
| `updatedAt`   | string (date-time)                                                                                   | yes      | no       |             |

**Example**

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "sectionKey": "string",
  "sectionType": "headline",
  "title": "string",
  "config": "(operation-specific payload)",
  "sortOrder": 0,
  "isEnabled": false,
  "startsAt": "2026-01-01T00:00:00.000Z",
  "endsAt": "2026-01-01T00:00:00.000Z",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: HomepageSectionUpdateRequest

sectionType cannot be changed after creation — omit it, do not send the old or a new value.

| Field       | Type                                                     | Required | Nullable | Description |
| ----------- | -------------------------------------------------------- | -------- | -------- | ----------- |
| `title`     | string                                                   | no       | yes      |             |
| `config`    | [`HomepageSectionConfig`](#schema-homepagesectionconfig) | no       | no       |             |
| `sortOrder` | integer                                                  | no       | no       |             |
| `isEnabled` | boolean                                                  | no       | no       |             |
| `startsAt`  | string (date-time)                                       | no       | yes      |             |
| `endsAt`    | string (date-time)                                       | no       | yes      |             |

**Example**

```json
{
  "title": "string",
  "config": "(operation-specific payload)",
  "sortOrder": 0,
  "isEnabled": false,
  "startsAt": "2026-01-01T00:00:00.000Z",
  "endsAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: JobRegistryEntry

| Field                 | Type    | Required | Nullable | Description                                        |
| --------------------- | ------- | -------- | -------- | -------------------------------------------------- |
| `moduleKey`           | string  | yes      | no       |                                                    |
| `command`             | string  | yes      | no       | Always "bun run <script>" — this repo is Bun-only. |
| `purpose`             | string  | yes      | no       |                                                    |
| `recommendedSchedule` | string  | no       | no       |                                                    |
| `environmentNotes`    | string  | no       | no       |                                                    |
| `safeInOfflineLan`    | boolean | no       | no       |                                                    |

**Example**

```json
{
  "moduleKey": "string",
  "command": "string",
  "purpose": "string",
  "recommendedSchedule": "string",
  "environmentNotes": "string",
  "safeInOfflineLan": false
}
```

### Schema: LocalizedTemplateText

Locale code (2-letter, e.g. "en", "id") to string. Must include an "en" entry.

Locale code (2-letter, e.g. "en", "id") to string. Must include an "en" entry.

**Example**

```json
{
  "en": "Reset your password",
  "id": "Atur ulang kata sandi Anda"
}
```

### Schema: LoginMfaRequiredResponse

`POST /auth/login`'s 401 response shape specifically for `error.code === "MFA_REQUIRED"` (Issue #589) — deliberately NOT the generic `ApiError` shape (`error.details` here is a structured object, not an `ErrorDetail[]` array), since a real payload (`mfaChallengeToken`) must be returned to let the client complete the login via `POST /auth/mfa/totp/verify`.

| Field     | Type                                  | Required | Nullable | Description |
| --------- | ------------------------------------- | -------- | -------- | ----------- |
| `success` | boolean                               | yes      | no       |             |
| `error`   | object                                | yes      | no       |             |
| `meta`    | [`ApiMeta`](#standard-error-envelope) | yes      | no       |             |

**Example**

```json
{
  "success": false,
  "error": {
    "code": "MFA_REQUIRED",
    "message": "string",
    "details": {
      "mfaChallengeToken": "string",
      "expiresAt": "2026-01-01T00:00:00.000Z"
    }
  },
  "meta": {
    "correlationId": "string",
    "requestId": "string"
  }
}
```

### Schema: LoginRequest

| Field             | Type   | Required | Nullable | Description                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------- | ------ | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loginIdentifier` | string | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                                       |
| `password`        | string | yes      | no       |                                                                                                                                                                                                                                                                                                                                                                                       |
| `turnstileToken`  | string | no       | no       | Cloudflare Turnstile response token (Issue #588). Required only when full-online auth security hardening is active (`AUTH_ONLINE_SECURITY_ENABLED=true` and `AUTH_ONLINE_SECURITY_PROFILE=full_online`) AND `TURNSTILE_ENABLED=true` — absent entirely for every local/offline/LAN deployment. Missing when required -> `400 TURNSTILE_REQUIRED`; invalid -> `400 TURNSTILE_INVALID`. |

**Example**

```json
{
  "loginIdentifier": "string",
  "password": "string",
  "turnstileToken": "string"
}
```

### Schema: LoginResponse

| Field       | Type               | Required | Nullable | Description                                             |
| ----------- | ------------------ | -------- | -------- | ------------------------------------------------------- |
| `token`     | string             | yes      | no       | Opaque bearer session token. Shown only once, at login. |
| `expiresAt` | string (date-time) | yes      | no       |                                                         |

**Example**

```json
{
  "token": "string",
  "expiresAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: LogoutResponse

| Field       | Type    | Required | Nullable | Description |
| ----------- | ------- | -------- | -------- | ----------- |
| `loggedOut` | boolean | yes      | no       |             |

**Example**

```json
{
  "loggedOut": false
}
```

### Schema: MeResponse

| Field             | Type                                 | Required | Nullable | Description |
| ----------------- | ------------------------------------ | -------- | -------- | ----------- |
| `identityId`      | string (uuid)                        | yes      | no       |             |
| `loginIdentifier` | string                               | yes      | no       |             |
| `profileId`       | string (uuid)                        | yes      | no       |             |
| `status`          | enum(`active`, `inactive`, `locked`) | yes      | no       |             |
| `lastLoginAt`     | unknown                              | yes      | no       |             |

**Example**

```json
{
  "identityId": "00000000-0000-0000-0000-000000000000",
  "loginIdentifier": "string",
  "profileId": "00000000-0000-0000-0000-000000000000",
  "status": "active",
  "lastLoginAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: MfaChallengeVerifyRequest

| Field               | Type   | Required | Nullable | Description                                                                    |
| ------------------- | ------ | -------- | -------- | ------------------------------------------------------------------------------ |
| `mfaChallengeToken` | string | yes      | no       | From `POST /auth/login`'s `MFA_REQUIRED` response.                             |
| `code`              | string | no       | no       | Current TOTP code — exactly one of `code`/`recoveryCode` is required.          |
| `recoveryCode`      | string | no       | no       | A single-use recovery code — exactly one of `code`/`recoveryCode` is required. |

**Example**

```json
{
  "mfaChallengeToken": "string",
  "code": "string",
  "recoveryCode": "string"
}
```

### Schema: MfaDisableResponse

| Field      | Type    | Required | Nullable | Description |
| ---------- | ------- | -------- | -------- | ----------- |
| `disabled` | boolean | yes      | no       |             |

**Example**

```json
{
  "disabled": false
}
```

### Schema: MfaEnrollStartResponse

| Field        | Type   | Required | Nullable | Description                                                                                                           |
| ------------ | ------ | -------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `secret`     | string | yes      | no       | Base32-encoded TOTP secret, shown ONLY here — manual-entry fallback for authenticator apps that can't scan a QR code. |
| `otpauthUri` | string | yes      | no       | `otpauth://totp/...` URI — render as a QR code for the authenticator app to scan.                                     |

**Example**

```json
{
  "secret": "string",
  "otpauthUri": "string"
}
```

### Schema: MfaEnrollVerifyRequest

| Field  | Type   | Required | Nullable | Description                                   |
| ------ | ------ | -------- | -------- | --------------------------------------------- |
| `code` | string | yes      | no       | Current TOTP code from the authenticator app. |

**Example**

```json
{
  "code": "string"
}
```

### Schema: MfaEnrollVerifyResponse

| Field           | Type            | Required | Nullable | Description                                                                                                                                                                          |
| --------------- | --------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `activated`     | boolean         | yes      | no       |                                                                                                                                                                                      |
| `recoveryCodes` | array of string | yes      | no       | 10 single-use recovery codes, shown exactly once. Store them securely — they cannot be retrieved again (only `recovery-codes/regenerate` can issue a fresh set, invalidating these). |

**Example**

```json
{
  "activated": false,
  "recoveryCodes": ["string"]
}
```

### Schema: MfaRecoveryCodesResponse

| Field           | Type            | Required | Nullable | Description                                                                                                      |
| --------------- | --------------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `recoveryCodes` | array of string | yes      | no       | 10 fresh single-use recovery codes, shown exactly once — every previously issued code stops working immediately. |

**Example**

```json
{
  "recoveryCodes": ["string"]
}
```

### Schema: MfaStatusResponse

| Field         | Type               | Required | Nullable | Description |
| ------------- | ------------------ | -------- | -------- | ----------- |
| `enabled`     | boolean            | yes      | no       |             |
| `factorType`  | enum(`totp`)       | no       | no       |             |
| `activatedAt` | string (date-time) | no       | no       |             |

**Example**

```json
{
  "enabled": false,
  "factorType": "totp",
  "activatedAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: ModuleApiContractInfo

| Field         | Type   | Required | Nullable | Description |
| ------------- | ------ | -------- | -------- | ----------- |
| `openApiPath` | string | yes      | no       |             |
| `basePath`    | string | yes      | no       |             |

**Example**

```json
{
  "openApiPath": "string",
  "basePath": "string"
}
```

### Schema: ModuleCatalogEntry

| Field          | Type                                                                    | Required | Nullable | Description                                                                                                             |
| -------------- | ----------------------------------------------------------------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `moduleKey`    | string                                                                  | yes      | no       |                                                                                                                         |
| `name`         | string                                                                  | yes      | no       |                                                                                                                         |
| `version`      | string                                                                  | yes      | no       |                                                                                                                         |
| `description`  | string                                                                  | yes      | no       |                                                                                                                         |
| `status`       | enum(`active`, `experimental`, `deprecated`, `maintenance`, `disabled`) | yes      | no       |                                                                                                                         |
| `type`         | enum(`base`, `system`, `domain`, `integration`, `derived`)              | no       | yes      |                                                                                                                         |
| `isCore`       | boolean                                                                 | yes      | no       |                                                                                                                         |
| `dependencies` | array of string                                                         | yes      | no       |                                                                                                                         |
| `api`          | [`ModuleApiContractInfo`](#schema-moduleapicontractinfo)                | no       | no       |                                                                                                                         |
| `events`       | [`ModuleEventContractInfo`](#schema-moduleeventcontractinfo)            | no       | no       |                                                                                                                         |
| `lastSyncedAt` | string (date-time)                                                      | yes      | yes      | Null if `bun run modules:sync`/`POST /api/v1/modules/sync` has never been run since this module was registered in code. |

**Example**

```json
{
  "moduleKey": "string",
  "name": "string",
  "version": "string",
  "description": "string",
  "status": "active",
  "type": "base",
  "isCore": false,
  "dependencies": ["string"],
  "api": {
    "openApiPath": "string",
    "basePath": "string"
  },
  "events": {
    "asyncApiPath": "string",
    "publishes": ["string"],
    "subscribes": ["string"]
  },
  "lastSyncedAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: ModuleCatalogListResponse

| Field     | Type                                                        | Required | Nullable | Description |
| --------- | ----------------------------------------------------------- | -------- | -------- | ----------- |
| `modules` | array of [`ModuleCatalogEntry`](#schema-modulecatalogentry) | yes      | no       |             |

**Example**

```json
{
  "modules": [
    {
      "moduleKey": "string",
      "name": "string",
      "version": "string",
      "description": "string",
      "status": "active",
      "type": "base",
      "isCore": false,
      "dependencies": [],
      "api": {
        "openApiPath": "string",
        "basePath": "string"
      },
      "events": {
        "asyncApiPath": "string",
        "publishes": [],
        "subscribes": []
      },
      "lastSyncedAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

### Schema: ModuleEventContractInfo

| Field          | Type            | Required | Nullable | Description |
| -------------- | --------------- | -------- | -------- | ----------- |
| `asyncApiPath` | string          | no       | no       |             |
| `publishes`    | array of string | no       | no       |             |
| `subscribes`   | array of string | no       | no       |             |

**Example**

```json
{
  "asyncApiPath": "string",
  "publishes": ["string"],
  "subscribes": ["string"]
}
```

### Schema: ModuleHealthReport

| Field         | Type                                                  | Required | Nullable | Description |
| ------------- | ----------------------------------------------------- | -------- | -------- | ----------- |
| `moduleKey`   | string                                                | yes      | no       |             |
| `status`      | enum(`healthy`, `degraded`, `failed`, `unknown`)      | yes      | no       |             |
| `signals`     | array of [`ReadinessSignal`](#schema-readinesssignal) | yes      | no       |             |
| `generatedAt` | string (date-time)                                    | yes      | no       |             |

**Example**

```json
{
  "moduleKey": "string",
  "status": "healthy",
  "signals": [
    {
      "name": "string",
      "status": "pass",
      "detail": "string"
    }
  ],
  "generatedAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: ModuleJobsResponse

| Field       | Type                                                    | Required | Nullable | Description |
| ----------- | ------------------------------------------------------- | -------- | -------- | ----------- |
| `moduleKey` | string                                                  | yes      | no       |             |
| `jobs`      | array of [`JobRegistryEntry`](#schema-jobregistryentry) | yes      | no       |             |

**Example**

```json
{
  "moduleKey": "string",
  "jobs": [
    {
      "moduleKey": "string",
      "command": "string",
      "purpose": "string",
      "recommendedSchedule": "string",
      "environmentNotes": "string",
      "safeInOfflineLan": false
    }
  ]
}
```

### Schema: ModulePermissionSyncReport

| Field       | Type                                                          | Required | Nullable | Description |
| ----------- | ------------------------------------------------------------- | -------- | -------- | ----------- |
| `moduleKey` | string                                                        | yes      | no       |             |
| `entries`   | array of [`PermissionSyncEntry`](#schema-permissionsyncentry) | yes      | no       |             |

**Example**

```json
{
  "moduleKey": "string",
  "entries": [
    {
      "moduleKey": "string",
      "activityCode": "string",
      "action": "string",
      "status": "synced",
      "descriptorDescription": "string",
      "catalogDescription": "string"
    }
  ]
}
```

### Schema: ModuleRegistryEntry

| Field          | Type   | Required | Nullable | Description |
| -------------- | ------ | -------- | -------- | ----------- |
| `moduleKey`    | string | yes      | no       |             |
| `activityCode` | string | yes      | no       |             |
| `action`       | string | yes      | no       |             |
| `description`  | string | no       | no       |             |

**Example**

```json
{
  "moduleKey": "string",
  "activityCode": "string",
  "action": "string",
  "description": "string"
}
```

### Schema: ModuleRegistryResponse

| Field     | Type                                                          | Required | Nullable | Description |
| --------- | ------------------------------------------------------------- | -------- | -------- | ----------- |
| `modules` | array of [`ModuleRegistryEntry`](#schema-moduleregistryentry) | yes      | no       |             |

**Example**

```json
{
  "modules": [
    {
      "moduleKey": "string",
      "activityCode": "string",
      "action": "string",
      "description": "string"
    }
  ]
}
```

### Schema: ModuleSettingsView

| Field            | Type               | Required | Nullable | Description                                                                                                |
| ---------------- | ------------------ | -------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `moduleKey`      | string             | yes      | no       |                                                                                                            |
| `schemaVersion`  | integer            | yes      | no       |                                                                                                            |
| `defaults`       | object             | yes      | no       | The module's own code-declared default settings.                                                           |
| `tenantOverride` | object             | yes      | no       | Only the keys this tenant has explicitly set — never includes secret-shaped keys (rejected at write time). |
| `effective`      | object             | yes      | no       | defaults with tenantOverride applied on top.                                                               |
| `updatedAt`      | string (date-time) | yes      | yes      |                                                                                                            |

**Example**

```json
{
  "moduleKey": "string",
  "schemaVersion": 0,
  "defaults": "(operation-specific payload)",
  "tenantOverride": "(operation-specific payload)",
  "effective": "(operation-specific payload)",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: ModuleSyncResponse

| Field       | Type            | Required | Nullable | Description                                                                                                       |
| ----------- | --------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `created`   | array of string | yes      | no       |                                                                                                                   |
| `updated`   | array of string | yes      | no       |                                                                                                                   |
| `unchanged` | array of string | yes      | no       |                                                                                                                   |
| `orphaned`  | array of string | yes      | no       | Module keys present in the database registry but no longer in `listModules()` — marked `disabled`, never deleted. |

**Example**

```json
{
  "created": ["string"],
  "updated": ["string"],
  "unchanged": ["string"],
  "orphaned": ["string"]
}
```

### Schema: ModuleUsageEntry

| Field         | Type    | Required | Nullable | Description |
| ------------- | ------- | -------- | -------- | ----------- |
| `moduleKey`   | string  | yes      | no       |             |
| `moduleName`  | string  | yes      | no       |             |
| `metricLabel` | string  | yes      | no       |             |
| `recordCount` | integer | yes      | no       |             |

**Example**

```json
{
  "moduleKey": "string",
  "moduleName": "string",
  "metricLabel": "string",
  "recordCount": 0
}
```

### Schema: ModuleUsageReportResponse

| Field     | Type                                                    | Required | Nullable | Description |
| --------- | ------------------------------------------------------- | -------- | -------- | ----------- |
| `modules` | array of [`ModuleUsageEntry`](#schema-moduleusageentry) | yes      | no       |             |

**Example**

```json
{
  "modules": [
    {
      "moduleKey": "string",
      "moduleName": "string",
      "metricLabel": "string",
      "recordCount": 0
    }
  ]
}
```

### Schema: NewsMediaObjectItem

| Field               | Type                                                                                                             | Required | Nullable | Description |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- | -------- | -------- | ----------- |
| `id`                | string (uuid)                                                                                                    | yes      | no       |             |
| `tenantId`          | string (uuid)                                                                                                    | yes      | no       |             |
| `moduleKey`         | string                                                                                                           | no       | no       |             |
| `ownerResourceType` | enum(`blog_post`, `blog_page`, `homepage_section`, `gallery_item`, `ad`, `video_thumbnail`, `seo_image`, `null`) | no       | yes      |             |
| `ownerResourceId`   | string (uuid)                                                                                                    | no       | yes      |             |
| `storageDriver`     | enum(`cloudflare_r2`)                                                                                            | no       | no       |             |
| `objectKey`         | string                                                                                                           | yes      | no       |             |
| `originalFilename`  | string                                                                                                           | no       | yes      |             |
| `publicUrl`         | string (uri)                                                                                                     | yes      | no       |             |
| `mimeType`          | string                                                                                                           | yes      | no       |             |
| `sizeBytes`         | integer                                                                                                          | no       | yes      |             |
| `checksumSha256`    | string                                                                                                           | no       | yes      |             |
| `width`             | integer                                                                                                          | no       | yes      |             |
| `height`            | integer                                                                                                          | no       | yes      |             |
| `altText`           | string                                                                                                           | no       | yes      |             |
| `caption`           | string                                                                                                           | no       | yes      |             |
| `status`            | enum(`pending_upload`, `uploaded`, `verified`, `attached`, `orphaned`, `deleted`, `failed`)                      | yes      | no       |             |
| `createdAt`         | string (date-time)                                                                                               | yes      | no       |             |
| `updatedAt`         | string (date-time)                                                                                               | yes      | no       |             |

**Example**

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "moduleKey": "string",
  "ownerResourceType": "blog_post",
  "ownerResourceId": "00000000-0000-0000-0000-000000000000",
  "storageDriver": "cloudflare_r2",
  "objectKey": "string",
  "originalFilename": "string",
  "publicUrl": "https://example.com/resource",
  "mimeType": "string",
  "sizeBytes": 0,
  "checksumSha256": "string",
  "width": 0,
  "height": 0,
  "altText": "string",
  "caption": "string",
  "status": "pending_upload",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: NewsMediaUploadSessionCreated

| Field          | Type               | Required | Nullable | Description                                                                                         |
| -------------- | ------------------ | -------- | -------- | --------------------------------------------------------------------------------------------------- |
| `objectId`     | string (uuid)      | yes      | no       |                                                                                                     |
| `objectKey`    | string             | yes      | no       | Server-generated — news-media/{tenantId}/{yyyy}/{mm}/{uuid}.{ext}. Never derived from client input. |
| `presignedUrl` | string (uri)       | yes      | no       | Short-lived presigned PUT URL scoped to exactly one object key. Never includes raw R2 credentials.  |
| `expiresAt`    | string (date-time) | yes      | no       |                                                                                                     |

**Example**

```json
{
  "objectId": "00000000-0000-0000-0000-000000000000",
  "objectKey": "news-media/3fa85f64-5717-4562-b3fc-2c963f66afa6/2026/07/1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed.jpg",
  "presignedUrl": "https://example.com/resource",
  "expiresAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: ObjectQueueEntry

| Field            | Type                              | Required | Nullable | Description |
| ---------------- | --------------------------------- | -------- | -------- | ----------- |
| `objectQueueId`  | string (uuid)                     | yes      | no       |             |
| `nodeId`         | string (uuid)                     | yes      | no       |             |
| `nodeCode`       | string                            | yes      | no       |             |
| `objectKey`      | string                            | yes      | no       |             |
| `status`         | enum(`pending`, `sent`, `failed`) | yes      | no       |             |
| `retryCount`     | integer                           | yes      | no       |             |
| `nextRetryAt`    | string (date-time)                | no       | yes      |             |
| `lastError`      | string                            | no       | yes      |             |
| `byteSize`       | integer                           | yes      | no       |             |
| `requiresUpload` | boolean                           | yes      | no       |             |
| `uploadedAt`     | string (date-time)                | no       | yes      |             |
| `createdAt`      | string (date-time)                | yes      | no       |             |

**Example**

```json
{
  "objectQueueId": "00000000-0000-0000-0000-000000000000",
  "nodeId": "00000000-0000-0000-0000-000000000000",
  "nodeCode": "string",
  "objectKey": "string",
  "status": "pending",
  "retryCount": 0,
  "nextRetryAt": "2026-01-01T00:00:00.000Z",
  "lastError": "string",
  "byteSize": 0,
  "requiresUpload": false,
  "uploadedAt": "2026-01-01T00:00:00.000Z",
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: ObjectQueueListResponse

| Field        | Type                                                    | Required | Nullable | Description                                                                                                                           |
| ------------ | ------------------------------------------------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `objects`    | array of [`ObjectQueueEntry`](#schema-objectqueueentry) | yes      | no       |                                                                                                                                       |
| `nextCursor` | string                                                  | yes      | yes      | Opaque keyset pagination cursor; pass back as the `cursor` query parameter to fetch the next page. `null` when this is the last page. |

**Example**

```json
{
  "objects": [
    {
      "objectQueueId": "00000000-0000-0000-0000-000000000000",
      "nodeId": "00000000-0000-0000-0000-000000000000",
      "nodeCode": "string",
      "objectKey": "string",
      "status": "pending",
      "retryCount": 0,
      "nextRetryAt": "2026-01-01T00:00:00.000Z",
      "lastError": "string",
      "byteSize": 0,
      "requiresUpload": false,
      "uploadedAt": "2026-01-01T00:00:00.000Z",
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "nextCursor": "string"
}
```

### Schema: ObjectSyncEnqueueRequest

| Field     | Type                                                          | Required | Nullable | Description |
| --------- | ------------------------------------------------------------- | -------- | -------- | ----------- |
| `objects` | array of [`ObjectSyncQueueItem`](#schema-objectsyncqueueitem) | yes      | no       |             |

**Example**

```json
{
  "objects": [
    {
      "objectKey": "string",
      "localPath": "string",
      "checksumSha256": "string",
      "byteSize": 0
    }
  ]
}
```

### Schema: ObjectSyncEnqueueResponse

| Field    | Type    | Required | Nullable | Description |
| -------- | ------- | -------- | -------- | ----------- |
| `queued` | integer | yes      | no       |             |

**Example**

```json
{
  "queued": 0
}
```

### Schema: ObjectSyncQueueItem

| Field            | Type    | Required | Nullable | Description                                        |
| ---------------- | ------- | -------- | -------- | -------------------------------------------------- |
| `objectKey`      | string  | yes      | no       |                                                    |
| `localPath`      | string  | yes      | no       |                                                    |
| `checksumSha256` | string  | yes      | no       | SHA-256 checksum of the local file, lowercase hex. |
| `byteSize`       | integer | yes      | no       |                                                    |

**Example**

```json
{
  "objectKey": "string",
  "localPath": "string",
  "checksumSha256": "string",
  "byteSize": 0
}
```

### Schema: ObjectSyncStatusEntry

| Field            | Type                              | Required | Nullable | Description |
| ---------------- | --------------------------------- | -------- | -------- | ----------- |
| `objectKey`      | string                            | yes      | no       |             |
| `status`         | enum(`pending`, `sent`, `failed`) | yes      | no       |             |
| `retryCount`     | integer                           | yes      | no       |             |
| `nextRetryAt`    | string (date-time)                | no       | no       |             |
| `lastError`      | string                            | no       | no       |             |
| `byteSize`       | integer                           | yes      | no       |             |
| `requiresUpload` | boolean                           | yes      | no       |             |

**Example**

```json
{
  "objectKey": "string",
  "status": "pending",
  "retryCount": 0,
  "nextRetryAt": "2026-01-01T00:00:00.000Z",
  "lastError": "string",
  "byteSize": 0,
  "requiresUpload": false
}
```

### Schema: ObjectSyncStatusResponse

| Field     | Type                                                              | Required | Nullable | Description |
| --------- | ----------------------------------------------------------------- | -------- | -------- | ----------- |
| `objects` | array of [`ObjectSyncStatusEntry`](#schema-objectsyncstatusentry) | yes      | no       |             |

**Example**

```json
{
  "objects": [
    {
      "objectKey": "string",
      "status": "pending",
      "retryCount": 0,
      "nextRetryAt": "2026-01-01T00:00:00.000Z",
      "lastError": "string",
      "byteSize": 0,
      "requiresUpload": false
    }
  ]
}
```

### Schema: PermissionEntry

| Field          | Type          | Required | Nullable | Description                   |
| -------------- | ------------- | -------- | -------- | ----------------------------- |
| `permissionId` | string (uuid) | yes      | no       |                               |
| `moduleKey`    | string        | yes      | no       |                               |
| `activityCode` | string        | yes      | no       |                               |
| `action`       | string        | yes      | no       |                               |
| `key`          | string        | yes      | no       | moduleKey.activityCode.action |
| `description`  | string        | no       | yes      |                               |

**Example**

```json
{
  "permissionId": "00000000-0000-0000-0000-000000000000",
  "moduleKey": "string",
  "activityCode": "string",
  "action": "string",
  "key": "string",
  "description": "string"
}
```

### Schema: PermissionListResponse

| Field         | Type                                                  | Required | Nullable | Description |
| ------------- | ----------------------------------------------------- | -------- | -------- | ----------- |
| `permissions` | array of [`PermissionEntry`](#schema-permissionentry) | yes      | no       |             |

**Example**

```json
{
  "permissions": [
    {
      "permissionId": "00000000-0000-0000-0000-000000000000",
      "moduleKey": "string",
      "activityCode": "string",
      "action": "string",
      "key": "string",
      "description": "string"
    }
  ]
}
```

### Schema: PermissionSyncEntry

| Field                   | Type                                                            | Required | Nullable | Description                                                                                   |
| ----------------------- | --------------------------------------------------------------- | -------- | -------- | --------------------------------------------------------------------------------------------- |
| `moduleKey`             | string                                                          | yes      | no       |                                                                                               |
| `activityCode`          | string                                                          | yes      | no       |                                                                                               |
| `action`                | string                                                          | yes      | no       |                                                                                               |
| `status`                | enum(`synced`, `missing`, `orphaned`, `mismatched_description`) | yes      | no       |                                                                                               |
| `descriptorDescription` | string                                                          | yes      | yes      | Description declared in the module's own code descriptor; `null` when `status` is `orphaned`. |
| `catalogDescription`    | string                                                          | yes      | yes      | Description stored in `awcms_mini_permissions`; `null` when `status` is `missing`.            |

**Example**

```json
{
  "moduleKey": "string",
  "activityCode": "string",
  "action": "string",
  "status": "synced",
  "descriptorDescription": "string",
  "catalogDescription": "string"
}
```

### Schema: ProfileDeleteRequest

| Field    | Type   | Required | Nullable | Description                                               |
| -------- | ------ | -------- | -------- | --------------------------------------------------------- |
| `reason` | string | yes      | no       | Audit-safe reason for soft delete; becomes delete_reason. |

**Example**

```json
{
  "reason": "string"
}
```

### Schema: ProfileLifecycleResponse

| Field    | Type                                  | Required | Nullable | Description |
| -------- | ------------------------------------- | -------- | -------- | ----------- |
| `id`     | string (uuid)                         | yes      | no       |             |
| `status` | enum(`deleted`, `restored`, `purged`) | yes      | no       |             |

**Example**

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "status": "deleted"
}
```

### Schema: ReadinessSignal

| Field    | Type                                   | Required | Nullable | Description                                                                            |
| -------- | -------------------------------------- | -------- | -------- | -------------------------------------------------------------------------------------- |
| `name`   | string                                 | yes      | no       |                                                                                        |
| `status` | enum(`pass`, `fail`, `not_applicable`) | yes      | no       |                                                                                        |
| `detail` | string                                 | no       | no       | Safe, generic text only — never a raw error message, stack trace, or env/secret value. |

**Example**

```json
{
  "name": "string",
  "status": "pass",
  "detail": "string"
}
```

### Schema: ResetPasswordRequest

| Field            | Type   | Required | Nullable | Description                                                                                                                                                                                                             |
| ---------------- | ------ | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `token`          | string | yes      | no       |                                                                                                                                                                                                                         |
| `newPassword`    | string | yes      | no       |                                                                                                                                                                                                                         |
| `turnstileToken` | string | no       | no       | Cloudflare Turnstile response token (Issue #588). Required only when full-online auth security hardening AND `TURNSTILE_ENABLED=true` are both active — see `LoginRequest`'s `turnstileToken` for the full gating rule. |

**Example**

```json
{
  "token": "string",
  "newPassword": "string",
  "turnstileToken": "string"
}
```

### Schema: ResetPasswordResponse

| Field   | Type    | Required | Nullable | Description |
| ------- | ------- | -------- | -------- | ----------- |
| `reset` | boolean | yes      | no       |             |

**Example**

```json
{
  "reset": true
}
```

### Schema: RoleDeleteRequest

| Field    | Type   | Required | Nullable | Description                                               |
| -------- | ------ | -------- | -------- | --------------------------------------------------------- |
| `reason` | string | yes      | no       | Audit-safe reason for soft delete; becomes delete_reason. |

**Example**

```json
{
  "reason": "string"
}
```

### Schema: RoleListEntry

| Field               | Type                   | Required | Nullable | Description                                                                                    |
| ------------------- | ---------------------- | -------- | -------- | ---------------------------------------------------------------------------------------------- |
| `roleId`            | string (uuid)          | yes      | no       |                                                                                                |
| `roleCode`          | string                 | yes      | no       |                                                                                                |
| `roleName`          | string                 | yes      | no       |                                                                                                |
| `isSystem`          | boolean                | yes      | no       | System roles (seeded at setup, e.g. owner) cannot have their permissions edited or be deleted. |
| `permissionIds`     | array of string (uuid) | yes      | no       |                                                                                                |
| `assignedUserCount` | integer                | yes      | no       |                                                                                                |
| `createdAt`         | string (date-time)     | yes      | no       |                                                                                                |

**Example**

```json
{
  "roleId": "00000000-0000-0000-0000-000000000000",
  "roleCode": "string",
  "roleName": "string",
  "isSystem": false,
  "permissionIds": ["00000000-0000-0000-0000-000000000000"],
  "assignedUserCount": 0,
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: RoleListResponse

| Field   | Type                                              | Required | Nullable | Description |
| ------- | ------------------------------------------------- | -------- | -------- | ----------- |
| `roles` | array of [`RoleListEntry`](#schema-rolelistentry) | yes      | no       |             |

**Example**

```json
{
  "roles": [
    {
      "roleId": "00000000-0000-0000-0000-000000000000",
      "roleCode": "string",
      "roleName": "string",
      "isSystem": false,
      "permissionIds": [],
      "assignedUserCount": 0,
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

### Schema: RoleSummary

| Field      | Type          | Required | Nullable | Description |
| ---------- | ------------- | -------- | -------- | ----------- |
| `roleId`   | string (uuid) | yes      | no       |             |
| `roleCode` | string        | yes      | no       |             |
| `roleName` | string        | yes      | no       |             |

**Example**

```json
{
  "roleId": "00000000-0000-0000-0000-000000000000",
  "roleCode": "string",
  "roleName": "string"
}
```

### Schema: ScheduleBlogPostRequest

| Field         | Type               | Required | Nullable | Description            |
| ------------- | ------------------ | -------- | -------- | ---------------------- |
| `scheduledAt` | string (date-time) | yes      | no       | Must be in the future. |

**Example**

```json
{
  "scheduledAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: SetupInitializeRequest

| Field                  | Type   | Required | Nullable | Description                                                                                                                                                                                                             |
| ---------------------- | ------ | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenantCode`           | string | yes      | no       |                                                                                                                                                                                                                         |
| `tenantName`           | string | yes      | no       |                                                                                                                                                                                                                         |
| `officeCode`           | string | yes      | no       |                                                                                                                                                                                                                         |
| `officeName`           | string | yes      | no       |                                                                                                                                                                                                                         |
| `ownerLoginIdentifier` | string | yes      | no       |                                                                                                                                                                                                                         |
| `ownerPassword`        | string | yes      | no       |                                                                                                                                                                                                                         |
| `ownerDisplayName`     | string | yes      | no       |                                                                                                                                                                                                                         |
| `turnstileToken`       | string | no       | no       | Cloudflare Turnstile response token (Issue #588). Required only when full-online auth security hardening AND `TURNSTILE_ENABLED=true` are both active — see `LoginRequest`'s `turnstileToken` for the full gating rule. |

**Example**

```json
{
  "tenantCode": "string",
  "tenantName": "string",
  "officeCode": "string",
  "officeName": "string",
  "ownerLoginIdentifier": "string",
  "ownerPassword": "string",
  "ownerDisplayName": "string",
  "turnstileToken": "string"
}
```

### Schema: SetupInitializeResponse

| Field               | Type          | Required | Nullable | Description |
| ------------------- | ------------- | -------- | -------- | ----------- |
| `tenantId`          | string (uuid) | yes      | no       |             |
| `officeId`          | string (uuid) | yes      | no       |             |
| `ownerProfileId`    | string (uuid) | yes      | no       |             |
| `ownerIdentityId`   | string (uuid) | yes      | no       |             |
| `ownerTenantUserId` | string (uuid) | yes      | no       |             |
| `ownerRoleId`       | string (uuid) | yes      | no       |             |

**Example**

```json
{
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "officeId": "00000000-0000-0000-0000-000000000000",
  "ownerProfileId": "00000000-0000-0000-0000-000000000000",
  "ownerIdentityId": "00000000-0000-0000-0000-000000000000",
  "ownerTenantUserId": "00000000-0000-0000-0000-000000000000",
  "ownerRoleId": "00000000-0000-0000-0000-000000000000"
}
```

### Schema: SetupStatusResponse

| Field      | Type               | Required | Nullable | Description |
| ---------- | ------------------ | -------- | -------- | ----------- |
| `locked`   | boolean            | yes      | no       |             |
| `tenantId` | string (uuid)      | no       | no       |             |
| `lockedAt` | string (date-time) | no       | no       |             |

**Example**

```json
{
  "locked": false,
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "lockedAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: SsoLinkStartResponse

| Field              | Type   | Required | Nullable | Description                                                                                                                   |
| ------------------ | ------ | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `authorizationUrl` | string | yes      | no       | The tenant-configured provider's authorization URL — the client navigates itself here (`window.location = authorizationUrl`). |

**Example**

```json
{
  "authorizationUrl": "https://example.com/resource"
}
```

### Schema: SsoUnlinkResponse

| Field      | Type    | Required | Nullable | Description |
| ---------- | ------- | -------- | -------- | ----------- |
| `unlinked` | boolean | yes      | no       |             |

**Example**

```json
{
  "unlinked": false
}
```

### Schema: SuppressionCreateRequest

| Field       | Type                                                    | Required | Nullable | Description |
| ----------- | ------------------------------------------------------- | -------- | -------- | ----------- |
| `recipient` | string (email)                                          | yes      | no       |             |
| `reason`    | enum(`bounced`, `complained`, `manual`, `unsubscribed`) | yes      | no       |             |

**Example**

```json
{
  "recipient": "string",
  "reason": "bounced"
}
```

### Schema: SuppressionCreateResponse

Either the created entry, or `{ "alreadySuppressed": true }` if the recipient was already on the list (idempotent no-op).

Either the created entry, or `{ "alreadySuppressed": true }` if the recipient was already on the list (idempotent no-op).

**Example**

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "recipientMasked": "string",
  "reason": "bounced",
  "createdBy": "00000000-0000-0000-0000-000000000000",
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: SuppressionEntry

| Field             | Type                                                    | Required | Nullable | Description |
| ----------------- | ------------------------------------------------------- | -------- | -------- | ----------- |
| `id`              | string (uuid)                                           | yes      | no       |             |
| `recipientMasked` | string                                                  | yes      | no       |             |
| `reason`          | enum(`bounced`, `complained`, `manual`, `unsubscribed`) | yes      | no       |             |
| `createdBy`       | string (uuid)                                           | no       | yes      |             |
| `createdAt`       | string (date-time)                                      | yes      | no       |             |

**Example**

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "recipientMasked": "string",
  "reason": "bounced",
  "createdBy": "00000000-0000-0000-0000-000000000000",
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: SuppressionListResponse

| Field     | Type                                                    | Required | Nullable | Description |
| --------- | ------------------------------------------------------- | -------- | -------- | ----------- |
| `entries` | array of [`SuppressionEntry`](#schema-suppressionentry) | yes      | no       |             |

**Example**

```json
{
  "entries": [
    {
      "id": "00000000-0000-0000-0000-000000000000",
      "recipientMasked": "string",
      "reason": "bounced",
      "createdBy": "00000000-0000-0000-0000-000000000000",
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

### Schema: SyncConflictEntry

| Field            | Type                                               | Required | Nullable | Description                                    |
| ---------------- | -------------------------------------------------- | -------- | -------- | ---------------------------------------------- |
| `id`             | string (uuid)                                      | yes      | no       |                                                |
| `nodeId`         | string (uuid)                                      | yes      | no       |                                                |
| `batchId`        | string                                             | yes      | no       |                                                |
| `aggregateType`  | string                                             | yes      | no       |                                                |
| `aggregateId`    | string (uuid)                                      | yes      | no       |                                                |
| `conflictType`   | enum(`version_mismatch`, `missing_base_version`)   | yes      | no       |                                                |
| `payload`        | unknown                                            | yes      | no       | The event payload that triggered the conflict. |
| `status`         | enum(`open`, `resolved`)                           | yes      | no       |                                                |
| `resolution`     | enum(`accept_incoming`, `keep_existing`, `manual`) | no       | no       |                                                |
| `resolutionNote` | string                                             | no       | no       |                                                |
| `resolvedBy`     | string (uuid)                                      | no       | no       |                                                |
| `resolvedAt`     | string (date-time)                                 | no       | no       |                                                |
| `createdAt`      | string (date-time)                                 | yes      | no       |                                                |

**Example**

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "nodeId": "00000000-0000-0000-0000-000000000000",
  "batchId": "string",
  "aggregateType": "string",
  "aggregateId": "00000000-0000-0000-0000-000000000000",
  "conflictType": "version_mismatch",
  "payload": null,
  "status": "open",
  "resolution": "accept_incoming",
  "resolutionNote": "string",
  "resolvedBy": "00000000-0000-0000-0000-000000000000",
  "resolvedAt": "2026-01-01T00:00:00.000Z",
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: SyncConflictListResponse

| Field       | Type                                                      | Required | Nullable | Description |
| ----------- | --------------------------------------------------------- | -------- | -------- | ----------- |
| `conflicts` | array of [`SyncConflictEntry`](#schema-syncconflictentry) | yes      | no       |             |

**Example**

```json
{
  "conflicts": [
    {
      "id": "00000000-0000-0000-0000-000000000000",
      "nodeId": "00000000-0000-0000-0000-000000000000",
      "batchId": "string",
      "aggregateType": "string",
      "aggregateId": "00000000-0000-0000-0000-000000000000",
      "conflictType": "version_mismatch",
      "payload": null,
      "status": "open",
      "resolution": "accept_incoming",
      "resolutionNote": "string",
      "resolvedBy": "00000000-0000-0000-0000-000000000000",
      "resolvedAt": "2026-01-01T00:00:00.000Z",
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

### Schema: SyncConflictResolveRequest

| Field        | Type                                               | Required | Nullable | Description |
| ------------ | -------------------------------------------------- | -------- | -------- | ----------- |
| `resolution` | enum(`accept_incoming`, `keep_existing`, `manual`) | yes      | no       |             |
| `note`       | string                                             | no       | no       |             |

**Example**

```json
{
  "resolution": "accept_incoming",
  "note": "string"
}
```

### Schema: SyncConflictResolveResponse

| Field        | Type                                               | Required | Nullable | Description |
| ------------ | -------------------------------------------------- | -------- | -------- | ----------- |
| `id`         | string (uuid)                                      | yes      | no       |             |
| `status`     | string                                             | yes      | no       |             |
| `resolution` | enum(`accept_incoming`, `keep_existing`, `manual`) | yes      | no       |             |

**Example**

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "status": "resolved",
  "resolution": "accept_incoming"
}
```

### Schema: SyncHealthReport

| Field                | Type               | Required | Nullable | Description                                                      |
| -------------------- | ------------------ | -------- | -------- | ---------------------------------------------------------------- |
| `totalNodeCount`     | integer            | yes      | no       |                                                                  |
| `activeNodeCount`    | integer            | yes      | no       |                                                                  |
| `openConflictCount`  | integer            | yes      | no       |                                                                  |
| `pendingObjectCount` | integer            | yes      | no       |                                                                  |
| `failedObjectCount`  | integer            | yes      | no       |                                                                  |
| `hasOpenConflicts`   | boolean            | yes      | no       |                                                                  |
| `hasFailedObjects`   | boolean            | yes      | no       |                                                                  |
| `isHealthy`          | boolean            | yes      | no       | activeNodeCount > 0 and no open conflicts and no failed objects. |
| `mostRecentPushedAt` | string (date-time) | no       | yes      |                                                                  |
| `mostRecentPulledAt` | string (date-time) | no       | yes      |                                                                  |

**Example**

```json
{
  "totalNodeCount": 0,
  "activeNodeCount": 0,
  "openConflictCount": 0,
  "pendingObjectCount": 0,
  "failedObjectCount": 0,
  "hasOpenConflicts": false,
  "hasFailedObjects": false,
  "isHealthy": false,
  "mostRecentPushedAt": "2026-01-01T00:00:00.000Z",
  "mostRecentPulledAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: SyncNodeEntry

| Field              | Type                       | Required | Nullable | Description |
| ------------------ | -------------------------- | -------- | -------- | ----------- |
| `nodeId`           | string (uuid)              | yes      | no       |             |
| `nodeCode`         | string                     | yes      | no       |             |
| `nodeName`         | string                     | yes      | no       |             |
| `status`           | enum(`active`, `inactive`) | yes      | no       |             |
| `lastPushedAt`     | string (date-time)         | no       | yes      |             |
| `lastPulledAt`     | string (date-time)         | no       | yes      |             |
| `lastPullSequence` | integer                    | yes      | no       |             |
| `createdAt`        | string (date-time)         | yes      | no       |             |

**Example**

```json
{
  "nodeId": "00000000-0000-0000-0000-000000000000",
  "nodeCode": "string",
  "nodeName": "string",
  "status": "active",
  "lastPushedAt": "2026-01-01T00:00:00.000Z",
  "lastPulledAt": "2026-01-01T00:00:00.000Z",
  "lastPullSequence": 0,
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: SyncNodeListResponse

| Field   | Type                                              | Required | Nullable | Description |
| ------- | ------------------------------------------------- | -------- | -------- | ----------- |
| `nodes` | array of [`SyncNodeEntry`](#schema-syncnodeentry) | yes      | no       |             |

**Example**

```json
{
  "nodes": [
    {
      "nodeId": "00000000-0000-0000-0000-000000000000",
      "nodeCode": "string",
      "nodeName": "string",
      "status": "active",
      "lastPushedAt": "2026-01-01T00:00:00.000Z",
      "lastPulledAt": "2026-01-01T00:00:00.000Z",
      "lastPullSequence": 0,
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

### Schema: SyncPulledEvent

| Field           | Type               | Required | Nullable | Description                               |
| --------------- | ------------------ | -------- | -------- | ----------------------------------------- |
| `sequence`      | integer            | yes      | no       |                                           |
| `eventType`     | string             | yes      | no       |                                           |
| `aggregateType` | string             | yes      | no       |                                           |
| `aggregateId`   | string (uuid)      | no       | no       |                                           |
| `payload`       | unknown            | yes      | no       | Event payload; shape is producer-defined. |
| `createdAt`     | string (date-time) | yes      | no       |                                           |

**Example**

```json
{
  "sequence": 0,
  "eventType": "string",
  "aggregateType": "string",
  "aggregateId": "00000000-0000-0000-0000-000000000000",
  "payload": null,
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: SyncPullRequest

| Field   | Type    | Required | Nullable | Description |
| ------- | ------- | -------- | -------- | ----------- |
| `limit` | integer | no       | no       |             |

**Example**

```json
{
  "limit": 1
}
```

### Schema: SyncPullResponse

| Field        | Type                                                  | Required | Nullable | Description |
| ------------ | ----------------------------------------------------- | -------- | -------- | ----------- |
| `events`     | array of [`SyncPulledEvent`](#schema-syncpulledevent) | yes      | no       |             |
| `checkpoint` | integer                                               | yes      | no       |             |
| `hasMore`    | boolean                                               | yes      | no       |             |

**Example**

```json
{
  "events": [
    {
      "sequence": 0,
      "eventType": "string",
      "aggregateType": "string",
      "aggregateId": "00000000-0000-0000-0000-000000000000",
      "payload": null,
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "checkpoint": 0,
  "hasMore": false
}
```

### Schema: SyncPushEvent

| Field           | Type          | Required | Nullable | Description                                                                                                                                                                               |
| --------------- | ------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventType`     | string        | yes      | no       |                                                                                                                                                                                           |
| `aggregateType` | string        | yes      | no       |                                                                                                                                                                                           |
| `aggregateId`   | string (uuid) | no       | no       |                                                                                                                                                                                           |
| `baseVersion`   | integer       | no       | no       | The aggregate version this event was based on. Required once the aggregate has any history; a mismatch against the server's current version is recorded as a conflict instead of applied. |
| `payload`       | unknown       | yes      | no       | Event payload; shape is producer-defined.                                                                                                                                                 |

**Example**

```json
{
  "eventType": "string",
  "aggregateType": "string",
  "aggregateId": "00000000-0000-0000-0000-000000000000",
  "baseVersion": 0,
  "payload": null
}
```

### Schema: SyncPushRequest

| Field     | Type                                              | Required | Nullable | Description                                     |
| --------- | ------------------------------------------------- | -------- | -------- | ----------------------------------------------- |
| `batchId` | string                                            | yes      | no       | Client-supplied idempotency key for this batch. |
| `events`  | array of [`SyncPushEvent`](#schema-syncpushevent) | yes      | no       |                                                 |

**Example**

```json
{
  "batchId": "string",
  "events": [
    {
      "eventType": "string",
      "aggregateType": "string",
      "aggregateId": "00000000-0000-0000-0000-000000000000",
      "baseVersion": 0,
      "payload": null
    }
  ]
}
```

### Schema: SyncPushResponse

| Field        | Type    | Required | Nullable | Description                                                             |
| ------------ | ------- | -------- | -------- | ----------------------------------------------------------------------- |
| `batchId`    | string  | yes      | no       |                                                                         |
| `accepted`   | integer | yes      | no       |                                                                         |
| `conflicted` | integer | yes      | no       | Number of events recorded as conflicts instead of applied.              |
| `duplicate`  | boolean | yes      | no       | True if this batchId was already processed; no events were reprocessed. |

**Example**

```json
{
  "batchId": "string",
  "accepted": 0,
  "conflicted": 0,
  "duplicate": false
}
```

### Schema: SyncStatusResponse

| Field          | Type                       | Required | Nullable | Description |
| -------------- | -------------------------- | -------- | -------- | ----------- |
| `nodeCode`     | string                     | yes      | no       |             |
| `status`       | enum(`active`, `inactive`) | yes      | no       |             |
| `lastPushedAt` | string (date-time)         | no       | no       |             |
| `lastPulledAt` | string (date-time)         | no       | no       |             |
| `checkpoint`   | integer                    | yes      | no       |             |

**Example**

```json
{
  "nodeCode": "string",
  "status": "active",
  "lastPushedAt": "2026-01-01T00:00:00.000Z",
  "lastPulledAt": "2026-01-01T00:00:00.000Z",
  "checkpoint": 0
}
```

### Schema: TenantActivityReport

| Field               | Type               | Required | Nullable | Description |
| ------------------- | ------------------ | -------- | -------- | ----------- |
| `tenantName`        | string             | yes      | no       |             |
| `tenantStatus`      | string             | yes      | no       |             |
| `tenantCreatedAt`   | string (date-time) | yes      | no       |             |
| `activeUserCount`   | integer            | yes      | no       |             |
| `activeOfficeCount` | integer            | yes      | no       |             |
| `mostRecentLoginAt` | string (date-time) | no       | yes      |             |

**Example**

```json
{
  "tenantName": "string",
  "tenantStatus": "string",
  "tenantCreatedAt": "2026-01-01T00:00:00.000Z",
  "activeUserCount": 0,
  "activeOfficeCount": 0,
  "mostRecentLoginAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: TenantAuthPolicyView

| Field                   | Type                   | Required | Nullable | Description                                  |
| ----------------------- | ---------------------- | -------- | -------- | -------------------------------------------- |
| `tenantId`              | string (uuid)          | yes      | no       |                                              |
| `passwordLoginEnabled`  | boolean                | yes      | no       |                                              |
| `ssoEnabled`            | boolean                | yes      | no       |                                              |
| `ssoRequired`           | boolean                | yes      | no       |                                              |
| `autoLinkVerifiedEmail` | boolean                | yes      | no       |                                              |
| `allowedEmailDomains`   | array of string        | yes      | no       |                                              |
| `breakGlassIdentityIds` | array of string (uuid) | yes      | no       |                                              |
| `mfaRequired`           | boolean                | yes      | no       | Reserved for future compatibility with Issue |
| `updatedAt`             | string (date-time)     | yes      | yes      |                                              |

**Example**

```json
{
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "passwordLoginEnabled": false,
  "ssoEnabled": false,
  "ssoRequired": false,
  "autoLinkVerifiedEmail": false,
  "allowedEmailDomains": ["user@example.com"],
  "breakGlassIdentityIds": ["00000000-0000-0000-0000-000000000000"],
  "mfaRequired": false,
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: TenantDomainItem

Never includes verification_token_hash (an internal bearer-token hash) or any DNS provider secret — neither is ever returned by this API (Issue #562 acceptance criteria).

| Field                     | Type                                                          | Required | Nullable | Description |
| ------------------------- | ------------------------------------------------------------- | -------- | -------- | ----------- |
| `id`                      | string (uuid)                                                 | yes      | no       |             |
| `tenantId`                | string (uuid)                                                 | yes      | no       |             |
| `hostname`                | string                                                        | yes      | no       |             |
| `normalizedHostname`      | string                                                        | yes      | no       |             |
| `domainType`              | enum(`subdomain`, `custom_domain`)                            | yes      | no       |             |
| `routeMode`               | enum(`canonical`, `legacy_blog`)                              | yes      | no       |             |
| `status`                  | enum(`pending_verification`, `active`, `suspended`, `failed`) | yes      | no       |             |
| `isPrimary`               | boolean                                                       | yes      | no       |             |
| `redirectToPrimary`       | boolean                                                       | yes      | no       |             |
| `verificationMethod`      | enum(`dns_txt`, `dns_cname`, `file`, `manual`)                | yes      | yes      |             |
| `verificationRecordName`  | string                                                        | yes      | yes      |             |
| `verificationRecordValue` | string                                                        | yes      | yes      |             |
| `verifiedAt`              | string (date-time)                                            | yes      | yes      |             |
| `lastCheckedAt`           | string (date-time)                                            | yes      | yes      |             |
| `createdAt`               | string (date-time)                                            | yes      | no       |             |
| `updatedAt`               | string (date-time)                                            | yes      | no       |             |
| `createdBy`               | string (uuid)                                                 | yes      | yes      |             |
| `updatedBy`               | string (uuid)                                                 | yes      | yes      |             |

**Example**

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "hostname": "tenant.example.com",
  "normalizedHostname": "tenant.example.com",
  "domainType": "subdomain",
  "routeMode": "canonical",
  "status": "pending_verification",
  "isPrimary": false,
  "redirectToPrimary": false,
  "verificationMethod": "dns_txt",
  "verificationRecordName": "string",
  "verificationRecordValue": "string",
  "verifiedAt": "2026-01-01T00:00:00.000Z",
  "lastCheckedAt": "2026-01-01T00:00:00.000Z",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "createdBy": "00000000-0000-0000-0000-000000000000",
  "updatedBy": "00000000-0000-0000-0000-000000000000"
}
```

### Schema: TenantDomainListResponse

| Field        | Type                                                    | Required | Nullable | Description                                                                                                                           |
| ------------ | ------------------------------------------------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `domains`    | array of [`TenantDomainItem`](#schema-tenantdomainitem) | yes      | no       |                                                                                                                                       |
| `nextCursor` | string                                                  | yes      | yes      | Opaque keyset pagination cursor; pass back as the `cursor` query parameter to fetch the next page. `null` when this is the last page. |

**Example**

```json
{
  "domains": [
    {
      "id": "00000000-0000-0000-0000-000000000000",
      "tenantId": "00000000-0000-0000-0000-000000000000",
      "hostname": "tenant.example.com",
      "normalizedHostname": "tenant.example.com",
      "domainType": "subdomain",
      "routeMode": "canonical",
      "status": "pending_verification",
      "isPrimary": false,
      "redirectToPrimary": false,
      "verificationMethod": "dns_txt",
      "verificationRecordName": "string",
      "verificationRecordValue": "string",
      "verifiedAt": "2026-01-01T00:00:00.000Z",
      "lastCheckedAt": "2026-01-01T00:00:00.000Z",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z",
      "createdBy": "00000000-0000-0000-0000-000000000000",
      "updatedBy": "00000000-0000-0000-0000-000000000000"
    }
  ],
  "nextCursor": "string"
}
```

### Schema: TenantModuleEntry

| Field           | Type               | Required | Nullable | Description |
| --------------- | ------------------ | -------- | -------- | ----------- |
| `moduleKey`     | string             | yes      | no       |             |
| `name`          | string             | yes      | no       |             |
| `version`       | string             | yes      | no       |             |
| `isCore`        | boolean            | yes      | no       |             |
| `tenantEnabled` | boolean            | yes      | no       |             |
| `enabledAt`     | string (date-time) | yes      | yes      |             |
| `disabledAt`    | string (date-time) | yes      | yes      |             |
| `disableReason` | string             | yes      | yes      |             |

**Example**

```json
{
  "moduleKey": "string",
  "name": "string",
  "version": "string",
  "isCore": false,
  "tenantEnabled": false,
  "enabledAt": "2026-01-01T00:00:00.000Z",
  "disabledAt": "2026-01-01T00:00:00.000Z",
  "disableReason": "string"
}
```

### Schema: TenantModuleListResponse

| Field     | Type                                                      | Required | Nullable | Description |
| --------- | --------------------------------------------------------- | -------- | -------- | ----------- |
| `modules` | array of [`TenantModuleEntry`](#schema-tenantmoduleentry) | yes      | no       |             |

**Example**

```json
{
  "modules": [
    {
      "moduleKey": "string",
      "name": "string",
      "version": "string",
      "isCore": false,
      "tenantEnabled": false,
      "enabledAt": "2026-01-01T00:00:00.000Z",
      "disabledAt": "2026-01-01T00:00:00.000Z",
      "disableReason": "string"
    }
  ]
}
```

### Schema: TenantModuleMutationResponse

| Field           | Type    | Required | Nullable | Description |
| --------------- | ------- | -------- | -------- | ----------- |
| `moduleKey`     | string  | yes      | no       |             |
| `tenantEnabled` | boolean | yes      | no       |             |

**Example**

```json
{
  "moduleKey": "string",
  "tenantEnabled": false
}
```

### Schema: TenantSettingsResponse

| Field           | Type                            | Required | Nullable | Description |
| --------------- | ------------------------------- | -------- | -------- | ----------- |
| `tenantId`      | string (uuid)                   | yes      | no       |             |
| `tenantName`    | string                          | yes      | no       |             |
| `legalName`     | string                          | no       | yes      |             |
| `defaultLocale` | enum(`id`, `en`, `ms`, `ar`)    | yes      | no       |             |
| `defaultTheme`  | enum(`light`, `dark`, `system`) | yes      | no       |             |
| `timezone`      | string                          | yes      | no       |             |
| `featureFlags`  | object                          | yes      | no       |             |

**Example**

```json
{
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "tenantName": "string",
  "legalName": "string",
  "defaultLocale": "id",
  "defaultTheme": "light",
  "timezone": "string",
  "featureFlags": "(operation-specific payload)"
}
```

### Schema: TenantUserEntry

| Field             | Type                                          | Required | Nullable | Description |
| ----------------- | --------------------------------------------- | -------- | -------- | ----------- |
| `tenantUserId`    | string (uuid)                                 | yes      | no       |             |
| `identityId`      | string (uuid)                                 | yes      | no       |             |
| `profileId`       | string (uuid)                                 | yes      | no       |             |
| `displayName`     | string                                        | yes      | no       |             |
| `loginIdentifier` | string                                        | yes      | no       |             |
| `status`          | enum(`active`, `inactive`)                    | yes      | no       |             |
| `identityStatus`  | enum(`active`, `inactive`, `locked`)          | yes      | no       |             |
| `lastLoginAt`     | string (date-time)                            | no       | yes      |             |
| `roles`           | array of [`RoleSummary`](#schema-rolesummary) | yes      | no       |             |

**Example**

```json
{
  "tenantUserId": "00000000-0000-0000-0000-000000000000",
  "identityId": "00000000-0000-0000-0000-000000000000",
  "profileId": "00000000-0000-0000-0000-000000000000",
  "displayName": "string",
  "loginIdentifier": "string",
  "status": "active",
  "identityStatus": "active",
  "lastLoginAt": "2026-01-01T00:00:00.000Z",
  "roles": [
    {
      "roleId": "00000000-0000-0000-0000-000000000000",
      "roleCode": "string",
      "roleName": "string"
    }
  ]
}
```

### Schema: UpdateAuthProviderRequest

| Field                 | Type            | Required | Nullable | Description |
| --------------------- | --------------- | -------- | -------- | ----------- |
| `displayName`         | string          | no       | no       |             |
| `issuerUrl`           | string          | no       | no       |             |
| `clientId`            | string          | no       | no       |             |
| `clientSecret`        | string          | no       | no       |             |
| `clientSecretEnvVar`  | string          | no       | no       |             |
| `scopes`              | string          | no       | no       |             |
| `allowedEmailDomains` | array of string | no       | no       |             |
| `enabled`             | boolean         | no       | no       |             |

**Example**

```json
{
  "displayName": "string",
  "issuerUrl": "https://example.com/resource",
  "clientId": "string",
  "clientSecret": "string",
  "clientSecretEnvVar": "string",
  "scopes": "string",
  "allowedEmailDomains": ["user@example.com"],
  "enabled": false
}
```

### Schema: UpdateBlogPageRequest

| Field             | Type                                           | Required | Nullable | Description                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ---------------------------------------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`           | string                                         | no       | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `slug`            | string                                         | no       | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `excerpt`         | string                                         | no       | yes      |                                                                                                                                                                                                                                                                                                                                                                         |
| `contentJson`     | object                                         | no       | no       | When full-online R2-only news portal mode is active for this tenant (Issue #636), an image gallery block item (mediaType image) must use mediaObjectId referencing a verified/attached same-tenant media object, never a raw url.                                                                                                                                       |
| `contentText`     | string                                         | no       | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `locale`          | string                                         | no       | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `visibility`      | enum(`public`, `private`, `unlisted`)          | no       | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `featuredMediaId` | string (uuid)                                  | no       | yes      | When full-online R2-only news portal mode is active for this tenant (Issue #636), must reference an existing, same-tenant media object (Issue #633) with status verified or attached — never a local path or arbitrary external URL. A non-conforming reference is rejected with 422 NEWS_MEDIA_REFERENCE_INVALID. Outside that mode, only the UUID shape is validated. |
| `seoTitle`        | string                                         | no       | yes      |                                                                                                                                                                                                                                                                                                                                                                         |
| `metaDescription` | string                                         | no       | yes      |                                                                                                                                                                                                                                                                                                                                                                         |
| `canonicalUrl`    | string                                         | no       | yes      |                                                                                                                                                                                                                                                                                                                                                                         |
| `pageType`        | enum(`standard`, `landing`, `legal`, `system`) | no       | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `parentPageId`    | string (uuid)                                  | no       | yes      |                                                                                                                                                                                                                                                                                                                                                                         |
| `menuOrder`       | integer                                        | no       | no       |                                                                                                                                                                                                                                                                                                                                                                         |

**Example**

```json
{
  "title": "string",
  "slug": "example-slug",
  "excerpt": "string",
  "contentJson": "(operation-specific payload)",
  "contentText": "string",
  "locale": "string",
  "visibility": "public",
  "featuredMediaId": "00000000-0000-0000-0000-000000000000",
  "seoTitle": "string",
  "metaDescription": "string",
  "canonicalUrl": "https://example.com/resource",
  "pageType": "standard",
  "parentPageId": "00000000-0000-0000-0000-000000000000",
  "menuOrder": 0
}
```

### Schema: UpdateBlogPostRequest

| Field             | Type                                  | Required | Nullable | Description                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ------------------------------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`           | string                                | no       | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `slug`            | string                                | no       | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `excerpt`         | string                                | no       | yes      |                                                                                                                                                                                                                                                                                                                                                                         |
| `contentJson`     | object                                | no       | no       | When full-online R2-only news portal mode is active for this tenant (Issue #636), an image gallery block item (mediaType image) must use mediaObjectId referencing a verified/attached same-tenant media object, never a raw url.                                                                                                                                       |
| `contentText`     | string                                | no       | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `locale`          | string                                | no       | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `visibility`      | enum(`public`, `private`, `unlisted`) | no       | no       |                                                                                                                                                                                                                                                                                                                                                                         |
| `featuredMediaId` | string (uuid)                         | no       | yes      | When full-online R2-only news portal mode is active for this tenant (Issue #636), must reference an existing, same-tenant media object (Issue #633) with status verified or attached — never a local path or arbitrary external URL. A non-conforming reference is rejected with 422 NEWS_MEDIA_REFERENCE_INVALID. Outside that mode, only the UUID shape is validated. |
| `seoTitle`        | string                                | no       | yes      |                                                                                                                                                                                                                                                                                                                                                                         |
| `metaDescription` | string                                | no       | yes      |                                                                                                                                                                                                                                                                                                                                                                         |
| `canonicalUrl`    | string                                | no       | yes      |                                                                                                                                                                                                                                                                                                                                                                         |
| `termIds`         | array of string (uuid)                | no       | no       | Replaces the full category/tag assignment set for this post (Issue                                                                                                                                                                                                                                                                                                      |

**Example**

```json
{
  "title": "string",
  "slug": "example-slug",
  "excerpt": "string",
  "contentJson": "(operation-specific payload)",
  "contentText": "string",
  "locale": "string",
  "visibility": "public",
  "featuredMediaId": "00000000-0000-0000-0000-000000000000",
  "seoTitle": "string",
  "metaDescription": "string",
  "canonicalUrl": "https://example.com/resource",
  "termIds": ["00000000-0000-0000-0000-000000000000"]
}
```

### Schema: UpdateBlogSettingsInput

Partial update — only fields present are validated/changed. blogTitle/blogDescription/rssEnabled/sitemapEnabled live in the row's catch-all `settings` jsonb column; the rest have their own typed columns.

| Field                   | Type                                  | Required | Nullable | Description |
| ----------------------- | ------------------------------------- | -------- | -------- | ----------- |
| `blogTitle`             | string                                | no       | no       |             |
| `blogDescription`       | string                                | no       | yes      |             |
| `postsPerPage`          | integer                               | no       | no       |             |
| `rssEnabled`            | boolean                               | no       | no       |             |
| `sitemapEnabled`        | boolean                               | no       | no       |             |
| `defaultLocale`         | string                                | no       | no       |             |
| `defaultVisibility`     | enum(`public`, `private`, `unlisted`) | no       | no       |             |
| `seoDefaultTitle`       | string                                | no       | yes      |             |
| `seoDefaultDescription` | string                                | no       | yes      |             |

**Example**

```json
{
  "blogTitle": "string",
  "blogDescription": "string",
  "postsPerPage": 1,
  "rssEnabled": false,
  "sitemapEnabled": false,
  "defaultLocale": "string",
  "defaultVisibility": "public",
  "seoDefaultTitle": "string",
  "seoDefaultDescription": "string"
}
```

### Schema: UpdateBlogTermRequest

| Field          | Type                    | Required | Nullable | Description             |
| -------------- | ----------------------- | -------- | -------- | ----------------------- |
| `taxonomyType` | enum(`category`, `tag`) | no       | no       |                         |
| `parentId`     | string (uuid)           | no       | yes      | Must be null for a tag. |
| `name`         | string                  | no       | no       |                         |
| `slug`         | string                  | no       | no       |                         |
| `description`  | string                  | no       | yes      |                         |

**Example**

```json
{
  "taxonomyType": "category",
  "parentId": "00000000-0000-0000-0000-000000000000",
  "name": "string",
  "slug": "example-slug",
  "description": "string"
}
```

### Schema: UpdateEmailTemplateRequest

| Field              | Type                                                     | Required | Nullable | Description |
| ------------------ | -------------------------------------------------------- | -------- | -------- | ----------- |
| `name`             | string                                                   | no       | no       |             |
| `subjectTemplate`  | [`LocalizedTemplateText`](#schema-localizedtemplatetext) | no       | no       |             |
| `textBodyTemplate` | [`LocalizedTemplateText`](#schema-localizedtemplatetext) | no       | yes      |             |
| `htmlBodyTemplate` | [`LocalizedTemplateText`](#schema-localizedtemplatetext) | no       | yes      |             |
| `isActive`         | boolean                                                  | no       | no       |             |

**Example**

```json
{
  "name": "string",
  "subjectTemplate": {
    "en": "Reset your password",
    "id": "Atur ulang kata sandi Anda"
  },
  "textBodyTemplate": {
    "en": "Reset your password",
    "id": "Atur ulang kata sandi Anda"
  },
  "htmlBodyTemplate": {
    "en": "Reset your password",
    "id": "Atur ulang kata sandi Anda"
  },
  "isActive": false
}
```

### Schema: UpdateFormDraftRequest

| Field         | Type               | Required | Nullable | Description                                         |
| ------------- | ------------------ | -------- | -------- | --------------------------------------------------- |
| `currentStep` | string             | no       | no       |                                                     |
| `payload`     | object             | no       | no       | Same constraints as CreateFormDraftRequest.payload. |
| `expiresAt`   | string (date-time) | no       | yes      |                                                     |

**Example**

```json
{
  "currentStep": "string",
  "payload": "(operation-specific payload)",
  "expiresAt": "2026-01-01T00:00:00.000Z"
}
```

### Schema: UpdateRoleRequest

At least one of roleName or permissionIds is required.

| Field           | Type                   | Required | Nullable | Description                                                                    |
| --------------- | ---------------------- | -------- | -------- | ------------------------------------------------------------------------------ |
| `roleName`      | string                 | no       | no       |                                                                                |
| `permissionIds` | array of string (uuid) | no       | no       | Replaces the role's entire permission set. Rejected with 409 for system roles. |

**Example**

```json
{
  "roleName": "string",
  "permissionIds": ["00000000-0000-0000-0000-000000000000"]
}
```

### Schema: UpdateSyncNodeRequest

At least one of status or nodeName is required.

| Field      | Type                       | Required | Nullable | Description |
| ---------- | -------------------------- | -------- | -------- | ----------- |
| `status`   | enum(`active`, `inactive`) | no       | no       |             |
| `nodeName` | string                     | no       | no       |             |

**Example**

```json
{
  "status": "active",
  "nodeName": "string"
}
```

### Schema: UpdateTenantAuthPolicyRequest

| Field                   | Type                   | Required | Nullable | Description |
| ----------------------- | ---------------------- | -------- | -------- | ----------- |
| `passwordLoginEnabled`  | boolean                | no       | no       |             |
| `ssoEnabled`            | boolean                | no       | no       |             |
| `ssoRequired`           | boolean                | no       | no       |             |
| `autoLinkVerifiedEmail` | boolean                | no       | no       |             |
| `allowedEmailDomains`   | array of string        | no       | no       |             |
| `breakGlassIdentityIds` | array of string (uuid) | no       | no       |             |

**Example**

```json
{
  "passwordLoginEnabled": false,
  "ssoEnabled": false,
  "ssoRequired": false,
  "autoLinkVerifiedEmail": false,
  "allowedEmailDomains": ["user@example.com"],
  "breakGlassIdentityIds": ["00000000-0000-0000-0000-000000000000"]
}
```

### Schema: UpdateTenantDomainRequest

At least one field required. hostname/is_primary are not updatable here; status cannot be set to "active" here.

| Field                     | Type                                                | Required | Nullable | Description |
| ------------------------- | --------------------------------------------------- | -------- | -------- | ----------- |
| `domainType`              | enum(`subdomain`, `custom_domain`)                  | no       | no       |             |
| `routeMode`               | enum(`canonical`, `legacy_blog`)                    | no       | no       |             |
| `status`                  | enum(`pending_verification`, `suspended`, `failed`) | no       | no       |             |
| `verificationMethod`      | enum(`dns_txt`, `dns_cname`, `file`, `manual`)      | no       | yes      |             |
| `verificationRecordName`  | string                                              | no       | yes      |             |
| `verificationRecordValue` | string                                              | no       | yes      |             |
| `redirectToPrimary`       | boolean                                             | no       | no       |             |

**Example**

```json
{
  "domainType": "subdomain",
  "routeMode": "canonical",
  "status": "pending_verification",
  "verificationMethod": "dns_txt",
  "verificationRecordName": "string",
  "verificationRecordValue": "string",
  "redirectToPrimary": false
}
```

### Schema: UpdateTenantSettingsRequest

At least one field is required. legalName accepts null to clear it.

| Field           | Type                            | Required | Nullable | Description |
| --------------- | ------------------------------- | -------- | -------- | ----------- |
| `tenantName`    | string                          | no       | no       |             |
| `legalName`     | string                          | no       | yes      |             |
| `defaultLocale` | enum(`id`, `en`, `ms`, `ar`)    | no       | no       |             |
| `defaultTheme`  | enum(`light`, `dark`, `system`) | no       | no       |             |
| `timezone`      | string                          | no       | no       |             |
| `featureFlags`  | object                          | no       | no       |             |

**Example**

```json
{
  "tenantName": "string",
  "legalName": "string",
  "defaultLocale": "id",
  "defaultTheme": "light",
  "timezone": "string",
  "featureFlags": "(operation-specific payload)"
}
```

### Schema: UpdateUserRequest

At least one of displayName or status is required.

| Field         | Type                       | Required | Nullable | Description |
| ------------- | -------------------------- | -------- | -------- | ----------- |
| `displayName` | string                     | no       | no       |             |
| `status`      | enum(`active`, `inactive`) | no       | no       |             |

**Example**

```json
{
  "displayName": "string",
  "status": "active"
}
```

### Schema: UserListResponse

| Field   | Type                                                  | Required | Nullable | Description |
| ------- | ----------------------------------------------------- | -------- | -------- | ----------- |
| `users` | array of [`TenantUserEntry`](#schema-tenantuserentry) | yes      | no       |             |

**Example**

```json
{
  "users": [
    {
      "tenantUserId": "00000000-0000-0000-0000-000000000000",
      "identityId": "00000000-0000-0000-0000-000000000000",
      "profileId": "00000000-0000-0000-0000-000000000000",
      "displayName": "string",
      "loginIdentifier": "string",
      "status": "active",
      "identityStatus": "active",
      "lastLoginAt": "2026-01-01T00:00:00.000Z",
      "roles": []
    }
  ]
}
```

### Schema: VisitEventItem

`ipHash`/`userAgentHash` are `null` unless the caller holds `visitor_analytics.raw_detail.read`.

| Field              | Type                                                       | Required | Nullable | Description |
| ------------------ | ---------------------------------------------------------- | -------- | -------- | ----------- |
| `id`               | string (uuid)                                              | yes      | no       |             |
| `visitorSessionId` | string (uuid)                                              | yes      | yes      |             |
| `identityId`       | string (uuid)                                              | yes      | yes      |             |
| `occurredAt`       | string (date-time)                                         | yes      | no       |             |
| `method`           | string                                                     | yes      | no       |             |
| `statusCode`       | integer                                                    | yes      | yes      |             |
| `area`             | enum(`admin`, `public`, `api`, `auth`, `setup`, `unknown`) | yes      | no       |             |
| `routePattern`     | string                                                     | yes      | yes      |             |
| `pathSanitized`    | string                                                     | yes      | no       |             |
| `referrerDomain`   | string                                                     | yes      | yes      |             |
| `durationMs`       | integer                                                    | yes      | yes      |             |
| `userAgentParsed`  | object                                                     | yes      | no       |             |
| `geo`              | object                                                     | yes      | no       |             |
| `humanStatus`      | enum(`human`, `bot`, `unknown`)                            | yes      | no       |             |
| `correlationId`    | string                                                     | yes      | yes      |             |
| `ipHash`           | string                                                     | yes      | yes      |             |
| `userAgentHash`    | string                                                     | yes      | yes      |             |

**Example**

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "visitorSessionId": "00000000-0000-0000-0000-000000000000",
  "identityId": "00000000-0000-0000-0000-000000000000",
  "occurredAt": "2026-01-01T00:00:00.000Z",
  "method": "string",
  "statusCode": 0,
  "area": "admin",
  "routePattern": "string",
  "pathSanitized": "string",
  "referrerDomain": "tenant.example.com",
  "durationMs": 0,
  "userAgentParsed": "(operation-specific payload)",
  "geo": "(operation-specific payload)",
  "humanStatus": "human",
  "correlationId": "string",
  "ipHash": "string",
  "userAgentHash": "string"
}
```

### Schema: VisitEventListResponse

| Field        | Type                                                | Required | Nullable | Description |
| ------------ | --------------------------------------------------- | -------- | -------- | ----------- |
| `events`     | array of [`VisitEventItem`](#schema-visiteventitem) | yes      | no       |             |
| `nextCursor` | string                                              | yes      | yes      |             |

**Example**

```json
{
  "events": [
    {
      "id": "00000000-0000-0000-0000-000000000000",
      "visitorSessionId": "00000000-0000-0000-0000-000000000000",
      "identityId": "00000000-0000-0000-0000-000000000000",
      "occurredAt": "2026-01-01T00:00:00.000Z",
      "method": "string",
      "statusCode": 0,
      "area": "admin",
      "routePattern": "string",
      "pathSanitized": "string",
      "referrerDomain": "tenant.example.com",
      "durationMs": 0,
      "userAgentParsed": "(operation-specific payload)",
      "geo": "(operation-specific payload)",
      "humanStatus": "human",
      "correlationId": "string",
      "ipHash": "string",
      "userAgentHash": "string"
    }
  ],
  "nextCursor": "string"
}
```

### Schema: VisitorSessionItem

`ipHash`, `ipAddress`, `userAgentHash`, and `loginIdentifierSnapshot` are `null` unless the caller holds `visitor_analytics.raw_detail.read`.

| Field                     | Type                                                       | Required | Nullable | Description |
| ------------------------- | ---------------------------------------------------------- | -------- | -------- | ----------- |
| `id`                      | string (uuid)                                              | yes      | no       |             |
| `visitorKeyHash`          | string                                                     | yes      | no       |             |
| `identityId`              | string (uuid)                                              | yes      | yes      |             |
| `isAuthenticated`         | boolean                                                    | yes      | no       |             |
| `area`                    | enum(`admin`, `public`, `api`, `auth`, `setup`, `unknown`) | yes      | no       |             |
| `currentPath`             | string                                                     | yes      | yes      |             |
| `firstSeenAt`             | string (date-time)                                         | yes      | no       |             |
| `lastSeenAt`              | string (date-time)                                         | yes      | no       |             |
| `browserName`             | string                                                     | yes      | yes      |             |
| `browserVersionMajor`     | string                                                     | yes      | yes      |             |
| `osName`                  | string                                                     | yes      | yes      |             |
| `deviceType`              | enum(`desktop`, `mobile`, `tablet`, `bot`, `unknown`)      | yes      | yes      |             |
| `isHuman`                 | boolean                                                    | yes      | no       |             |
| `botReason`               | string                                                     | yes      | yes      |             |
| `countryCode`             | string                                                     | yes      | yes      |             |
| `region`                  | string                                                     | yes      | yes      |             |
| `city`                    | string                                                     | yes      | yes      |             |
| `timezone`                | string                                                     | yes      | yes      |             |
| `loginIdentifierSnapshot` | string                                                     | yes      | yes      |             |
| `ipHash`                  | string                                                     | yes      | yes      |             |
| `ipAddress`               | string                                                     | yes      | yes      |             |
| `userAgentHash`           | string                                                     | yes      | yes      |             |

**Example**

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "visitorKeyHash": "string",
  "identityId": "00000000-0000-0000-0000-000000000000",
  "isAuthenticated": false,
  "area": "admin",
  "currentPath": "string",
  "firstSeenAt": "2026-01-01T00:00:00.000Z",
  "lastSeenAt": "2026-01-01T00:00:00.000Z",
  "browserName": "string",
  "browserVersionMajor": "string",
  "osName": "string",
  "deviceType": "desktop",
  "isHuman": false,
  "botReason": "string",
  "countryCode": "string",
  "region": "string",
  "city": "string",
  "timezone": "string",
  "loginIdentifierSnapshot": "string",
  "ipHash": "string",
  "ipAddress": "string",
  "userAgentHash": "string"
}
```

### Schema: VisitorSessionListResponse

| Field        | Type                                                        | Required | Nullable | Description |
| ------------ | ----------------------------------------------------------- | -------- | -------- | ----------- |
| `sessions`   | array of [`VisitorSessionItem`](#schema-visitorsessionitem) | yes      | no       |             |
| `nextCursor` | string                                                      | yes      | yes      |             |

**Example**

```json
{
  "sessions": [
    {
      "id": "00000000-0000-0000-0000-000000000000",
      "visitorKeyHash": "string",
      "identityId": "00000000-0000-0000-0000-000000000000",
      "isAuthenticated": false,
      "area": "admin",
      "currentPath": "string",
      "firstSeenAt": "2026-01-01T00:00:00.000Z",
      "lastSeenAt": "2026-01-01T00:00:00.000Z",
      "browserName": "string",
      "browserVersionMajor": "string",
      "osName": "string",
      "deviceType": "desktop",
      "isHuman": false,
      "botReason": "string",
      "countryCode": "string",
      "region": "string",
      "city": "string",
      "timezone": "string",
      "loginIdentifierSnapshot": "string",
      "ipHash": "string",
      "ipAddress": "string",
      "userAgentHash": "string"
    }
  ],
  "nextCursor": "string"
}
```

### Schema: WorkClassSaturation

| Field       | Type                                                                                       | Required | Nullable | Description |
| ----------- | ------------------------------------------------------------------------------------------ | -------- | -------- | ----------- |
| `workClass` | enum(`critical_transaction`, `interactive`, `reporting`, `background_sync`, `maintenance`) | yes      | no       |             |
| `active`    | integer                                                                                    | yes      | no       |             |
| `max`       | integer                                                                                    | yes      | no       |             |
| `queued`    | integer                                                                                    | yes      | no       |             |

**Example**

```json
{
  "workClass": "critical_transaction",
  "active": 0,
  "max": 0,
  "queued": 0
}
```

### Schema: WorkflowTaskDecisionRequest

| Field      | Type                      | Required | Nullable | Description |
| ---------- | ------------------------- | -------- | -------- | ----------- |
| `decision` | enum(`approve`, `reject`) | yes      | no       |             |
| `reason`   | string                    | no       | no       |             |

**Example**

```json
{
  "decision": "approve",
  "reason": "string"
}
```

### Schema: WorkflowTaskDecisionResponse

| Field            | Type                                    | Required | Nullable | Description |
| ---------------- | --------------------------------------- | -------- | -------- | ----------- |
| `taskId`         | string (uuid)                           | yes      | no       |             |
| `decision`       | enum(`approve`, `reject`)               | yes      | no       |             |
| `instanceId`     | string (uuid)                           | yes      | no       |             |
| `instanceStatus` | enum(`approved`, `rejected`, `pending`) | yes      | no       |             |
| `nextStepOrder`  | integer                                 | yes      | yes      |             |

**Example**

```json
{
  "taskId": "00000000-0000-0000-0000-000000000000",
  "decision": "approve",
  "instanceId": "00000000-0000-0000-0000-000000000000",
  "instanceStatus": "approved",
  "nextStepOrder": 1
}
```

### Schema: WorkflowTaskItem

| Field                     | Type               | Required | Nullable | Description |
| ------------------------- | ------------------ | -------- | -------- | ----------- |
| `id`                      | string (uuid)      | yes      | no       |             |
| `stepOrder`               | integer            | yes      | no       |             |
| `createdAt`               | string (date-time) | yes      | no       |             |
| `instanceId`              | string (uuid)      | yes      | no       |             |
| `resourceType`            | string             | yes      | no       |             |
| `resourceId`              | string             | yes      | no       |             |
| `requestedByTenantUserId` | string (uuid)      | yes      | no       |             |
| `currentStepOrder`        | integer            | yes      | no       |             |
| `workflowDefinitionId`    | string (uuid)      | yes      | no       |             |
| `workflowKey`             | string             | yes      | no       |             |
| `workflowName`            | string             | yes      | no       |             |

**Example**

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "stepOrder": 1,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "instanceId": "00000000-0000-0000-0000-000000000000",
  "resourceType": "string",
  "resourceId": "string",
  "requestedByTenantUserId": "00000000-0000-0000-0000-000000000000",
  "currentStepOrder": 1,
  "workflowDefinitionId": "00000000-0000-0000-0000-000000000000",
  "workflowKey": "string",
  "workflowName": "string"
}
```

### Schema: WorkflowTaskListResponse

| Field   | Type                                                    | Required | Nullable | Description |
| ------- | ------------------------------------------------------- | -------- | -------- | ----------- |
| `tasks` | array of [`WorkflowTaskItem`](#schema-workflowtaskitem) | yes      | no       |             |

**Example**

```json
{
  "tasks": [
    {
      "id": "00000000-0000-0000-0000-000000000000",
      "stepOrder": 1,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "instanceId": "00000000-0000-0000-0000-000000000000",
      "resourceType": "string",
      "resourceId": "string",
      "requestedByTenantUserId": "00000000-0000-0000-0000-000000000000",
      "currentStepOrder": 1,
      "workflowDefinitionId": "00000000-0000-0000-0000-000000000000",
      "workflowKey": "string",
      "workflowName": "string"
    }
  ]
}
```

## Domain events

Every channel below carries the SAME message envelope (`DomainEvent` /
`DomainEventEnvelope`) — documented once here instead of once per channel.
Producer direction is always `send` (this repo publishes events; there is
no consumer/subscriber contract in this file). Where a channel's own
description says "Documented contract only", the structured JSON logger is
the current producer, not a live pub/sub dispatcher — see
[`05_openapi_asyncapi_detail.md`](05_openapi_asyncapi_detail.md#asyncapi-event-envelope).

### Event envelope

| Field            | Type           | Required | Description |
| ---------------- | -------------- | -------- | ----------- |
| `event_id`       | string         | yes      |             |
| `event_type`     | string         | yes      |             |
| `occurred_at`    | string         | yes      |             |
| `producer`       | object         | yes      |             |
| `tenant_id`      | string \| null | no       |             |
| `correlation_id` | string \| null | no       |             |
| `payload`        | object         | yes      |             |

**Message headers** (HMAC-signed, same scheme as Sync Storage requests —
HMAC signature paired with X-AWCMS-Mini-Node-ID and X-AWCMS-Mini-Timestamp.):
`X-AWCMS-Mini-Node-ID`, `X-AWCMS-Mini-Timestamp`, `X-AWCMS-Mini-Signature`.

**Example**

```json
{
  "event_id": "00000000-0000-0000-0000-000000000000",
  "event_type": "string",
  "occurred_at": "2026-01-01T00:00:00.000Z",
  "producer": {
    "service": "awcms-mini",
    "module": "string"
  },
  "tenant_id": "00000000-0000-0000-0000-000000000000",
  "correlation_id": "string",
  "payload": "(operation-specific payload)"
}
```

### Channels (33)

- `awcms-mini.blog-content.ad.created` — An advertisement was created (Issue #542). Documented contract only; producer is the structured JSON logger, invoked from `pages/api/v1/blog/ads/index.ts`'s `POST` handler (`blog-content.ad.created` log line).
- `awcms-mini.blog-content.ad.deleted` — An advertisement was soft-deleted (Issue #542). Documented contract only; producer is the structured JSON logger, invoked from `pages/api/v1/blog/ads/[id].ts`'s `DELETE` handler (`blog-content.ad.deleted` log line).
- `awcms-mini.blog-content.ad.updated` — An advertisement (or its placement targeting, full-replace) was updated (Issue #542). Documented contract only; producer is the structured JSON logger, invoked from `pages/api/v1/blog/ads/[id].ts`'s `PATCH` handler (`blog-content.ad.updated` log line).
- `awcms-mini.blog-content.menu.created` — A navigation menu was created (Issue #542). Documented contract only; producer is the structured JSON logger, invoked from `pages/api/v1/blog/menus/index.ts`'s `POST` handler (`blog-content.menu.created` log line).
- `awcms-mini.blog-content.menu.deleted` — A navigation menu was soft-deleted (Issue #542). Documented contract only; producer is the structured JSON logger, invoked from `pages/api/v1/blog/menus/[id].ts`'s `DELETE` handler (`blog-content.menu.deleted` log line).
- `awcms-mini.blog-content.menu.updated` — A navigation menu (or its item tree, full-replace) was updated (Issue #542). Documented contract only; producer is the structured JSON logger, invoked from `pages/api/v1/blog/menus/[id].ts`'s `PATCH` handler (`blog-content.menu.updated` log line).
- `awcms-mini.blog-content.post.archived` — A blog post was archived (Issue #538/#541). Documented contract only; producer is the structured JSON logger, invoked from `pages/api/v1/blog/posts/[id]/archive.ts` (`blog-content.post.archived` log line).
- `awcms-mini.blog-content.post.created` — A blog post draft was created (Issue #538/#541). Documented contract only, same convention as the email channels above — producer is the structured JSON logger, invoked from `pages/api/v1/blog/posts/index.ts`'s `POST` handler (`blog-content.post.created` log line).
- `awcms-mini.blog-content.post.deleted` — A blog post was soft-deleted (Issue #538/#541). Documented contract only; producer is the structured JSON logger, invoked from `pages/api/v1/blog/posts/[id].ts`'s `DELETE` handler (`blog-content.post.deleted` log line).
- `awcms-mini.blog-content.post.published` — A blog post transitioned to `published` (Issue #538/#541), either via the admin `POST /api/v1/blog/posts/{id}/publish` action or the `bun run blog:publish:scheduled` job publishing a due `scheduled` post. Documented contract only; producer is the structured JSON logger, invoked from `pages/api/v1/blog/posts/[id]/publish.ts` and `blog-content/application/blog-scheduled-publish.ts` (`blog-content.post.published` log line, `trigger` attribute distinguishes the two callers).
- `awcms-mini.blog-content.post.purged` — A blog post was hard-deleted (Issue #538/#541). Documented contract only; producer is the structured JSON logger, invoked from `pages/api/v1/blog/posts/[id]/purge.ts` (`blog-content.post.purged` log line).
- `awcms-mini.blog-content.post.restored` — A soft-deleted blog post was restored (Issue #538/#541 — not to be confused with `revision.created`, which fires when a _revision_ is restored onto the live post). Documented contract only; producer is the structured JSON logger, invoked from `pages/api/v1/blog/posts/[id]/restore.ts` (`blog-content.post.restored` log line).
- `awcms-mini.blog-content.post.scheduled` — A blog post was scheduled for future publication (Issue #538/#541). Documented contract only; producer is the structured JSON logger, invoked from `pages/api/v1/blog/posts/[id]/schedule.ts` (`blog-content.post.scheduled` log line).
- `awcms-mini.blog-content.post.submitted-for-review` — A blog post moved from `draft`/`review` into `review` (Issue #538/#541). Documented contract only; producer is the structured JSON logger, invoked from `pages/api/v1/blog/posts/[id]/submit-review.ts` (`blog-content.post.submitted-for-review` log line).
- `awcms-mini.blog-content.post.updated` — A blog post was updated (Issue #538/#541). Documented contract only; producer is the structured JSON logger, invoked from `pages/api/v1/blog/posts/[id].ts`'s `PATCH` handler (`blog-content.post.updated` log line).
- `awcms-mini.blog-content.revision.created` — A new row was appended to `awcms_mini_blog_revisions` (Issue #541) — either a significant title/contentJson/contentText change on `PATCH /api/v1/blog/{posts,pages}/{id}`, or a revision restore (`POST /api/v1/blog/posts/{id}/revisions/{revisionId}/restore`) appending the restored snapshot. `awcms_mini_blog_revisions` is append-only — this event never corresponds to an `UPDATE`/`DELETE` of an existing revision row. Documented contract only; producer is the structured JSON logger, invoked from `blog-content/application/blog-revision-directory.ts`'s `createBlogRevision` (`blog-content.revision.created` log line).
- `awcms-mini.blog-content.settings.updated` — Reserved for when `awcms_mini_blog_settings` (migration 026) gets a write route — the `blog_content.settings.configure` permission was seeded in Issue #537 but no endpoint consumes it yet. Documented contract only, no current producer (unlike every other channel in this module) — listed now per doc issue #541's required AsyncAPI event set so the contract is complete ahead of the route landing in a later issue.
- `awcms-mini.blog-content.template.created` — A presentation template was created (Issue #542). Documented contract only; producer is the structured JSON logger, invoked from `pages/api/v1/blog/templates/index.ts`'s `POST` handler (`blog-content.template.created` log line).
- `awcms-mini.blog-content.template.deleted` — A presentation template was soft-deleted (Issue #542). Documented contract only; producer is the structured JSON logger, invoked from `pages/api/v1/blog/templates/[id].ts`'s `DELETE` handler (`blog-content.template.deleted` log line).
- `awcms-mini.blog-content.template.updated` — A presentation template was updated (Issue #542). Documented contract only; producer is the structured JSON logger, invoked from `pages/api/v1/blog/templates/[id].ts`'s `PATCH` handler (`blog-content.template.updated` log line).
- `awcms-mini.blog-content.term.created` — A taxonomy term (category/tag) was created (Issue #539/#541). Documented contract only; producer is the structured JSON logger, invoked from `pages/api/v1/blog/terms/index.ts`'s `POST` handler (`blog-content.term.created` log line).
- `awcms-mini.blog-content.term.updated` — A taxonomy term (category/tag) was updated (Issue #539/#541). Documented contract only; producer is the structured JSON logger, invoked from `pages/api/v1/blog/terms/[id].ts`'s `PATCH` handler (`blog-content.term.updated` log line).
- `awcms-mini.blog-content.theme.updated` — The tenant's blog theme mode override was set (Issue #542) — a blog-scoped override of the base tenant theme engine (`awcms_mini_tenants.default_theme`, migration 002), not a replacement for it. Documented contract only; producer is the structured JSON logger, invoked from `pages/api/v1/blog/theme/ index.ts`'s `PATCH` handler (`blog-content.theme.updated` log line).
- `awcms-mini.blog-content.widget.created` — A widget was created (Issue #542). Documented contract only; producer is the structured JSON logger, invoked from `pages/api/v1/blog/widgets/index.ts`'s `POST` handler (`blog-content.widget.created` log line).
- `awcms-mini.blog-content.widget.deleted` — A widget was soft-deleted (Issue #542). Documented contract only; producer is the structured JSON logger, invoked from `pages/api/v1/blog/widgets/[id].ts`'s `DELETE` handler (`blog-content.widget.deleted` log line).
- `awcms-mini.blog-content.widget.updated` — A widget was updated (Issue #542). Documented contract only; producer is the structured JSON logger, invoked from `pages/api/v1/blog/widgets/[id].ts`'s `PATCH` handler (`blog-content.widget.updated` log line).
- `awcms-mini.database.pool.saturated` — Emitted when a work-class concurrency gate times out a queued caller (Issue 10.2, doc 16 §Connection pooling dan backpressure, doc 05 "DB Connectivity" category). Documented contract only — this repo has no live pub/sub dispatcher for any domain event yet; the concrete producer is the structured JSON logger (`src/lib/logging/logger.ts`) invoked from `withTenant` (`src/lib/database/tenant-context.ts`), consistent with how AsyncAPI events have been documented since Issue 0.3 without requiring a live producer.
- `awcms-mini.email.message.cancelled` — An operator cancelled a still-queued message (Issue #499, `POST /api/v1/email/messages/{id}/cancel`) — the technical mitigation for the "accidental bulk send" incident scenario. Documented contract only; producer is the structured JSON logger, invoked from `pages/api/v1/email/messages/[id]/cancel.ts` (`email.message.cancelled` log line).
- `awcms-mini.email.message.failed` — The email dispatcher exhausted retries (or hit a non-retryable failure) for a queued message. Documented contract only; producer is the structured JSON logger (`email/application/email-dispatch.ts`'s `email.dispatch.failed` log line).
- `awcms-mini.email.message.queued` — An email message was enqueued into `awcms_mini_email_messages` (Issue #494/#497). Documented contract only, same convention as `database.pool.saturated` above — the concrete producer is the structured JSON logger, invoked from `email/application/announcement-directory.ts`'s `enqueueAnnouncement` (`email.message.queued` log line).
- `awcms-mini.email.message.sent` — The email dispatcher (Issue #495, `bun run email:dispatch`) successfully delivered a message through the configured provider. Documented contract only; producer is the structured JSON logger (`email/application/email-dispatch.ts`'s `email.dispatch.sent` log line).
- `awcms-mini.email.message.suppressed` — The email dispatcher (Issue #499) found a claimed message's recipient newly present on `awcms_mini_email_suppression_list` (added after enqueue, before dispatch) and skipped the provider call entirely. Documented contract only; producer is the structured JSON logger (`email/application/email-dispatch.ts`'s `email.dispatch.suppressed` log line).
- `awcms-mini.sync.push.requested` — Baseline sync push event envelope for future sync-storage implementation.

## Compatibility & deprecation policy

Contract changes follow ADR-0008's SemVer rules (independent of the
package release version):

- **PATCH** — description/documentation-only fixes, no schema change.
- **MINOR** — additive, backward-compatible changes (new endpoint/event,
  new optional field/parameter).
- **MAJOR** — breaking changes (removed/renamed field or endpoint,
  changed response shape).

See [`docs/adr/0008-independent-contract-and-module-versioning.md`](../adr/0008-independent-contract-and-module-versioning.md)
for the full policy.

**Currently deprecated** (derived from `deprecated: true` on any
operation, schema, or event channel in the bundled contracts):

_None — nothing in the bundled contracts is currently marked deprecated._
