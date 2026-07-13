/**
 * Telegram `sendMessage` text/parse-mode formatting (Issue #646). This is
 * the security-critical piece the issue's acceptance criteria calls out
 * explicitly: "Markdown/HTML parse mode is sanitized or disabled by default
 * to avoid formatting injection."
 *
 * Threat: the message text always embeds user-authored content (article
 * title, excerpt/summary, tag-derived hashtags) inside a template the
 * adapter controls. If `parse_mode` is set to `MarkdownV2`/`HTML`, Telegram
 * interprets formatting-special characters ANYWHERE in the text — `*_[]()~
 * \`>#+-=|{}.!` for MarkdownV2, `&<>` for HTML — including inside what was
 * meant to be plain user data. An article titled e.g. `Breaking: *URGENT*
 * [click here](https://evil.example)`-shaped text could otherwise render
 * unintended bold/italic emphasis or, worse, be misread as real inline-link
 * markup. Two independent defenses:
 *
 *   1. Default to NO `parse_mode` at all (`undefined` — see
 *      `telegram-config.ts`'s `resolveTelegramDefaultParseMode`, which only
 *      ever returns `"MarkdownV2"`/`"HTML"` on an explicit, valid opt-in and
 *      `undefined` otherwise). With no `parse_mode`, Telegram treats the
 *      ENTIRE message as literal text — no character sequence can ever be
 *      interpreted as formatting/link/mention syntax, full stop.
 *   2. If a parse mode IS explicitly enabled, every interpolated
 *      user-authored (or otherwise untrusted-shaped) substring is escaped
 *      per Telegram's own documented escaping rules for that mode BEFORE
 *      being placed into the template — the static template scaffolding
 *      (line breaks, spacing) is never escaped since it never contains
 *      untrusted data.
 *
 * We deliberately never build an inline link/mention (`[text](url)` /
 * `<a href="...">`) out of user data — the canonical URL is rendered as a
 * plain, escaped line of text and left for Telegram's own auto-link
 * detection to linkify (this works with or without a `parse_mode`). This
 * removes the entire "constructed unexpected inline link" injection surface
 * the issue's security notes call out, at the cost of not being able to
 * mask the URL behind custom link text — an acceptable, deliberate
 * trade-off for a "safe link post" (issue's own wording) rather than rich
 * formatting.
 */
import type { SocialPublishContentSnapshot } from "./social-provider-adapter";
import type { TelegramParseMode } from "./telegram-config";

/**
 * Every character MarkdownV2 requires escaping with a preceding `\` per
 * Telegram's Bot API documentation: `_ * [ ] ( ) ~ \` > # + - = | { } . !` —
 * PLUS the backslash character itself. Telegram's docs don't list `\` as
 * "must be escaped" directly, but omitting it from this set reintroduces
 * exactly the "escape the escape character" bypass this repo has hit before
 * in Markdown-link escapers (see memory: a `|`-only/partial escaper without
 * backslash-first handling is an incomplete-sanitization bug). Concretely: a
 * raw input of `\*` (backslash then asterisk) must become `\\\*` (escaped
 * backslash, then escaped asterisk) so it round-trips back to literal `\*`
 * after Telegram parses it — if we escaped only `*` and left the original
 * `\` untouched, the result `\\*` parses as an escaped backslash followed by
 * a now-BARE, unescaped `*`, which can pair with another stray `*` elsewhere
 * in the message to toggle real bold/italic formatting.
 *
 * This is applied as a SINGLE combined regex over the ORIGINAL string in one
 * pass (`String.replace` with a global regex, one substitution per match) —
 * never as multiple sequential `.replace()` calls. A sequential
 * "escape special chars, then separately escape backslash" approach would
 * re-escape backslashes it just inserted (or, in the opposite order, fail to
 * escape a pre-existing backslash before the chars that follow it) — the
 * exact ordering bug class this repo has already shipped and fixed multiple
 * times in independent doc/Markdown generators. A single pass over the
 * original text has no such ordering hazard: every character is visited
 * exactly once.
 */
