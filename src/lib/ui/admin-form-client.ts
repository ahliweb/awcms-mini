/**
 * Shared client-side helpers for the admin screens' inline `<script>` blocks
 * (`login.astro`, `admin/access-users.astro`, `admin/sync.astro`,
 * `admin/settings.astro`).
 *
 * Issue #434 (UX/UI audit): every one of those pages previously duplicated
 * an identical `submitJson` / `showBanner` / reload-after-success trio
 * verbatim (doc 14 §Konsistensi token/komponen calls out exactly this kind
 * of inline duplication to extract). Pulling it into one module also gives
 * us a single place to fix a real gap the audit found: none of the mutation
 * forms/buttons disabled themselves while the request was in flight, so a
 * fast double-click (or double Enter) could fire the same POST/PATCH/DELETE
 * twice before the page reloaded. `lockElement` closes that gap (doc 14
 * §Form UX — "disable saat submit, cegah double-submit") without touching
 * the server-side idempotency story, which is a separate, already-covered
 * concern for the high-risk mutations that need it.
 *
 * Astro bundles non-`is:inline` `<script>` blocks through Vite, so a plain
 * `import` from a page's `<script>` works the same as anywhere else in the
 * app — this file is not itself an Astro component.
 *
 * `extraHeaders` (Issue #543, `admin/blog/*`) — additive optional parameter
 * on `submitJson`: the blog post/page lifecycle-action endpoints
 * (`publish`/`schedule`/`archive`/`restore`/`purge`, revision restore) are
 * the first admin-UI mutations that require a caller-supplied
 * `Idempotency-Key` header (doc issue #541/#538 — same replay/conflict
 * semantics `workflows/tasks/{id}/decisions.ts` established). Every
 * existing call site omits the third-turned-fourth argument and is
 * unaffected.
 *
 * `fetchJson` (Issue #622, `admin/analytics.astro`) — the same safe
 * error-mapping `submitJson` already does (map a failure response's error
 * code through the caller's translated `errorMessages`, never surface a
 * raw exception/stack), but for a `GET` read instead of a mutation. The
 * visitor analytics dashboard is the first admin page whose initial data
 * load happens client-side against the real `GET /api/v1/analytics/*`
 * endpoints rather than an SSR `withTenant` call in the page's own
 * frontmatter (deliberate for that page — see its own doc comment: the
 * dashboard must only ever call the already-guarded HTTP API, never touch
 * the database directly from UI code).
 *
 * `SubmitResult<TData>`/`submitJson<TData>` (Issue #753,
 * `admin/reporting/projections.astro`) — additive generic + `data` field:
 * every EXISTING call site (34 files) omits the type parameter and never
 * reads `.data`, so this is backward compatible (defaults to
 * `SubmitResult<unknown>`, `data: null` on any failure path, same shape
 * `fetchJson`'s own `FetchJsonResult` already established for the GET
 * case) — needed for a mutation whose caller wants to branch on the
 * response body (e.g. "rebuild resumed vs newly triggered", "reconcile
 * found a mismatch or not") without a second round-trip.
 */

export interface SubmitResult<TData = unknown> {
  ok: boolean;
  code?: string;
  message: string;
  data: TData | null;
}

export interface ClientErrorStrings {
  networkError: string;
  errorMessages?: Record<string, string>;
}

/**
 * Reads the `<script type="application/json" id="...">` blob each page
 * injects with its server-translated (`t()`) strings — the client script
 * cannot read the `.po` catalog itself (server-only, via `Bun.file`).
 */
export function readClientStrings<T = Record<string, unknown>>(
  elementId = "i18n-strings"
): T {
  try {
    return JSON.parse(
      document.getElementById(elementId)?.textContent ?? "{}"
    ) as T;
  } catch {
    return {} as T;
  }
}

/** POST/PATCH/DELETE JSON to `url`, mapping a failure response's error code
 * through the pre-translated `errorMessages` map (falls back to the API's
 * raw message, then a generic string). */
