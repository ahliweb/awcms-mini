import { getDatabase } from "../../db/index.mjs";
import { createSecurityEventRepository } from "../../db/repositories/security-events.mjs";
import { createAuditService } from "../audit/service.mjs";
import { runtimeRateLimitStore } from "../../security/runtime-rate-limits.mjs";

function normalizeScopeSegment(value) {
  return String(value ?? "").trim().toLowerCase();
}

function buildAccountScope(email) {
  return `account:${normalizeScopeSegment(email)}`;
}

function buildIpScope(ip) {
  return `ip:${normalizeScopeSegment(ip || "unknown")}`;
}

export function createLockoutService(options = {}) {
  const database = options.database ?? getDatabase();
  const securityEvents = options.securityEvents ?? createSecurityEventRepository(database);
  const audit = options.audit ?? createAuditService({ database });
  const rateLimitStore = options.rateLimitStore ?? runtimeRateLimitStore;
  const now = options.now ?? (() => Date.now());

  return {
    async assertLoginAllowed({ email, ipAddress }) {
      const account = rateLimitStore.inspect(buildAccountScope(email), now());
      const ip = rateLimitStore.inspect(buildIpScope(ipAddress), now());

      const locked = [account, ip].find((entry) => entry.locked);

      if (!locked) {
        return null;
      }

      return {
        code: "AUTH_LOCKED",
        lockedUntil: new Date(locked.lockedUntil).toISOString(),
        scopeKey: locked.scopeKey,
      };
    },

    async registerLoginFailure({ email, ipAddress, userId = null, userAgent = null, reason }) {
      const policy = rateLimitStore.getPolicy();
      const account = rateLimitStore.increment(buildAccountScope(email), policy.maxFailuresPerAccount, now());
      const ip = rateLimitStore.increment(buildIpScope(ipAddress), policy.maxFailuresPerIp, now());

      const locked = [account, ip].find((entry) => entry.locked);

      if (locked) {
        const lockedUntil = new Date(locked.lockedUntil).toISOString();

        await audit.append({
          action: "auth.lockout",
          entity_type: "auth_lockout",
          entity_id: locked.scopeKey,
          target_user_id: userId,
          summary: "Locked authentication attempts after repeated failures.",
          after_payload: {
            email,
            reason,
            scope_key: locked.scopeKey,
            locked_until: lockedUntil,
          },
          metadata: {
            ip_address: ipAddress,
            user_agent: userAgent,
          },
        });

        await securityEvents.appendEvent({
          id: crypto.randomUUID(),
          user_id: userId,
          event_type: "auth.lockout",
          severity: "warning",
          details_json: {
            email,
            reason,
            scope_key: locked.scopeKey,
            locked_until: lockedUntil,
          },
          ip_address: ipAddress,
          user_agent: userAgent,
        });
      }

      return {
        account,
        ip,
        lockedUntil: locked ? new Date(locked.lockedUntil).toISOString() : null,
      };
    },

    resetLoginCounters({ email, ipAddress }) {
      rateLimitStore.reset(buildAccountScope(email));
      rateLimitStore.reset(buildIpScope(ipAddress));
    },

    resetAccountCounters(email) {
      rateLimitStore.reset(buildAccountScope(email));
    },
  };
}

export { buildAccountScope, buildIpScope };