const MARKDOWN_V2_SPECIAL_CHARS = /[_*[\]()~`>#+\-=|{}.!\\]/g;

export function escapeTelegramMarkdownV2(text: string): string {
  return text.replace(MARKDOWN_V2_SPECIAL_CHARS, "\\$&");
}

/**
 * Telegram HTML parse mode requires escaping `&`, `<`, `>` anywhere they
 * appear as plain text (unescaped, they would be read as entity/tag syntax).
 * Implemented as a single-pass regex with a character-aware replacer
 * function (never sequential `.replace()` calls) — escaping `&` in a
 * separate, later pass would re-escape the `&` this same pass just inserted
 * while escaping `<`/`>` (e.g. `<` → `&lt;` then a later `&` → `&amp;` pass
 * would corrupt it into `&amp;lt;`). One pass over the original string
 * avoids that class of bug entirely, same reasoning as the MarkdownV2
 * escaper above.
 */
const HTML_SPECIAL_CHARS = /[&<>]/g;

export function escapeTelegramHtml(text: string): string {
  return text.replace(HTML_SPECIAL_CHARS, (ch) => {
    if (ch === "&") return "&amp;";
    if (ch === "<") return "&lt;";
    return "&gt;";
  });
}

/** Applies the correct escaper for `parseMode`, or returns `value` untouched when `parseMode` is `undefined` (plain text — Telegram never interprets anything as formatting in that mode, so escaping would only visually mangle the text for no safety benefit). */
export function escapeTelegramText(
  value: string,
  parseMode: TelegramParseMode | undefined
): string {
  if (parseMode === "MarkdownV2") return escapeTelegramMarkdownV2(value);
  if (parseMode === "HTML") return escapeTelegramHtml(value);
  return value;
}

/**
 * Tag names are user-authored too (article tags) — sanitized to a safe
 * hashtag charset (word characters only, matching what Telegram actually
 * auto-detects as a real `#hashtag`) BEFORE escaping. Sanitizing first means
 * the escaper only ever has to deal with a small, predictable charset
 * (letters/digits/underscore), and an all-underscore/all-stripped tag name
 * (e.g. one that was pure punctuation) correctly disappears rather than
 * producing an empty or malformed `#`.
 */
const HASHTAG_UNSAFE_CHARS = /[^\p{L}\p{N}_]+/gu;

export function buildTelegramHashtags(tagNames: readonly string[]): string[] {
  const seen = new Set<string>();
  const hashtags: string[] = [];

  for (const rawName of tagNames) {
    const normalized = rawName
      .replace(HASHTAG_UNSAFE_CHARS, "_")
      .replace(/^_+|_+$/g, "");

    if (normalized.length === 0) continue;

    const hashtag = `#${normalized}`;

    if (seen.has(hashtag)) continue;
    seen.add(hashtag);
    hashtags.push(hashtag);
  }

  return hashtags;
}

const MAX_TELEGRAM_MESSAGE_LENGTH = 4096;

/**
 * Builds the final `sendMessage` text. Every interpolated field is escaped
 * independently for the active `parseMode` (or passed through unescaped for
 * plain text) BEFORE being joined with static, always-safe line breaks — the
 * static scaffolding itself never needs escaping since it never contains
 * untrusted data and deliberately contains none of the MarkdownV2/HTML
 * special characters. Truncates to Telegram's documented 4096-character
 * `sendMessage` text limit as a last step (on the fully-escaped text, so a
 * truncation can never cut an escape sequence in a way that changes
 * meaning... a theoretical residual risk — see the doc comment on
 * `truncateTelegramMessageText` below).
 */
export function buildTelegramMessageText(
  content: SocialPublishContentSnapshot,
  hashtags: readonly string[],
  parseMode: TelegramParseMode | undefined
): string {
  const safeTitle = escapeTelegramText(content.title, parseMode);
  const safeExcerpt = content.excerptOrCaption
    ? escapeTelegramText(content.excerptOrCaption, parseMode)
    : "";
  const safeUrl = escapeTelegramText(content.canonicalUrl, parseMode);
  const safeHashtags = hashtags.map((tag) =>
    escapeTelegramText(tag, parseMode)
  );

  const lines = [safeTitle];

  if (safeExcerpt && safeExcerpt !== safeTitle) {
    lines.push("", safeExcerpt);
  }

  lines.push("", safeUrl);

  if (safeHashtags.length > 0) {
    lines.push("", safeHashtags.join(" "));
  }

  return truncateTelegramMessageText(lines.join("\n"));
}

/**
 * A naive character-count truncation of an ESCAPED MarkdownV2/HTML string
 * could, in principle, cut between a `\` and the character it escapes
 * (or inside an HTML entity like `&amp;`), changing meaning right at the
 * cut point. Mitigated here by trimming back to the nearest preceding `\n`
 * (message content is always line-oriented — title/excerpt/url/hashtags
 * each on their own line — so cutting at a line boundary never lands inside
 * an escape sequence or entity, both of which are always fully contained
 * within a single line in this module's own template). If the very first
 * line already exceeds the limit (an implausibly long single title), it is
 * hard-cut as a last resort — still bounded, never sent oversized to the
 * API (which would otherwise reject the whole message).
 */
export function truncateTelegramMessageText(text: string): string {
  if (text.length <= MAX_TELEGRAM_MESSAGE_LENGTH) {
    return text;
  }

  const hardCut = text.slice(0, MAX_TELEGRAM_MESSAGE_LENGTH);
  const lastNewline = hardCut.lastIndexOf("\n");

  return lastNewline > 0 ? hardCut.slice(0, lastNewline) : hardCut;
}
