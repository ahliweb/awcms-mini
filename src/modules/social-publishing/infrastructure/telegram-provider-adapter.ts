/**
 * Telegram channel provider adapter (Issue #646, epic `social_publishing`
 * #643-#647) — the FIRST real `SocialProviderAdapter` implementation
 * (`../domain/social-provider-adapter.ts`) in this module; #643 shipped
 * zero. `providerKey: "telegram_channel"`.
 *
 * ## The bot-token-in-URL leak vector (read before touching this file)
 *
 * Telegram's Bot API embeds the bot token directly in the URL PATH of every
 * request: `https://api.telegram.org/bot<TOKEN>/<method>`. There is no
 * alternative transport Telegram itself offers — the token cannot be moved
 * to a header or the POST body. This means the URL string itself is a
 * secret and must NEVER reach a log line, a thrown `Error` message, an audit
 * record, or any other place `../application/social-publish-dispatch.ts`
 * might persist (`last_error_message`, an attempt row, a structured log
 * call). Concretely, in this file:
 *
 *   - `buildTelegramMethodUrl` is the ONLY place the token-bearing URL
 *     string exists. It is used for exactly one `fetch()` call per
 *     invocation and never assigned to a variable outside `callTelegramApi`'s
 *     local scope, never logged, never included in a returned/thrown value.
 *   - `fetch()`'s `Response.url` property (post-redirect final URL) is NEVER
 *     read anywhere in this file — it would reflect the same token-bearing
 *     URL. Only `response.status`/`response.ok`/the parsed JSON body are
 *     used.
 *   - Every error path returns/throws a message built ONLY from Telegram's
 *     own JSON error body (`description`/`error_code`, which Telegram never
 *     echoes the request URL or token into) or a fixed, generic string for
 *     network/timeout failures — the caught `error.message` from a failed
 *     `fetch()` call is deliberately NEVER interpolated into any returned
 *     value, since some fetch implementations can embed request details in
 *     that message.
 *   - Parameters are sent as a JSON POST body, never a query string (belt
 *     and suspenders — the token in the URL path is the real leak vector
 *     regardless, but this avoids ALSO scattering chat_id/text into a query
 *     string some proxy/access log might capture).
 *
 * ## Parse-mode injection
 *
 * See `../domain/telegram-message-formatting.ts` for the full design —
 * default plain text (no `parse_mode` sent), explicit opt-in only via
 * `TELEGRAM_DEFAULT_PARSE_MODE`, every interpolated field escaped per the
 * active mode's own rules before being placed in the template.
 *
 * ## Deliberately out of scope (this issue)
 *
 * - `sendPhoto`/image preview — issue's own text allows "initial scope can
 *   use safe link post through sendMessage"; `content.imageUrl` is ignored.
 * - Hashtags from article tags — `SocialPublishContentSnapshot` (the
 *   dispatcher's job-creation snapshot, `create-social-publish-jobs.ts`) has
 *   no tag-name field today; adding one would mean widening the shared,
 *   provider-neutral job snapshot schema (migration 053) for every future
 *   adapter, out of this issue's atomic scope. `buildTelegramHashtags` is
 *   still implemented and unit-tested standalone so a follow-up issue that
 *   does add tag names to the snapshot only needs to wire the call, not
 *   design the escaping.
 * - Telegram group moderation, comment sync, inline bot features, scraping,
 *   WhatsApp auto posting — explicitly out of scope per the issue body.
 */
import { withTimeout } from "../../../lib/integration/timeout";
import {
  isTelegramProviderEnabled,
  resolveTelegramDefaultParseMode,
  resolveTelegramRequestTimeoutMs
} from "../domain/telegram-config";
import { buildTelegramMessageText } from "../domain/telegram-message-formatting";
import type {
  SocialProviderAdapter,
  SocialProviderCredentialCheck,
  SocialProviderPublishRequest,
  SocialProviderPublishResult
} from "../domain/social-provider-adapter";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const PROVIDER_KEY = "telegram_channel";
const MAX_ERROR_MESSAGE_LENGTH = 300;

