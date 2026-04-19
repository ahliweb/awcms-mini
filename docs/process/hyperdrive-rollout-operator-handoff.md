# Hyperdrive Rollout Operator Handoff

## Purpose

This handoff condenses the remaining live operator-side rollout path for AWCMS Mini.

Use it when working the current blocker chain:

- `#152` VPS-side `cloudflared` connector activation
- `#158` Coolify PostgreSQL exposure and SSL posture reconciliation
- `#146` final Hyperdrive binding rollout verification

This document is a short execution aid, not a replacement for the detailed runbooks.

## Current Baseline

- AWCMS Mini remains EmDash-first and Cloudflare-hosted.
- PostgreSQL remains on a Coolify-managed VPS.
- The repo already supports `DATABASE_TRANSPORT=direct|hyperdrive`.
- Live Hyperdrive enablement is still operator-side and not yet complete.
- The current preferred path is private-database routing through Cloudflare Tunnel rather than broad public PostgreSQL exposure.

## Step Order

1. Complete `#152` so the reviewed `cloudflared` connector is active from the VPS environment that can reach PostgreSQL.
2. Complete `#158` so the live PostgreSQL resource matches the reviewed private/SSL posture and any required credential rotation is finished.
3. Continue `#146` only after the connector and database posture are both in a reviewed state.

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
