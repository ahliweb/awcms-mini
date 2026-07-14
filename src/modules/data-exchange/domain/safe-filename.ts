/**
 * Safe filename metadata (Issue #752 acceptance criterion: "Intake
 * enforces ... safe filename handling"). A client-supplied filename is
 * NEVER used to build a filesystem path (this module stores content
 * inline in the database, never on disk keyed by the client's name) — it
 * is display-only metadata, but still sanitized before storage/return so
 * it can never carry a path-traversal shape (`../`), a null byte, control
 * characters, or an unbounded length into any log line, audit attribute,
 * or admin UI table cell.
 */

const MAX_FILENAME_LENGTH = 255;

/**
 * Matches ASCII control characters (code points 0-31 and 127), built from
 * a plain string passed to the `RegExp` constructor (rather than a regex
 * literal containing raw escape sequences) so the source file never
 * embeds an actual control byte.
 */
const CONTROL_CHARACTERS_PATTERN = new RegExp("[\\x00-\\x1f\\x7f]", "g");

export function sanitizeDisplayFilename(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }

  const withoutControlChars = raw.replace(CONTROL_CHARACTERS_PATTERN, "");
  // Keep only the final path segment — strips any directory traversal
  // shape (`../../etc/passwd`, `..\\..\\`) regardless of separator style.
  const lastSegment =
    withoutControlChars.split(/[/\\]/).pop() ?? withoutControlChars;
  const trimmed = lastSegment.trim();

  if (trimmed.length === 0) {
    return null;
  }

  return trimmed.slice(0, MAX_FILENAME_LENGTH);
}
