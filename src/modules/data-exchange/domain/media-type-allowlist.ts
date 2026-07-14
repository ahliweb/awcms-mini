/**
 * Media-type (Content-Type) allow-list per import format (Issue #752
 * acceptance criterion: "Intake enforces checksum, media type, size/row/
 * field/time bounds, and safe filename handling" — reviewer finding on PR
 * #782: this check was previously documented as done
 * (`module.ts`'s `imports.create` permission description) but never
 * actually implemented anywhere).
 *
 * Client-declared (`File.type`, from the multipart upload), NOT verified
 * against the file's actual bytes via magic-byte sniffing — unlike
 * `news_media`'s `news-media-mime-sniffer.ts`, CSV/JSON have no reliable
 * magic-byte signature to sniff the way binary image formats do (a CSV
 * file is arbitrary text; a JSON file starts with `{`/`[`, indistinguishable
 * from many other text formats at the byte level). This is intake SHAPE
 * validation — rejecting an obviously-wrong declared type before any row
 * parsing — matching what `news_media`'s own create-session step already
 * does before any bytes exist (`news-media-upload-session-validation.ts`'s
 * own header comment: "validates SHAPE ONLY at create time").
 *
 * Only two formats exist in this module's scope (`csv`/`json`, Issue #752
 * §Scope: "Support CSV and JSON as the baseline; add other formats only
 * through later admission/evidence") so a fixed, module-owned allow-list
 * is sufficient — not a per-descriptor-customizable field (which would be
 * a bigger, shared `module-contract.ts` change for no real benefit while
 * only two formats exist).
 *
 * Runtime caveat, verified directly against this repo's Bun version
 * (`tests/integration/data-exchange.integration.test.ts`'s own media-type
 * tests): a `File` object's `.type`, once round-tripped through a
 * `multipart/form-data` `Request` body and re-parsed via
 * `request.formData()`, reflects Bun's OWN filename-extension-based
 * inference — it does NOT preserve an explicit per-part `Content-Type`
 * multipart header, even when a client deliberately sends one. In
 * practice this means `mediaType` here is closer to a FILE-EXTENSION
 * allow-list than a literal client-declared-header check — still a real,
 * enforced intake bound (an upload named `evil.exe`/`evil.png` is
 * rejected regardless of what Content-Type header the client sent), just
 * not exactly the "trust the client's declared Content-Type verbatim"
 * mental model the field name might suggest.
 */

const MEDIA_TYPE_ALLOWLIST: Record<"csv" | "json", readonly string[]> = {
  csv: [
    "text/csv",
    "application/csv",
    "text/plain",
    "application/vnd.ms-excel"
  ],
  json: ["application/json", "text/json", "text/plain"]
};

/** Strips a `; charset=...`/other parameter suffix and lowercases — `File.type`/`Content-Type` sometimes carries one (`text/csv; charset=utf-8`). */
function normalizeMediaType(raw: string): string {
  const withoutParameters = raw.split(";")[0] ?? "";
  return withoutParameters.trim().toLowerCase();
}

/** `false` for an empty/missing media type — Issue #752 requires media type to be ENFORCED, not silently accepted when absent. */
export function isAllowedMediaType(
  format: "csv" | "json",
  mediaType: string
): boolean {
  if (mediaType.length === 0) {
    return false;
  }

  return MEDIA_TYPE_ALLOWLIST[format].includes(normalizeMediaType(mediaType));
}

export function allowedMediaTypesFor(
  format: "csv" | "json"
): readonly string[] {
  return MEDIA_TYPE_ALLOWLIST[format];
}