export async function submitJson<TData = unknown>(
  url: string,
  method: string,
  body: unknown,
  strings: ClientErrorStrings,
  extraHeaders?: Record<string, string>
): Promise<SubmitResult<TData>> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...extraHeaders },
      credentials: "same-origin",
      body: JSON.stringify(body)
    });
    const json = await res.json().catch(() => null);

    if (!res.ok) {
      const code = json?.error?.code as string | undefined;
      const message: string =
        (code && strings.errorMessages?.[code]) ??
        json?.error?.message ??
        `Request failed (${res.status}).`;
      return { ok: false, code, message, data: null };
    }

    return {
      ok: true,
      message: "",
      data: (json?.data ?? null) as TData | null
    };
  } catch {
    return { ok: false, message: strings.networkError, data: null };
  }
}

export interface FetchJsonResult<TData> {
  ok: boolean;
  status: number;
  code?: string;
  message: string;
  data: TData | null;
}

/**
 * GET `url` and parse the standard `{ success, data }` / `{ success:
 * false, error }` envelope (`modules/_shared/api-response.ts`). Never
 * throws — a network failure or non-2xx response both come back as
 * `ok: false` with a safe, translated `message`, the same guardrail
 * `submitJson` already enforces (doc 10: no stack trace/internal detail
 * ever reaches the UI).
 */
export async function fetchJson<TData = unknown>(
  url: string,
  strings: ClientErrorStrings
): Promise<FetchJsonResult<TData>> {
  try {
    const res = await fetch(url, { credentials: "same-origin" });
    const json = await res.json().catch(() => null);

    if (!res.ok) {
      const code = json?.error?.code as string | undefined;
      const message: string =
        (code && strings.errorMessages?.[code]) ??
        json?.error?.message ??
        `Request failed (${res.status}).`;
      return { ok: false, status: res.status, code, message, data: null };
    }

    return {
      ok: true,
      status: res.status,
      message: "",
      data: (json?.data ?? null) as TData | null
    };
  } catch {
    return { ok: false, status: 0, message: strings.networkError, data: null };
  }
}

/** Shows the page's `role="alert"` action banner (announced to assistive
 * tech automatically since `role="alert"` is an implicit live region). */
export function showBanner(
  bannerId: string,
  message: string,
  variant: "success" | "error"
): void {
  const banner = document.getElementById(bannerId);
  if (!banner) return;
  banner.textContent = message;
  banner.setAttribute("data-variant", variant);
  banner.hidden = false;
}

export function reloadAfterDelay(delayMs = 400): void {
  setTimeout(() => window.location.reload(), delayMs);
}

/**
 * Disables `el` (button) for the duration of an in-flight mutation and
 * marks it `aria-busy` so assistive tech doesn't announce it as actionable
 * mid-request. Optionally swaps its label to `busyLabel` (e.g. "Please
 * wait…"). Returns a restore function — call it in a `finally` block so the
 * control comes back regardless of success/failure (failure must leave the
 * form exactly as the user left it, per doc 14 §Form UX "preserve input saat
 * error" — this only touches the button, never the form fields).
 *
 * Callers must check `el.disabled` themselves before calling this (the
 * check has to happen synchronously on the event, before any `await`, to
 * actually prevent a fast double-click/double-Enter from slipping a second
 * request in ahead of the disable taking effect).
 */
export function lockElement(
  el: HTMLButtonElement,
  busyLabel?: string
): () => void {
  const originalText = el.textContent;
  el.disabled = true;
  el.setAttribute("aria-busy", "true");
  if (busyLabel) {
    el.textContent = busyLabel;
  }

  return () => {
    el.disabled = false;
    el.removeAttribute("aria-busy");
    if (busyLabel) {
      el.textContent = originalText;
    }
  };
}

/** One fresh `Idempotency-Key` per mutation attempt (`crypto.randomUUID()` — available in every browser this app targets, same primitive `menu-policy.ts`'s client-supplied item ids assume). A retry after a failed request must call this again, not reuse the previous value, so a genuinely new attempt is never rejected as a stale replay. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
