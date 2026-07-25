---
"awcms-mini": patch
---

security(tenant-provisioning): key the owner-secret commitment that feeds `inputs_hash` (CodeQL #63/#64)

`computeProvisioningInputsHash` folded a bare `sha256(owner password)` into the
provisioning `inputs_hash`, which is persisted twice — on
`awcms_mini_tenant_provisioning_requests` and as the generic idempotency store's
`request_hash`. Every other field feeding that digest is recoverable by the same
reader (`tenantCode`/`tenantName`/`options` sit in the adjacent `inputs` jsonb;
the owner login identifier, legal name, and office code/name are readable from
the tables the same run wrote), so anyone with database READ access could
enumerate password guesses at two unsalted SHA-256 per guess and confirm a hit
against a stored column — an offline cracking oracle for a tenant's initial
administrator password.

The password is now represented by a scrypt derivation
(`owner-secret-commitment.ts`) salted with the domain-separated process pepper
(`AUTH_JWT_SECRET`). That buys both properties at once: the pepper lives in the
environment rather than a column, so a database reader cannot reproduce a digest
from a guess; and each guess costs a full scrypt derivation, so even a leaked
pepper degrades to a slow attack rather than an instant one. Argon2id cannot be
used here — the value must be deterministic and recomputable from the request
body on every replay, and argon2id salts per call. Real credentials are
unaffected; they were already stored with `Bun.password.hash` (argon2id).

Measured at ~30 ms per derivation; the request route derives twice, so ~60 ms
against an operation that already runs an argon2id hash and writes a tenant,
owner, office, settings, and every step row in one transaction.

Behaviour notes:

- The password still participates in the hash, so a retry that reuses an
  `Idempotency-Key` with a DIFFERENT owner password remains a clean 409 rather
  than a replay of the original success.
- `POST /api/v1/tenant-provisioning/requests` now fails closed when
  `AUTH_JWT_SECRET` is unset or still the published `.env.example` placeholder,
  matching the audit `ipHash` and usage-metering pseudonym.
- Hashes computed before this change no longer match a recomputation, so an
  in-flight provisioning `Idempotency-Key` replayed across the upgrade returns
  409 instead of the stored response. This is fail-safe (never a second tenant)
  and self-clears as keys age out.
