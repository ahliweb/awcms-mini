import { defineConfig, devices } from "@playwright/test";

/**
 * E2E browser test config (Playwright + Bun). See skill
 * `.claude/skills/awcms-mini-browser-test/SKILL.md` for the full setup
 * rationale, conventions, and known Bun/Playwright gotchas.
 *
 * Naming: specs use `*.e2e.ts` (not `.spec.ts`/`.test.ts`) so `bun test`'s
 * own recursive discovery — which matches `*.test.*`/`*_test.*`/
 * `*.spec.*`/`*_spec.*` by default — never picks these files up and tries
 * to run them as `bun:test` files (they use `@playwright/test`'s own
 * `test`/`expect`, a different runtime context entirely).
 *
 * This suite assumes an already-running app (`bun run dev` or
 * `bun run preview`, with `DATABASE_URL` set) at `E2E_BASE_URL` — the same
 * "you provide the environment" convention `tests/integration/*.integration.test.ts`
 * uses for `DATABASE_URL` (see skill `awcms-mini-testing`). Playwright's own
 * `webServer` auto-start is intentionally NOT used here: this app's dev
 * server needs a live Postgres connection to boot at all, which `webServer`
 * has no way to provision.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:4321",
    headless: true,
    trace: "retain-on-failure",
    // Root-less sandboxes (no `apt-get`, so `playwright install --with-deps`
    // can't run) can point this at a pre-installed system browser instead
    // of Playwright's own bundled Chromium — e.g.
    // `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome`. Leave unset
    // wherever `bunx playwright install chromium` succeeds normally (most
    // dev machines, CI with `--with-deps`).
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
