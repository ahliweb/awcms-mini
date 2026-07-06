/**
 * Minimal, dependency-free parser for the standard gettext `.po` format
 * (doc 14 §Internationalization). Deliberately Bun-only/no-dependency: rather
 * than pull in a Node-oriented gettext package (AGENTS.md rule 14 — Node
 * tooling exceptions need explicit sign-off), this hand-rolls just the
 * subset AWCMS-Mini's flat `namespace.key` catalogs need: `msgid`/`msgstr`
 * pairs, multi-line concatenated quoted strings, `#`-comments, and the
 * standard backslash escapes (`\"`, `\\`, `\n`, `\t`).
 *
 * Not implemented (not needed for flat UI-string catalogs): `msgid_plural`/
 * plural forms, `msgctxt` context, fuzzy/obsolete markers. A `.po` file's
 * first `msgid ""` entry is the standard PO header (Content-Type, plural
 * rules, etc., as `msgstr` metadata lines) — parsed and discarded, not an
 * error.
 */

export type ParsedCatalog = Record<string, string>;

const KNOWN_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  n: "\n",
  t: "\t"
};

/**
 * Decodes a single double-quoted PO string literal's escape sequences.
 * Assumes `raw` is the content between the quotes (quotes already stripped).
 */
function decodeEscapes(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === "\\" && i + 1 < raw.length) {
      const next = raw[i + 1]!;
      const replacement = KNOWN_ESCAPES[next];
      if (replacement !== undefined) {
        out += replacement;
        i++;
        continue;
      }
    }
    out += char;
  }
  return out;
}

/**
 * Extracts the quoted string starting at `line` (already trimmed) after a
 * `msgid`/`msgstr` keyword, e.g. `msgid "hello"` -> `hello`. Returns null if
 * the line has no quoted string (malformed).
 */
function extractQuoted(line: string): string | null {
  const firstQuote = line.indexOf('"');
  const lastQuote = line.lastIndexOf('"');
  if (firstQuote === -1 || lastQuote <= firstQuote) {
    return null;
  }
  return decodeEscapes(line.slice(firstQuote + 1, lastQuote));
}

/**
 * A continuation line is a standalone quoted string (PO's line-wrapping
 * convention for long msgid/msgstr values), e.g. `"...more text"`.
 */
function isContinuationLine(line: string): boolean {
  return line.startsWith('"') && line.endsWith('"') && line.length >= 2;
}

/**
 * Parses `.po` source into a flat `{ msgid: msgstr }` map. Malformed entries
 * (msgid without a following msgstr) are skipped rather than throwing — a
 * single bad entry in a translator-edited file should not take down the
 * whole catalog.
 */
export function parsePo(source: string): ParsedCatalog {
  const catalog: ParsedCatalog = {};
  const lines = source.split(/\r\n|\n/);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!.trim();

    if (line.length === 0 || line.startsWith("#")) {
      i++;
      continue;
    }

    if (!line.startsWith("msgid ")) {
      i++;
      continue;
    }

    let msgid = extractQuoted(line) ?? "";
    i++;

    while (i < lines.length && isContinuationLine(lines[i]!.trim())) {
      msgid += decodeEscapes(lines[i]!.trim().slice(1, -1));
      i++;
    }

    // Skip blank/comment lines between msgid and msgstr.
    while (i < lines.length && lines[i]!.trim().length === 0) {
      i++;
    }

    if (i >= lines.length || !lines[i]!.trim().startsWith("msgstr ")) {
      // Malformed: msgid with no msgstr. Skip this entry.
      continue;
    }

    let msgstr = extractQuoted(lines[i]!.trim()) ?? "";
    i++;

    while (i < lines.length && isContinuationLine(lines[i]!.trim())) {
      msgstr += decodeEscapes(lines[i]!.trim().slice(1, -1));
      i++;
    }

    // The PO header entry (msgid "") carries file metadata, not a real key.
    if (msgid.length > 0) {
      catalog[msgid] = msgstr;
    }
  }

  return catalog;
}
