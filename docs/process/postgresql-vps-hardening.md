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
- If Hyperdrive will be used, confirm the database origin also accepts the reviewed Cloudflare-to-origin connection path; Hyperdrive configuration creation fails if the origin refuses Cloudflare connectivity.
- If Hyperdrive will be used, confirm the chosen hostname resolves to the intended PostgreSQL origin path for Cloudflare rather than a web-proxied Cloudflare edge hostname.

Supported origin patterns for Hyperdrive:

1. a reviewed reachable public PostgreSQL origin hostname or IP path with the required TLS and ingress posture
2. a private-database path fronted by Cloudflare Tunnel when the PostgreSQL origin should not be exposed as a directly reachable public service

Preferred default for the current environment:

- prefer the private-database Cloudflare Tunnel path so PostgreSQL does not need a separately reachable public origin endpoint just for Hyperdrive
- treat the reachable public-origin path as a fallback only when the Tunnel path is not workable

If the private-database Tunnel path is selected, prepare at least:

1. a `cloudflared` connector or equivalent reviewed tunnel connector path with reachability to the PostgreSQL origin host and port
2. a reviewed TCP hostname or tunnel route that Hyperdrive can target for the private database path; `pg-hyperdrive.ahlikoding.com` is the current reviewed default name
3. any required Cloudflare Access client ID and client secret material if the tunnel-backed origin is protected through Access
4. an operator note showing how tunnel routing, PostgreSQL authentication, and the Coolify-managed host map together
5. operator access to the Cloudflare dashboard or API to configure ingress rules for the remotely managed tunnel after resource creation

## Coolify Operator Sequence

Use this order when rolling the reviewed SSL posture into the Coolify-managed PostgreSQL deployment.

1. Confirm `id1.ahlikoding.com` resolves to the reviewed VPS IP `202.10.45.224`.
2. Confirm the PostgreSQL server certificate presented by the host covers `id1.ahlikoding.com`.
3. In the Coolify-managed PostgreSQL service, verify the server is configured for SSL and that `postgresql.conf` keeps `ssl = on`.
4. Review `pg_hba.conf` so remote Mini access uses `hostssl` with the narrowest practical source range and `scram-sha-256`.
5. If Hyperdrive rollout is planned, choose one reviewed origin pattern before changing app deployment config. Prefer the private-database route via Cloudflare Tunnel; use a reachable public PostgreSQL origin endpoint only as the fallback path.
6. If the private-database Tunnel path is selected, confirm the tunnel connector can reach the PostgreSQL origin host and port and that any Access/service-token prerequisites are ready.
7. If Hyperdrive rollout is planned, confirm the database/firewall policy allows the reviewed Cloudflare-to-origin connection path needed for Hyperdrive configuration creation and runtime use.
8. Keep the application role non-superuser and separate from maintenance credentials.
9. Update the Cloudflare-hosted app runtime secret so `DATABASE_URL` uses `id1.ahlikoding.com` with `sslmode=verify-full` when certificate validation is ready.
10. If certificate validation is not ready yet, use a reviewed interim `sslmode=require` value temporarily and record the follow-on hardening step explicitly.
11. Run `pnpm healthcheck` and the reviewed smoke tests after the deployment update.
12. Record the effective certificate/hostname posture and any temporary exceptions in the deployment notes.

## Minimum Operator Checks

Before deployment:

- Confirm `DATABASE_URL` points to the intended remote PostgreSQL host.
- Confirm the reviewed app-side hostname is `id1.ahlikoding.com` when hostname validation is expected.
- Confirm TLS expectations for the target environment are documented and enabled.
- Confirm the runtime user is not a superuser.
- Confirm `pg_hba.conf` allows only the intended app host or narrow private range.
- If Hyperdrive is planned, confirm the reviewed Cloudflare-to-origin connection path is allowed before attempting `wrangler hyperdrive create`.
- If Hyperdrive is planned, confirm the reviewed Hyperdrive origin hostname resolves to a direct/reachable PostgreSQL origin path instead of Cloudflare edge IPs.
- Confirm host firewall rules restrict database ingress accordingly.
- Confirm the VPS IP `202.10.45.224` is treated as operator inventory and troubleshooting data, not the preferred application hostname when `verify-full` is required.
- If management-plane inspection revealed live database credentials or externally routable connection strings, treat credential rotation as part of the remediation plan rather than only tightening network controls.

After deployment:

- Confirm the app can connect and complete `pnpm healthcheck`.
- Confirm migrations run successfully against the intended database.
- Confirm no unexpected direct access path to PostgreSQL was introduced.
- Confirm the deployed runtime is not using maintenance credentials.
- Confirm the effective `DATABASE_URL` in the deployment matches the reviewed hostname and SSL mode for the environment.

## Recovery Notes

- If connectivity fails after a database-host change, verify DNS or host routing before widening `pg_hba.conf` or firewall rules.
- If TLS negotiation fails, fix the certificate or client configuration rather than disabling TLS requirements broadly.
- If `verify-full` fails, verify that `id1.ahlikoding.com` resolves to the intended VPS and that the PostgreSQL certificate covers that hostname before falling back to a weaker mode.
- If Hyperdrive configuration creation fails with a connection-refused error, fix origin reachability for the reviewed Cloudflare path before retrying the Hyperdrive rollout.
- If the reviewed Hyperdrive origin hostname resolves to Cloudflare edge IPs instead of the intended PostgreSQL origin path, switch to a reviewed reachable origin hostname or direct origin path before retrying Hyperdrive creation.
- If a management-plane API response exposed current database passwords or public connection URLs during incident review, rotate the affected credentials after the live posture is brought back under control.
- If the app user lacks permissions, grant the smallest missing privilege instead of switching to a superuser credential.

## Rollback Order

If the reviewed SSL rollout causes production connectivity loss, use the smallest rollback that restores the previous known-good posture.

1. Capture the failing `DATABASE_URL` posture, current certificate state, and the latest Coolify/PostgreSQL config change.
2. Verify DNS and certificate coverage for `id1.ahlikoding.com` before changing PostgreSQL access rules.
3. If the certificate or hostname validation is the only failing seam, temporarily roll back to the last reviewed TLS-required mode such as `sslmode=require` instead of disabling TLS entirely.
4. If server-side SSL configuration changed unexpectedly, restore the last known good PostgreSQL SSL configuration in Coolify before widening client access.
5. Re-run `pnpm healthcheck` and the deployment smoke tests after the rollback step completes.
6. Record the incident and keep the follow-on hardening task explicit.

## Cross-References

- `docs/architecture/runtime-config.md`
- `docs/security/operations.md`
- `docs/process/migration-deployment-checklist.md`
