import { escapeHtml } from "../../../lib/html/escape";

/**
 * Safe, whitelist-based renderer for `content_json` (Issue #540 §Content
 * Safety Requirements: "Use structured JSON content as the source of
 * truth", "Rendering must sanitize or safely render content", "Script
 * tags/inline JavaScript/dangerous iframe-embed must be rejected or
 * stripped"). `content_json` was already write-time-rejected for unsafe
 * markup (`validateContentJsonField`, Issue #538) — this is the
 * *rendering*-side defense-in-depth layer: every block type in the
 * whitelist below only ever emits text through `escapeHtml`, and any
 * value outside the whitelist (unknown block `type`, non-string `text`,
 * raw HTML field, etc.) is silently skipped rather than rendered. There
 * is no "raw html" block type — by construction, this renderer cannot
 * emit a `<script>`/`<iframe>`/`<embed>`/`<object>` tag or an inline
 * event handler no matter what `content_json` contains.
 *
 * This is the first place in the repo that defines a concrete shape for
 * `content_json` (previously "opaque to the API", doc issue #537/#538) —
 * `{ blocks: ContentBlock[] }` with four block types (paragraph, heading,
 * list, quote). A derived app or later issue needing richer blocks
 * (image, embed, table, ...) extends the `switch` below, not a general
 * raw-HTML escape hatch.
 */
export type ContentBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: "list"; ordered?: boolean; items: string[] }
  | { type: "quote"; text: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderParagraph(text: unknown): string | null {
  if (typeof text !== "string" || text.trim().length === 0) {
    return null;
  }

  return `<p>${escapeHtml(text)}</p>`;
}

function renderHeading(level: unknown, text: unknown): string | null {
  if (
    typeof text !== "string" ||
    text.trim().length === 0 ||
    typeof level !== "number" ||
    !Number.isInteger(level) ||
    level < 1 ||
    level > 6
  ) {
    return null;
  }

  return `<h${level}>${escapeHtml(text)}</h${level}>`;
}

function renderList(ordered: unknown, items: unknown): string | null {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }

  const listItems = items
    .filter(
      (item): item is string =>
        typeof item === "string" && item.trim().length > 0
    )
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");

  if (listItems.length === 0) {
    return null;
  }

  const tag = ordered === true ? "ol" : "ul";
  return `<${tag}>${listItems}</${tag}>`;
}

function renderQuote(text: unknown): string | null {
  if (typeof text !== "string" || text.trim().length === 0) {
    return null;
  }

  return `<blockquote>${escapeHtml(text)}</blockquote>`;
}

function renderBlock(block: unknown): string | null {
  if (!isRecord(block)) {
    return null;
  }

  switch (block.type) {
    case "paragraph":
      return renderParagraph(block.text);
    case "heading":
      return renderHeading(block.level, block.text);
    case "list":
      return renderList(block.ordered, block.items);
    case "quote":
      return renderQuote(block.text);
    default:
      return null;
  }
}

/** Renders `contentJson.blocks` to a safe HTML string. Malformed/unknown blocks are silently skipped, never thrown — a corrupt or unexpected shape must degrade to "renders less", not a 500 with a stack trace (doc issue #540: "Error output must not expose stack traces"). */
export function renderContentJsonToHtml(
  contentJson: Record<string, unknown>
): string {
  const blocks = contentJson.blocks;

  if (!Array.isArray(blocks)) {
    return "";
  }

  return blocks
    .map((block) => renderBlock(block))
    .filter((html): html is string => html !== null)
    .join("\n");
}