/** Reference-resolution convention shared with `social-account-validation.ts`'s `KNOWN_SECRET_REFERENCE_PREFIX_PATTERN` — this repo has no real secret-manager integration (documented residual, `.claude/skills/awcms-mini-social-publishing/SKILL.md` §643 Keputusan kunci #3), so only the `env:VAR_NAME` indirection is actually resolvable here. */
const ENV_REFERENCE_PREFIX = /^env:(.+)$/i;

type TelegramTokenResolution =
  { ok: true; token: string } | { ok: false; reason: string };

/** Resolves a `token_reference` (or the deployment-level `TELEGRAM_BOT_TOKEN_SECRET_REFERENCE`) to an actual bot token. Never throws. */
export function resolveTelegramBotToken(
  tokenReference: string,
  env: NodeJS.ProcessEnv = process.env
): TelegramTokenResolution {
  const trimmed = tokenReference.trim();
  const match = trimmed.match(ENV_REFERENCE_PREFIX);

  if (!match) {
    return {
      ok: false,
      reason:
        "tokenReference is not an env: reference — no real secret-manager integration is available to resolve any other reference kind."
    };
  }

  const varName = match[1]!.trim();
  const value = varName ? env[varName] : undefined;

  if (!value) {
    return {
      ok: false,
      reason: `tokenReference points at env var "${varName}", which is not set.`
    };
  }

  return { ok: true, token: value };
}

function truncate(message: string): string {
  return message.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`
    : message;
}

type TelegramApiResponse = {
  ok: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
};

type TelegramApiCallResult =
  | { kind: "success"; result: unknown }
  | {
      kind: "api_error";
      httpStatus: number;
      errorCode: number | undefined;
      description: string;
      retryAfterSeconds: number | undefined;
    }
  | { kind: "network_error" }
  | { kind: "timeout" };

/**
 * Calls one Telegram Bot API method. SECURITY: builds the token-bearing URL
 * only inside this function's local scope, for exactly one `fetch()` call —
 * see this file's header comment. Never throws for an ordinary
 * provider-side rejection (returns a typed `TelegramApiCallResult` instead);
 * only a genuinely unexpected condition inside this function itself would
 * throw, and even then no thrown message here ever embeds the URL.
 *
 * `apiBase` defaults to the real `https://api.telegram.org` — tests
 * override it to point at a local `Bun.serve()` fake server (same
 * convention `cloudflare-dns-adapter.ts`'s `createCloudflareDnsProvider`
 * uses for its own `baseUrl` override) so no test ever makes a real network
 * call to Telegram or needs a real bot token.
 */
async function callTelegramApi(
  botToken: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  apiBase: string = TELEGRAM_API_BASE
): Promise<TelegramApiCallResult> {
  // This is the ONLY place the token-bearing URL exists. Do not hoist it to
  // a wider scope, do not log it, do not include it in any error value.
  const url = `${apiBase}/bot${botToken}/${method}`;

  let response: Response;

  try {
    response = await withTimeout(
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params)
      }),
      timeoutMs,
      `telegram:${method}`
    );
  } catch (error) {
    // Deliberately NOT interpolating `error.message` — some fetch/timeout
    // implementations can embed request details in that message. `label`
    // passed to `withTimeout` above is a safe, static string (method name
    // only), never the URL.
    if (error instanceof Error && error.name === "TimeoutError") {
      return { kind: "timeout" };
    }
    return { kind: "network_error" };
  }

  // NEVER read `response.url` here — see this file's header comment.
  let parsed: TelegramApiResponse | null = null;

  try {
    parsed = (await response.json()) as TelegramApiResponse;
  } catch {
    parsed = null;
  }

  if (!parsed || parsed.ok !== true) {
    return {
      kind: "api_error",
      httpStatus: response.status,
      errorCode: parsed?.error_code,
      description: parsed?.description ?? `HTTP ${response.status}`,
      retryAfterSeconds: parsed?.parameters?.retry_after
    };
  }

  return { kind: "success", result: parsed.result };
}

