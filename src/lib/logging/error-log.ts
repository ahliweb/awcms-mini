import { log, type LogContext } from "./logger";
import { safeErrorDetail, sanitizeErrorForLog } from "./error-sanitizer";

/**
 * The two mechanical call-site helpers Issue #687 (epic #679,
 * platform-hardening) introduces — ONE way to log a caught exception from an
 * admin SSR page, and ONE way to report a CLI worker script failure, instead
 * of ~40 files each hand-rolling `console.error(label, error)` or
 * `error instanceof Error ? error.message : String(error)`. Both route
 * through `sanitizeErrorForLog`/`safeErrorDetail` (`./error-sanitizer.ts`)
 * so a raw secret embedded in an exception's own message/stack can never
 * reach stdout/stderr unredacted.
 */

/**
 * For `src/pages/admin/**\/*.astro` SSR page frontmatter. Replaces
 * `console.error("admin/foo.astro: failed to load data", error)` with a
 * correlation-aware structured log line via `log()` — pass
 * `Astro.locals.correlationId` (set for every request by `src/middleware.ts`
 * since Issue 10.1/#447) as `context.correlationId` so the failure can be
 * traced back to the request that caused it, the same way every API handler
 * already can.
 */
export function logAdminPageError(
  label: string,
  error: unknown,
  context: LogContext = {}
): void {
  log("error", label, {
    ...context,
    error: sanitizeErrorForLog(error) as unknown as Record<string, unknown>
  });
}

/**
 * For `scripts/*.ts` CLI worker entrypoints (`bun run <script>`). Replaces
 * the repeated
 * ```ts
 * const detail = error instanceof Error ? error.message : String(error);
 * console.error(`<script> FAILED — ${detail}`);
 * process.exitCode = 1;
 * ```
 * idiom with one call — `label` should already include the script's own
 * name and " FAILED" suffix (matching every existing message this replaces,
 * e.g. `"blog:publish:scheduled FAILED"`), so the printed line is
 * byte-for-byte the same shape operators already know, just with the
 * exception detail redacted first. Still sets `process.exitCode = 1` so the
 * script's own scheduler/CI step observes the failure exactly as before.
 */
export function logScriptFailure(label: string, error: unknown): void {
  console.error(`${label} — ${safeErrorDetail(error)}`);
  process.exitCode = 1;
}
