# AWCMS-Mini SaaS Contract Registry (generated)

Do not edit by hand. Regenerate with `bun run saas-contracts:inventory:generate` (`scripts/saas-contract-inventory-generate.ts`, Issue #874). The read-only twin `bun run saas-contracts:registry:check` fails `bun run check` if this file is stale or if any descriptor is invalid.

SaaS contract version: `1.0.0`

## Features (3)

| Key                         | Owner module      | Description                                            |
| --------------------------- | ----------------- | ------------------------------------------------------ |
| `platform.api_access`       | `service_catalog` | Programmatic REST API access to the tenant's own data. |
| `platform.custom_domain`    | `service_catalog` | Serve the tenant portal from a custom domain.          |
| `platform.priority_support` | `service_catalog` | Priority operator support queue for the tenant.        |

## Meters (3)

| Key                      | Owner module      | Event version | Value type | Aggregation  | Correction | Billable | Privacy class | Min | Max              |
| ------------------------ | ----------------- | ------------- | ---------- | ------------ | ---------- | -------- | ------------- | --- | ---------------- |
| `platform.active_users`  | `service_catalog` | 1.0           | count      | unique_count | none       | no       | pseudonymous  | 0   | 9007199254740991 |
| `platform.api_calls`     | `service_catalog` | 1.0           | count      | sum          | none       | yes      | non_personal  | 0   | 9007199254740991 |
| `platform.storage_bytes` | `service_catalog` | 1.0           | bytes      | max          | none       | yes      | non_personal  | 0   | 9007199254740991 |

## Quotas (3)

| Key                          | Owner module      | Meter                    | Unit | Reset period  | Enforcement |
| ---------------------------- | ----------------- | ------------------------ | ---- | ------------- | ----------- |
| `platform.active_user_quota` | `service_catalog` | `platform.active_users`  | user | monthly       | advisory    |
| `platform.api_call_quota`    | `service_catalog` | `platform.api_calls`     | call | billing_cycle | hard        |
| `platform.storage_quota`     | `service_catalog` | `platform.storage_bytes` | byte | none          | hard        |

## Commercial events (2)

| Event type                                   | Owner module      | Event version | Kind      |
| -------------------------------------------- | ----------------- | ------------- | --------- |
| `awcms-mini.service-catalog.offer.published` | `service_catalog` | 1.0           | lifecycle |
| `awcms-mini.service-catalog.offer.retired`   | `service_catalog` | 1.0           | lifecycle |
