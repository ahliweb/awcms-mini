# Cloudflare Tunnel Private DB Connector Runbook

## Purpose

This runbook covers the VPS-side connector step for the private-database Hyperdrive path.

Use it after the Cloudflare Tunnel resource already exists and before retrying the Hyperdrive rollout.

Current reviewed tunnel:

- name: `awcms-mini-postgres`
- tunnel ID: `f2646d88-0ca1-4ea2-9397-04a1e6ae436e`

## When To Use This Runbook

Use this runbook when:

- the private-database Cloudflare Tunnel path is the selected Hyperdrive origin strategy
- the Tunnel resource already exists in Cloudflare
- the remaining task is to run a connector from the target environment that can reach PostgreSQL on port `5432`

## Prerequisites

- a reviewed Tunnel resource already exists in the target Cloudflare account
- the target Ubuntu/Coolify-managed environment can reach the PostgreSQL origin host and port `5432`
- the operator has the tunnel token or another reviewed method for running the connector
- ingress rules and hostname/route configuration are being handled in the Cloudflare dashboard or API as part of the paired route/config issue

## Deployment Guidance

1. Choose the machine or container environment that can already reach the PostgreSQL origin privately.
2. Install or verify `cloudflared` in that environment.
3. Prefer running the connector with the tunnel token rather than embedding broader Cloudflare API credentials on the VPS.
4. Keep the tunnel token in server-managed secret storage, not in tracked files.
5. Start the connector for tunnel `f2646d88-0ca1-4ea2-9397-04a1e6ae436e`.
6. Verify the tunnel becomes active in Cloudflare.
7. Record the runtime location, restart method, and operator owner for the connector.

Current reviewed operating model:

- treat this as a remotely managed tunnel run from the VPS with a tunnel token
- treat the tunnel token as equivalent to the ability to run this tunnel; if the token may have leaked, rotate it instead of only restarting the service

Preferred execution path for the current environment:

- run `cloudflared` directly on the Ubuntu/Coolify-managed VPS under a restart-managed host service such as `systemd`
- treat deployment through a Coolify-managed application container as optional/fallback only if a working hosted Coolify application-create path is later confirmed

## Recommended Runtime Pattern

- use a supervised service or equivalent restart-managed process on the target host
- avoid one-off foreground sessions as the steady-state deployment method
- keep connector restarts explicit and auditable
- keep direct host deployment as the reviewed default unless a later issue confirms a supported Coolify app automation path

## Recommended `systemd` Example

Recommended local-only environment file:

```bash
sudo install -d -m 0750 /etc/awcms-mini
sudo sh -c 'cat > /etc/awcms-mini/cloudflared-postgres.env <<"EOF"
TUNNEL_TOKEN=<local-only-tunnel-token>
EOF'
sudo chmod 0600 /etc/awcms-mini/cloudflared-postgres.env
```

Recommended unit file:

```ini
[Unit]
Description=Cloudflare Tunnel connector for AWCMS Mini PostgreSQL
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/awcms-mini/cloudflared-postgres.env
ExecStart=/usr/local/bin/cloudflared tunnel run --token ${TUNNEL_TOKEN}
Restart=always
RestartSec=5s
User=root

[Install]
WantedBy=multi-user.target
```

Recommended service activation flow:

```bash
sudo sh -c 'cat > /etc/systemd/system/cloudflared-postgres.service <<"EOF"
[Unit]
Description=Cloudflare Tunnel connector for AWCMS Mini PostgreSQL
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/awcms-mini/cloudflared-postgres.env
ExecStart=/usr/local/bin/cloudflared tunnel run --token ${TUNNEL_TOKEN}
Restart=always
RestartSec=5s
User=root

[Install]
WantedBy=multi-user.target
EOF'
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared-postgres.service
sudo systemctl status cloudflared-postgres.service
```

Adjust the `ExecStart` path if `cloudflared` is installed elsewhere on the host.

Recommended verification commands after activation:

```bash
sudo systemctl status cloudflared-postgres.service
sudo journalctl -u cloudflared-postgres.service -n 50 --no-pager
```

If operators later add reviewed run parameters such as explicit log files, keep those changes in the `systemd` unit or service override rather than moving the tunnel token into tracked config.

## Token Handling

- keep the tunnel token in local-only or server-managed secret storage
- do not place the tunnel token in `.env.example`, tracked scripts, or GitHub issue bodies
- prefer the tunnel token over account-wide API credentials on the VPS once the tunnel resource exists

## Minimum Operator Checks

Before startup:

- confirm the target environment can reach PostgreSQL on port `5432`
- confirm PostgreSQL authentication and TLS posture remain unchanged
- confirm the tunnel token is available only in the target environment's secret store
- confirm the target environment can restart the reviewed `cloudflared` service without requiring interactive shell sessions

After startup:

- confirm tunnel `awcms-mini-postgres` is active
- confirm the connector is running under a reviewed restart-managed process
- confirm `systemctl status cloudflared-postgres.service` shows a healthy running process if the recommended `systemd` path is used
- confirm recent `journalctl` output does not show repeated reconnect, token, or origin-reachability failures
- confirm the route/config issue has the hostname or route needed for Hyperdrive
- hand the active connector status back to `#146`

## Failure Notes

- if the connector cannot reach PostgreSQL, fix origin-network reachability before adjusting Hyperdrive config again
- if the tunnel remains inactive, verify the token, process supervision, and host egress path first
- if the service starts but repeatedly reconnects, review `journalctl` output before changing PostgreSQL exposure or Hyperdrive settings
- if the tunnel token may have been exposed through shell history, issue comments, logs, or copied VPS files, rotate the token and update the server-managed secret store before retrying
- if operators are tempted to open public PostgreSQL ingress to work around connector issues, stop and re-evaluate the fallback issue instead

## Validation

- target-environment connector validation
- Cloudflare tunnel status shows active

## Cross-References

- `docs/process/cloudflare-hyperdrive-decision.md`
- `docs/process/postgresql-vps-hardening.md`
- `docs/process/secret-hygiene-coolify-cloudflare-topology-plan-2026.md`