const PERMISSION_DENIED_PATTERN =
  /not enough rights|have no rights|CHAT_WRITE_FORBIDDEN|bot was kicked|bot is not a member|need administrator rights/i;
const CHAT_NOT_FOUND_PATTERN = /chat not found/i;
const UNAUTHORIZED_PATTERN = /unauthorized/i;

/** Maps a Telegram API-level rejection to this adapter's publish outcome. Only ever reads `description`/`error_code`/`parameters.retry_after` — all Telegram-authored, safe to store/log/audit verbatim (never the request URL or bot token). */
function classifyPublishFailure(
  result: Extract<TelegramApiCallResult, { kind: "api_error" }>
): SocialProviderPublishResult {
  const description = truncate(result.description);

  if (result.httpStatus === 429 || result.errorCode === 429) {
    return {
      outcome: "rate_limited",
      errorCode: "telegram_rate_limited",
      errorMessage: description,
      retryable: true,
      retryAfterSeconds: result.retryAfterSeconds
    };
  }

  if (UNAUTHORIZED_PATTERN.test(description)) {
    return {
      outcome: "needs_reauth",
      errorCode: "telegram_invalid_bot_token",
      errorMessage: description,
      retryable: false
    };
  }

  if (PERMISSION_DENIED_PATTERN.test(description)) {
    return {
      outcome: "needs_reauth",
      errorCode: "telegram_missing_permission",
      errorMessage: description,
      retryable: false
    };
  }

  if (CHAT_NOT_FOUND_PATTERN.test(description)) {
    return {
      outcome: "failed",
      errorCode: "telegram_invalid_channel",
      errorMessage: description,
      retryable: false
    };
  }

  return {
    outcome: "failed",
    errorCode: "telegram_api_error",
    errorMessage: description,
    retryable: result.httpStatus >= 500
  };
}

export type TelegramProviderAdapterOverrides = {
  /** Test-only override for a local fake Telegram API server. Always from configuration/call site, never request input (SSRF-safe, same convention `object-storage-uploader.ts`'s R2 endpoint and `cloudflare-dns-adapter.ts`'s `baseUrl` use). Production composition root (`telegram-provider-registration.ts`) never passes this. */
  apiBaseUrl?: string;
};

