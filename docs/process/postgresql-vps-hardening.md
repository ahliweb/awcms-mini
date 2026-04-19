# PostgreSQL VPS Hardening

## Purpose

This runbook defines the supported security posture for AWCMS Mini when PostgreSQL runs on a VPS and the app connects to it remotely.

## Supported Baseline

The supported baseline is:

1. AWCMS Mini runs in the supported Cloudflare-hosted runtime.
2. PostgreSQL runs on a separate protected VPS or equivalent protected host managed through Coolify.
3. The app connects to PostgreSQL over a restricted network path.
4. Remote database traffic is protected with TLS.

Current reviewed operator inventory for this repository:

- PostgreSQL VPS IP: `202.10.45.224`
- reviewed SSL hostname for app connections: `id1.ahlikoding.com`

## Transport Expectations

- Treat PostgreSQL as a remote protected dependency, not as a localhost-only service.
- Enable PostgreSQL SSL on the server for remote app-to-database traffic.
- Prefer client connections that require TLS.
- Prefer certificate validation for higher-assurance environments.
- If certificate validation is operationally available, prefer `sslmode=verify-full`.
- If full certificate validation is not yet available, use a minimum posture that still requires TLS for remote connections.
- For the reviewed production baseline, prefer app connections through `id1.ahlikoding.com` so `sslmode=verify-full` can validate the expected hostname.

## `DATABASE_URL` Guidance

- Production `DATABASE_URL` should target the remote PostgreSQL host, not a local development default.
- Prefer an application-specific database user, not `postgres` and not a superuser role.
- Prefer a dedicated application database or narrowly scoped ownership pattern over broad cluster-wide privileges.
- Include remote-transport expectations in the connection configuration used by the deployment environment.

Example baseline shape:

```text
postgres://awcms_mini_app:<password>@id1.ahlikoding.com:5432/awcms_mini?sslmode=require
```

Higher-assurance example when certificate validation is available:

```text
postgres://awcms_mini_app:<password>@id1.ahlikoding.com:5432/awcms_mini?sslmode=verify-full
```

## `postgresql.conf` Expectations

- Enable `ssl = on` for remote deployments.
- Install and manage the PostgreSQL server certificate and private key appropriately for the host.
- Keep listen addresses scoped as tightly as the deployment allows.
- Avoid exposing the database service on unnecessary public interfaces.

## `pg_hba.conf` Expectations

- Prefer `hostssl` entries for remote app access instead of broad plain `host` entries.
- Restrict the source address to the specific app host or the narrowest private network range available.
- Use `scram-sha-256` for password-based application access.
- Keep rule ordering intentional so narrow allow rules are evaluated before broader patterns.
- Avoid `0.0.0.0/0` allow rules for the application user.

Example shape:

```conf
# TYPE    DATABASE      USER             ADDRESS             METHOD
hostssl   awcms_mini    awcms_mini_app   10.0.12.34/32       scram-sha-256
```

If the app reaches PostgreSQL through a private subnet instead of a single host, keep the allowed range as small as practical.

## Role And Privilege Expectations

- The application role should not be a PostgreSQL superuser.
- The application role should not own unrelated databases.
- Grant only the database and schema privileges needed for Mini runtime and migration behavior.
- Keep administrative PostgreSQL maintenance credentials separate from the application runtime credentials.

## Network Access Expectations

- Restrict PostgreSQL ingress to the app host or private network path.
- Do not treat the database as a public internet-facing service.
- Prefer VPS firewall rules or provider network controls in addition to PostgreSQL configuration.
- Review both the app host egress path and the database host ingress policy during deployment changes.

## Minimum Operator Checks

Before deployment:

- Confirm `DATABASE_URL` points to the intended remote PostgreSQL host.
- Confirm the reviewed app-side hostname is `id1.ahlikoding.com` when hostname validation is expected.
- Confirm TLS expectations for the target environment are documented and enabled.
- Confirm the runtime user is not a superuser.
- Confirm `pg_hba.conf` allows only the intended app host or narrow private range.
- Confirm host firewall rules restrict database ingress accordingly.
- Confirm the VPS IP `202.10.45.224` is treated as operator inventory and troubleshooting data, not the preferred application hostname when `verify-full` is required.

After deployment:

- Confirm the app can connect and complete `pnpm healthcheck`.
- Confirm migrations run successfully against the intended database.
- Confirm no unexpected direct access path to PostgreSQL was introduced.
- Confirm the deployed runtime is not using maintenance credentials.

## Recovery Notes

- If connectivity fails after a database-host change, verify DNS or host routing before widening `pg_hba.conf` or firewall rules.
- If TLS negotiation fails, fix the certificate or client configuration rather than disabling TLS requirements broadly.
- If `verify-full` fails, verify that `id1.ahlikoding.com` resolves to the intended VPS and that the PostgreSQL certificate covers that hostname before falling back to a weaker mode.
- If the app user lacks permissions, grant the smallest missing privilege instead of switching to a superuser credential.

## Cross-References

- `docs/architecture/runtime-config.md`
- `docs/security/operations.md`
- `docs/process/migration-deployment-checklist.md`
