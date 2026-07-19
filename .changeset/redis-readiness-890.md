---
"awcms-mini": minor
---

feat(redis): add optional Bun-native Redis readiness foundation (#890)

Adds an opt-in, fail-open Redis capability for scalable derived applications without changing PostgreSQL as the authoritative transactional store. The additive foundation includes typed configuration, tenant-aware key namespacing, JSON cache-aside helpers with TTL, a Redis health CLI, unit tests, a hardened Docker Compose overlay with ACL authentication and no public port, and operational/security guidance for LAN and Coolify deployments.

Redis remains disabled by default. No session, audit, workflow, durable outbox, or authoritative domain state is migrated to Redis, and no third-party runtime dependency is added.
