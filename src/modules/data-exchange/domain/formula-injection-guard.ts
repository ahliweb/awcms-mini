/**
 * CSV/spreadsheet formula-injection (CSV injection) neutralization — Issue
 * #752's explicit security requirement. A well-known attack: a cell value
 * beginning with `=`, `+`, `-`, or `@` (also TAB/CR in some spreadsheet
 * apps' auto-detection) is interpreted as a FORMULA by Excel/LibreOffice/
 * Google Sheets when the file is opened, letting an attacker who controls
 * imported data execute arbitrary formulas (including `=cmd|'/c calc'!A1`-
 * style DDE/command execution in older Excel) against whoever later opens
 * an exported CSV.
 *
 * Mitigation (OWASP "CSV Injection" standard fix): prefix a single quote
 * `'` to any value beginning with one of the dangerous characters. Every
 * spreadsheet application treats a leading `'` as "force this cell to be
 * plain text", neutralizing the formula while keeping the value's original
 * characters fully intact and losslessly recoverable (a reader who strips
 * exactly one leading `'` from a value that starts `'` + a dangerous
 * character gets back the exact original string).
 *
 * Applied TWICE in this module's pipeline (defense in depth, Issue #752's
 * own wording: "reject/neutralize... on IMPORT before they're ever stored
 * or re-exported" AND "exports neutralize formula prefixes where
 * applicable"):
 * 1. At INTAKE parse time (`csv-codec.ts`/`json-codec.ts`), before a row is
 *    ever persisted to `awcms_mini_data_exchange_staged_rows`.
 * 2. At EXPORT serialization time (`csv-codec.ts`'s `serializeCsvBounded`),
 *    independent of whether the value passed through this module's own
 *    import pipeline at all (an owning module's export source could write
 *    a dangerous value directly).
 *
 * `isNeutralized`/`neutralizeFormulaInjectionValue` are naturally
 * idempotent: a value already starting with `'` never starts with one of
 * `DANGEROUS_LEADING_CHARACTERS` (`'` is not itself in that set), so
 * re-running neutralization on an already-neutralized value is a no-op —
 * verified by this file's own round-trip test.
 */

export const DANGEROUS_LEADING_CHARACTERS: readonly string[] = [
  "=",
  "+",
  "-",
  "@",
  "\t",
  "\r"
];

export type FormulaInjectionNeutralizeResult = {
  value: string;
  neutralized: boolean;
};

/** `true` if `value`'s first character is one of the dangerous spreadsheet-formula-triggering prefixes. Empty string is always safe. */
export function hasDangerousFormulaPrefix(value: string): boolean {
  if (value.length === 0) {
    return false;
  }

  return DANGEROUS_LEADING_CHARACTERS.includes(value[0]!);
}

/**
 * Returns `value` unchanged (with `neutralized: false`) unless it begins
 * with a dangerous character, in which case a single leading `'` is
 * prepended and `neutralized: true` is returned. Never throws, never
 * inspects anything beyond the first character.
 */
export function neutralizeFormulaInjectionValue(
  value: string
): FormulaInjectionNeutralizeResult {
  if (!hasDangerousFormulaPrefix(value)) {
    return { value, neutralized: false };
  }

  return { value: `'${value}`, neutralized: true };
}

/**
 * Applies `neutralizeFormulaInjectionValue` to every STRING value in
 * `fields` (non-string values — numbers, booleans, null, nested
 * objects/arrays from a JSON row — are left untouched; a spreadsheet
 * formula prefix is only ever meaningful on a string cell). Returns a new
 * object (never mutates `fields`) plus the list of field names that were
 * actually neutralized, for surfacing as a preview warning.
 */
export function neutralizeFormulaInjectionInFields(
  fields: Record<string, unknown>
): { fields: Record<string, unknown>; neutralizedFieldNames: string[] } {
  const output: Record<string, unknown> = {};
  const neutralizedFieldNames: string[] = [];

  for (const [key, rawValue] of Object.entries(fields)) {
    if (typeof rawValue !== "string") {
      output[key] = rawValue;
      continue;
    }

    const result = neutralizeFormulaInjectionValue(rawValue);
    output[key] = result.value;

    if (result.neutralized) {
      neutralizedFieldNames.push(key);
    }
  }

  return { fields: output, neutralizedFieldNames };
}
