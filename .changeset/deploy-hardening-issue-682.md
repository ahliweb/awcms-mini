---
"awcms-mini": minor
---

Harden Docker Compose, PgBouncer, and production image defaults (Issue #682, epic #679, platform-hardening).

`docker-compose.yml`'s `db` and `pgbouncer` services no longer publish a host port by default — production/offline-LAN topologies never needed direct host access to PostgreSQL, and it was previously always exposed. Local dev access is now opt-in via `docker-compose.override.yml.example` (copy to `docker-compose.override.yml`, auto-loaded, git-ignored), binding both ports to `127.0.0.1` only. Every service (`db`/`migrate`/`app`/`pgbouncer`) now runs `cap_drop: [ALL]` (`db` gets back the 5 capabilities its own entrypoint needs — `CHOWN`/`FOWNER`/`SETUID`/`SETGID`/`DAC_OVERRIDE` — live-verified as the minimum `postgres:18.4` requires) plus `security_opt: no-new-privileges:true`, a starting-point `deploy.resources.limits`, and (for `app`) a Bun-native HTTP healthcheck. `oven/bun:1` and `edoburu/pgbouncer:latest` are now pinned to `oven/bun:1.3.14`/`edoburu/pgbouncer:v1.25.2-p0` instead of floating tags.

PgBouncer's `deploy/pgbouncer/pgbouncer.ini.example` moves from `auth_type = md5` to `scram-sha-256`, matching PostgreSQL 18's own default password hashing — the header documents the exact `pg_authid.rolpassword` extraction command for generating `userlist.txt`. Live-verified end-to-end: a real SCRAM verifier extracted from a running dev database was accepted by a real PgBouncer container, and a client authenticated against it successfully.

New `docker-compose.prod.yml` gives the registry-based/immutable-image topology (`Dockerfile.production`, previously only usable via bare `docker build`/`docker run`) its own Compose entry point — standalone, not an override of `docker-compose.yml`. Its `app` service runs `read_only: true` with a `tmpfs` `/tmp` mount, live-verified safe since the built image never writes to its own filesystem at runtime (no bind-mount install/build step, unlike the default compose file). `Dockerfile.production` itself gains the same Bun version pin, a `HEALTHCHECK` instruction, and updated `docker run` guidance for `--cap-drop=ALL`.

CI now runs `docker compose config -q` against both compose files (and the `pgbouncer` profile) on every PR, catching syntax/env-var errors before they reach a deploy. `docs/awcms-mini/deployment-profiles.md` gains new TLS/trust-boundary and secrets-via-deployment-references sections documenting where TLS terminates in each topology and the options for orchestrators that require file-based (rather than env-var) secrets.
