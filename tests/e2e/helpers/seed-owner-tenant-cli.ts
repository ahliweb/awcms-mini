/**
 * Standalone CLI entry point for `seed-owner-tenant.ts`'s seeding logic —
 * run as a SEPARATE `bun` subprocess by `seedOwnerTenant()` (see that
 * file's own comment) rather than in-process inside the Playwright test
 * runner. Empirically, calling `Bun.password.hash` (argon2, CPU-bound
 * native work) together with several sequential `Bun.SQL` queries in the
 * SAME process that also drives Playwright's browser via its
 * `--remote-debugging-pipe` IPC channel intermittently breaks that IPC
 * channel — subsequent `page.request.*`/`page.goto` calls fail with
 * `TypeError: "<path>" cannot be parsed as a URL.` even for calls that
 * pass an already-absolute URL string, with no relation to the URL
 * handling code itself (isolated by bisection during Issue #592's own
 * implementation: the same query sequence without the `hashPassword` call
 * never reproduces it, but isolating `hashPassword` + a couple of queries
 * on their own also doesn't reliably reproduce it — the trigger is
 * timing-sensitive, matching the class of `chromium.launch()`/Bun IPC pipe
 * issues `.claude/skills/awcms-mini-browser-test/SKILL.md` already
 * documents for `oven-sh/bun#15679`). Running this in a child process
 * sidesteps the interaction entirely: no argon2/Postgres work ever shares
 * an event loop with Playwright's own IPC.
 *
 * Usage: `bun tests/e2e/helpers/seed-owner-tenant-cli.ts <databaseUrl> <tenantCode>`
 * — prints one JSON line (`SeededOwner`) to stdout on success.
 */
import { seedOwnerTenantInProcess } from "./seed-owner-tenant";

const [databaseUrl, tenantCode] = process.argv.slice(2);

if (!databaseUrl || !tenantCode) {
  console.error(
    "Usage: bun seed-owner-tenant-cli.ts <databaseUrl> <tenantCode>"
  );
  process.exit(1);
}

const owner = await seedOwnerTenantInProcess(databaseUrl, tenantCode);
console.log(JSON.stringify(owner));