export function createTelegramChannelProviderAdapter(
  overrides: TelegramProviderAdapterOverrides = {}
): SocialProviderAdapter {
  const apiBase = overrides.apiBaseUrl ?? TELEGRAM_API_BASE;

  return {
    providerKey: PROVIDER_KEY,
    requiredEnvVars: [
      "TELEGRAM_PROVIDER_ENABLED",
      "TELEGRAM_BOT_TOKEN_SECRET_REFERENCE"
    ],

    async publish(
      request: SocialProviderPublishRequest
    ): Promise<SocialProviderPublishResult> {
      const env = process.env;

      if (!isTelegramProviderEnabled(env)) {
        return {
          outcome: "failed",
          errorCode: "telegram_provider_disabled",
          errorMessage:
            'TELEGRAM_PROVIDER_ENABLED is not "true" for this deployment.',
          retryable: false
        };
      }

      const tokenResolution = resolveTelegramBotToken(
        request.tokenReference,
        env
      );

      if (!tokenResolution.ok) {
        return {
          outcome: "failed",
          errorCode: "telegram_bot_token_unresolvable",
          errorMessage: tokenResolution.reason,
          retryable: false
        };
      }

      const parseMode = resolveTelegramDefaultParseMode(env);
      const text = buildTelegramMessageText(request.content, [], parseMode);
      const timeoutMs = resolveTelegramRequestTimeoutMs(env);

      const params: Record<string, unknown> = {
        chat_id: request.providerAccountId,
        text
      };

      if (parseMode) {
        params.parse_mode = parseMode;
      }

      const result = await callTelegramApi(
        tokenResolution.token,
        "sendMessage",
        params,
        timeoutMs,
        apiBase
      );

      if (result.kind === "timeout") {
        return {
          outcome: "failed",
          errorCode: "telegram_request_timeout",
          errorMessage: `Telegram API request timed out after ${timeoutMs}ms.`,
          retryable: true
        };
      }

      if (result.kind === "network_error") {
        return {
          outcome: "failed",
          errorCode: "telegram_network_error",
          errorMessage: "Telegram API request failed (network error).",
          retryable: true
        };
      }

      if (result.kind === "api_error") {
        return classifyPublishFailure(result);
      }

      const messageResult = result.result as { message_id?: number } | null;
      const messageId = messageResult?.message_id;

      if (typeof messageId !== "number") {
        return {
          outcome: "failed",
          errorCode: "telegram_missing_message_id",
          errorMessage:
            "Telegram API reported success but returned no message_id.",
          retryable: false
        };
      }

      return {
        outcome: "published",
        externalPostId: String(messageId),
        externalPostUrl: buildTelegramMessageUrl(
          request.providerAccountId,
          messageId
        )
      };
    },

    async verifyCredentials(
      tokenReference: string,
      providerAccountId: string,
      _scopesJson: unknown,
      env: NodeJS.ProcessEnv = process.env
    ): Promise<SocialProviderCredentialCheck> {
      if (!isTelegramProviderEnabled(env)) {
        return { valid: false, reason: "telegram_provider_disabled" };
      }

      const tokenResolution = resolveTelegramBotToken(tokenReference, env);

      if (!tokenResolution.ok) {
        return { valid: false, reason: "token_reference_unresolvable" };
      }

      const timeoutMs = resolveTelegramRequestTimeoutMs(env);

      const meResult = await callTelegramApi(
        tokenResolution.token,
        "getMe",
        {},
        timeoutMs,
        apiBase
      );

      if (meResult.kind !== "success") {
        return { valid: false, reason: "bot_token_invalid_or_unreachable" };
      }

      const bot = meResult.result as { id?: number; username?: string } | null;

      if (!bot || typeof bot.id !== "number") {
        return { valid: false, reason: "bot_identity_unavailable" };
      }

      const memberResult = await callTelegramApi(
        tokenResolution.token,
        "getChatMember",
        { chat_id: providerAccountId, user_id: bot.id },
        timeoutMs,
        apiBase
      );

      if (memberResult.kind === "api_error") {
        if (CHAT_NOT_FOUND_PATTERN.test(memberResult.description)) {
          return { valid: false, reason: "channel_not_found" };
        }
        return { valid: false, reason: "channel_access_check_failed" };
      }

      if (memberResult.kind !== "success") {
        return { valid: false, reason: "channel_access_check_failed" };
      }

      const member = memberResult.result as {
        status?: string;
        can_post_messages?: boolean;
      } | null;

      if (
        !member ||
        !["administrator", "creator"].includes(member.status ?? "")
      ) {
        return { valid: false, reason: "missing_channel_permission" };
      }

      if (
        member.status === "administrator" &&
        member.can_post_messages === false
      ) {
        return { valid: false, reason: "missing_post_permission" };
      }

      const permissions = Object.entries(member)
        .filter(([key, value]) => key.startsWith("can_") && value === true)
        .map(([key]) => key);

      return {
        valid: true,
        details: {
          botUsername: bot.username,
          permissions
        }
      };
    }
  };
}

/** Best-effort public message URL — only resolvable when `providerAccountId` is a public `@username` (Telegram has no public URL for a private channel by numeric chat id). Returns an empty string rather than a guess in that case; the dispatcher/job row still always has `externalPostId` regardless. */
function buildTelegramMessageUrl(
  providerAccountId: string,
  messageId: number
): string {
  const username = providerAccountId.startsWith("@")
    ? providerAccountId.slice(1)
    : providerAccountId;

  if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) {
    return "";
  }

  return `https://t.me/${username}/${messageId}`;
}
