/**
 * Bounded document-number format template grammar (Issue #751 security
 * requirement: "Template formatting cannot execute arbitrary code, SQL,
 * filesystem/network access, or unbounded regex"). A hand-written,
 * single-pass character scanner — deliberately NOT `eval`/`new Function`,
 * NOT a user-supplied regex, and NOT built from string concatenation into
 * a dynamically constructed regex (the exact three things the
 * requirement forbids). The token vocabulary is a small fixed allowlist;
 * anything outside it is rejected at DEFINITION time
 * (`validateNumberFormatTemplate`), so `renderNumberFormatTemplate` (the
 * function actually called on every number reservation) only ever
 * processes an already-validated template.
 *
 * Supported tokens: `{SEQ}` / `{SEQ:n}` (n = zero-pad width, 1-12),
 * `{YYYY}`, `{YY}`, `{MM}`, `{DD}`. Every other character must be a
 * literal from a small printable allowlist (letters, digits, space, and
 * `-_/.`) — this keeps a rendered document number safe to use as a
 * filename/title fragment and rules out control characters/newlines.
 */
import type { DocumentValidationError } from "./errors";

const MAX_TEMPLATE_LENGTH = 128;
const MAX_SEQ_WIDTH = 12;
const DATE_TOKENS = new Set(["YYYY", "YY", "MM", "DD"]);
const LITERAL_ALLOWLIST = "-_/. ";

type TokenKind = "seq" | "date_yyyy" | "date_yy" | "date_mm" | "date_dd";

type ParsedToken =
  | { ok: true; kind: TokenKind; seqWidth?: number }
  | { ok: false; message: string };

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isAllDigits(value: string): boolean {
  if (value.length === 0) return false;
  for (const ch of value) {
    if (!isDigit(ch)) return false;
  }
  return true;
}

function isAllowedLiteralChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  if (code >= 48 && code <= 57) return true; // 0-9
  if (code >= 65 && code <= 90) return true; // A-Z
  if (code >= 97 && code <= 122) return true; // a-z
  return LITERAL_ALLOWLIST.includes(ch);
}

function parseToken(token: string): ParsedToken {
  if (DATE_TOKENS.has(token)) {
    const kind =
      token === "YYYY"
        ? "date_yyyy"
        : token === "YY"
          ? "date_yy"
          : token === "MM"
            ? "date_mm"
            : "date_dd";
    return { ok: true, kind };
  }
  if (token === "SEQ") {
    return { ok: true, kind: "seq", seqWidth: 1 };
  }
  if (token.startsWith("SEQ:")) {
    const widthPart = token.slice(4);
    if (
      widthPart.length === 0 ||
      widthPart.length > 2 ||
      !isAllDigits(widthPart)
    ) {
      return {
        ok: false,
        message: `Invalid SEQ width in token "{${token}}" — must be 1-${MAX_SEQ_WIDTH} digits.`
      };
    }
    const width = Number(widthPart);
    if (width < 1 || width > MAX_SEQ_WIDTH) {
      return {
        ok: false,
        message: `SEQ width in token "{${token}}" must be between 1 and ${MAX_SEQ_WIDTH}.`
      };
    }
    return { ok: true, kind: "seq", seqWidth: width };
  }
  return { ok: false, message: `Unknown template token "{${token}}".` };
}

/**
 * Walks `template` exactly once, validating every `{...}` token against
 * the fixed grammar above and every other character against the literal
 * allowlist. Returns a list of errors (empty = valid). Requires exactly
 * one `{SEQ}`/`{SEQ:n}` token — a template with no sequence placeholder
 * can never produce distinct numbers.
 */
export function validateNumberFormatTemplate(
  template: string
): DocumentValidationError[] {
  const errors: DocumentValidationError[] = [];

  if (!template || template.length === 0) {
    errors.push({
      field: "formatTemplate",
      message: "formatTemplate is required."
    });
    return errors;
  }
  if (template.length > MAX_TEMPLATE_LENGTH) {
    errors.push({
      field: "formatTemplate",
      message: `formatTemplate must be at most ${MAX_TEMPLATE_LENGTH} characters.`
    });
    return errors;
  }

  let seqTokenCount = 0;
  let i = 0;
  while (i < template.length) {
    const ch = template[i]!;

    if (ch === "{") {
      const close = template.indexOf("}", i + 1);
      if (close === -1) {
        errors.push({
          field: "formatTemplate",
          message: `Unmatched '{' at position ${i}.`
        });
        break;
      }
      const token = template.slice(i + 1, close);
      const parsed = parseToken(token);
      if (!parsed.ok) {
        errors.push({ field: "formatTemplate", message: parsed.message });
      } else if (parsed.kind === "seq") {
        seqTokenCount += 1;
      }
      i = close + 1;
      continue;
    }

    if (ch === "}") {
      errors.push({
        field: "formatTemplate",
        message: `Unmatched '}' at position ${i}.`
      });
      i += 1;
      continue;
    }

    if (!isAllowedLiteralChar(ch)) {
      errors.push({
        field: "formatTemplate",
        message: `Character "${ch}" at position ${i} is not allowed in formatTemplate.`
      });
    }
    i += 1;
  }

  if (seqTokenCount === 0) {
    errors.push({
      field: "formatTemplate",
      message: "formatTemplate must contain exactly one {SEQ} or {SEQ:n} token."
    });
  } else if (seqTokenCount > 1) {
    errors.push({
      field: "formatTemplate",
      message: "formatTemplate must contain exactly one {SEQ} or {SEQ:n} token."
    });
  }

  return errors;
}

export type RenderNumberFormatTemplateInput = {
  sequenceValue: number;
  date: Date;
};

/**
 * Renders an ALREADY-VALIDATED template (call `validateNumberFormatTemplate`
 * at definition time — this function still defensively re-parses each
 * token with the SAME grammar and throws rather than silently emitting an
 * unrecognized token, so a template that somehow bypassed validation can
 * never render into attacker-controlled output).
 */
export function renderNumberFormatTemplate(
  template: string,
  input: RenderNumberFormatTemplateInput
): string {
  const year = input.date.getUTCFullYear();
  const month = input.date.getUTCMonth() + 1;
  const day = input.date.getUTCDate();

  let output = "";
  let i = 0;
  while (i < template.length) {
    const ch = template[i]!;
    if (ch === "{") {
      const close = template.indexOf("}", i + 1);
      if (close === -1) {
        throw new Error(
          `Invalid formatTemplate: unmatched '{' at position ${i}.`
        );
      }
      const token = template.slice(i + 1, close);
      const parsed = parseToken(token);
      if (!parsed.ok) {
        throw new Error(`Invalid formatTemplate: ${parsed.message}`);
      }
      switch (parsed.kind) {
        case "seq":
          output += String(input.sequenceValue).padStart(
            parsed.seqWidth ?? 1,
            "0"
          );
          break;
        case "date_yyyy":
          output += String(year).padStart(4, "0");
          break;
        case "date_yy":
          output += String(year % 100).padStart(2, "0");
          break;
        case "date_mm":
          output += String(month).padStart(2, "0");
          break;
        case "date_dd":
          output += String(day).padStart(2, "0");
          break;
      }
      i = close + 1;
      continue;
    }
    if (ch === "}") {
      throw new Error(
        `Invalid formatTemplate: unmatched '}' at position ${i}.`
      );
    }
    output += ch;
    i += 1;
  }
  return output;
}
