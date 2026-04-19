# Hyperdrive Rollout Operator Handoff

## Purpose

This handoff condenses the remaining live operator-side rollout path for AWCMS Mini.

Use it when understanding the completed rollout sequence and the remaining follow-up work:

- `#152` VPS-side `cloudflared` connector activation completed
- `#146` Hyperdrive binding rollout completed
- `#158` remains the main live follow-up for PostgreSQL exposure and credential posture

This document is a short execution aid, not a replacement for the detailed runbooks.

## Current Baseline

- AWCMS Mini remains EmDash-first and Cloudflare-hosted.
- PostgreSQL remains on a Coolify-managed VPS.
- The repo already supports `DATABASE_TRANSPORT=direct|hyperdrive`.
- Live Hyperdrive enablement is complete.
- The current preferred path is private-database routing through Cloudflare Tunnel rather than broad public PostgreSQL exposure.

## Step Order

1. `#152` completed so the reviewed `cloudflared` connector is active from the VPS environment that can reach PostgreSQL.
2. `#146` completed so the Cloudflare-hosted Worker runtime now uses Hyperdrive successfully.
3. Continue `#158` so the live PostgreSQL resource matches the reviewed private/credential posture after the Hyperdrive transport switch.

Fallback decision gate:

- stay on the preferred tunnel path unless operators conclude that the VPS-side connector path is not viable in the target environment within the reviewed rollout window
- `#147` is now a historical fallback only because the private-database tunnel strategy succeeded and Hyperdrive is live
- if operators ever re-open a public-origin fallback in the future, keep PostgreSQL TLS, narrow ingress, least-privilege credentials, and explicit audit notes in place; the fallback path does not relax those controls

## `#152` Connector Activation

Run the reviewed host-service checks:

```bash
sudo systemctl status cloudflared-postgres.service
sudo journalctl -u cloudflared-postgres.service -n 50 --no-pager
```

Then run the reviewed runtime verification:

```bash
HEALTHCHECK_EXPECT_DATABASE_TRANSPORT=hyperdrive \
HEALTHCHECK_EXPECT_HYPERDRIVE_BINDING=HYPERDRIVE \
pnpm healthcheck
```

Sign off only when:

- the tunnel is active
- service logs do not show repeated reconnect or origin-reachability failures
- the runtime verification matches the reviewed Hyperdrive transport target

If the tunnel token may have leaked through logs, copied files, shell history, or issue comments, rotate it before retrying.

If the connector path ever becomes non-viable in a future rollout or recovery event, open a new reviewed fallback issue rather than widening public PostgreSQL exposure as an ad hoc workaround.

## `#158` PostgreSQL Posture Reconciliation

Confirm the live PostgreSQL posture is back on the reviewed direct path before treating the remediation as complete.

Run the reviewed runtime verification:

```bash
HEALTHCHECK_EXPECT_DATABASE_TRANSPORT=direct \
HEALTHCHECK_EXPECT_DATABASE_HOSTNAME=id1.ahlikoding.com \
HEALTHCHECK_EXPECT_DATABASE_SSLMODE=verify-full \
pnpm healthcheck
```

Sign off only when:

- public exposure is removed or explicitly justified
- SSL posture is enabled as reviewed
- old credentials no longer work if credential rotation was triggered
- the runtime verification matches the reviewed direct hostname and SSL mode

Treat credential rotation as required when a current password or reusable connection string was exposed through the management plane, or when the database was broadly publicly reachable without high-confidence containment.

## `#146` Final Hyperdrive Verification

Continue only after `#152` and `#158` are both complete enough to support a real Hyperdrive rollout.

Before enabling the live binding:

- confirm the reviewed Hyperdrive configuration ID exists in the target Cloudflare account
- confirm the reviewed origin path is reachable for Cloudflare and not just a web-proxied hostname
- confirm the deployment still keeps PostgreSQL TLS, narrow ingress, and non-superuser credentials

After enabling the binding, re-run:

```bash
HEALTHCHECK_EXPECT_DATABASE_TRANSPORT=hyperdrive \
HEALTHCHECK_EXPECT_HYPERDRIVE_BINDING=HYPERDRIVE \
pnpm healthcheck
```

## Security Notes

- keep all live credentials and tokens in `.env.local`, server-managed secret files, Wrangler-managed secrets, or CI/CD secret storage only
- keep healthcheck expectation variables non-secret; they are safe for rollout assertions but should not replace secret storage
- keep Cloudflare, Coolify, and PostgreSQL credentials separated by purpose and privilege
- prefer the smallest rollback that restores the reviewed posture rather than widening exposure during incident response

## Detailed References

- `docs/process/cloudflare-tunnel-private-db-connector-runbook.md`
- `docs/process/postgresql-vps-hardening.md`
- `docs/process/migration-deployment-checklist.md`
- `docs/process/runtime-smoke-test.md`
- `docs/process/cloudflare-hosted-runtime.md`
- `docs/process/cloudflare-hyperdrive-decision.md`
