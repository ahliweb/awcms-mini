/**
 * Thin Meta Graph API HTTP wrapper (Issue #644) — mirrors
 * `email/infrastructure/mailketing-provider.ts`'s established
 * "injectable base URL + injectable fetch, timeout-bounded, safe JSON
 * parse" shape, this repo's existing pattern for testable external-
 * provider clients. Tests substitute `fetchImpl` with a fake implementing
 * the same `typeof fetch` signature — no real network call to Meta's API
 * is ever made from this repo's test suite (Issue #644 requirement).
 *
 * Deliberately dumb: no Meta-specific business logic here (no error
 * interpretation — see `domain/meta-error-normalization.ts` — no content
 * building). Just "call this Graph API path with these params, get back an
 * HTTP status + parsed JSON body," so the adapters can stay focused on
 * orchestration and the client stays trivially fakeable.
 */
import { withTimeout } from "../../../../lib/integration/timeout";

export type MetaGraphHttpMethod = "GET" | "POST";

export type MetaGraphCallRequest = {
  /** Path under the versioned Graph API root, e.g. `/{page-id}/feed` — always starts with `/`. */
  path: string;
  method?: MetaGraphHttpMethod;
  /** Form fields (POST) or query string params (GET) — access tokens included here are never logged by this file. */
  params: Record<string, string>;
};

export type MetaGraphCallResponse = {
  httpStatus: number;
  body: unknown;
};

export type MetaGraphClient = {
  call(request: MetaGraphCallRequest): Promise<MetaGraphCallResponse>;
};

export type MetaGraphClientOptions = {
  graphApiVersion: string;
  /** Override for tests/dev only — a local fake HTTP server standing in for Meta's Graph API. Always from configuration/test setup, never request input (same SSRF-safe convention `mailketing-provider.ts`'s `baseUrl` and `object-storage-uploader.ts`'s R2 endpoint already use). */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const DEFAULT_BASE_URL = "https://graph.facebook.com";
const DEFAULT_TIMEOUT_MS = 10_000;

export function createMetaGraphClient(
  options: MetaGraphClientOptions
): MetaGraphClient {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async call({
      path,
      method = "POST",
      params
    }: MetaGraphCallRequest): Promise<MetaGraphCallResponse> {
      const url = new URL(
        `${baseUrl}/${options.graphApiVersion}${path.startsWith("/") ? path : `/${path}`}`
      );

      let response: Response;

      if (method === "GET") {
        for (const [key, value] of Object.entries(params)) {
          url.searchParams.set(key, value);
        }

        response = await withTimeout(
          fetchImpl(url.toString(), { method: "GET" }),
          timeoutMs,
          `meta-graph:${path}`
        );
      } else {
        const body = new URLSearchParams(params);

        response = await withTimeout(
          fetchImpl(url.toString(), {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString()
          }),
          timeoutMs,
          `meta-graph:${path}`
        );
      }

      const rawBody = await response.text().catch(() => "");
      let parsedBody: unknown = {};

      if (rawBody.length > 0) {
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          parsedBody = { rawParseError: true };
        }
      }

      return { httpStatus: response.status, body: parsedBody };
    }
  };
}

/** Shared response-shape helper — extracts a string field (e.g. `"id"`, `"permalink"`) from a Graph API JSON body, never throws on an unexpected shape. */
export function extractGraphResponseStringField(
  body: unknown,
  field: string
): string | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const value = (body as Record<string, unknown>)[field];

  return typeof value === "string" && value.length > 0 ? value : null;
}
