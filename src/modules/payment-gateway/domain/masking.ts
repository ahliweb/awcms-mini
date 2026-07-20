import {
  redactSecretsInText,
  redactSensitiveAttributes
} from "../../_shared/redaction";

/**
 * Provider-reference + webhook-snippet masking for `payment_gateway` (Issue
 * #877, ADR-0022 §8 Medium-2). PURE. A provider reference (checkout/charge/
 * refund id) is an OPAQUE, non-secret id — but it is still MASKED in logs/audit
 * to a short prefix so a full id is never scattered across observability sinks.
 * A stored webhook troubleshooting snippet passes through the SAME PII-key +
 * secret-pattern redaction `integration_hub` uses (never raw name/email/NPWP/
 * NIK/phone/address, never a secret) and is bounded — never the full raw body.
 */

/** The bound on a stored MASKED webhook snippet (data minimization). */
export const MASKED_SNIPPET_MAX_LENGTH = 512;

/**
 * Mask a provider reference for a log/audit attribute: keep at most the first 6
 * chars, replace the rest with an ellipsis. `null`/empty -> `null`. Never the
 * full id.
 */
export function maskProviderReference(
  ref: string | null | undefined
): string | null {
  if (typeof ref !== "string" || ref.length === 0) return null;
  if (ref.length <= 6) return `${ref.slice(0, 2)}***`;
  return `${ref.slice(0, 6)}…`;
}

/**
 * Build the bounded, MASKED troubleshooting snippet persisted for a
 * signature-VALID delivery only. When the parsed body is a JSON object, run
 * PII-KEY redaction (`redactSensitiveAttributes`) then bound it; otherwise fall
 * back to secret-PATTERN redaction of the truncated raw text. Never the full raw
 * body, never raw PII/secret.
 */
export function buildMaskedSnippet(rawBody: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return redactSecretsInText(rawBody.slice(0, MASKED_SNIPPET_MAX_LENGTH));
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const redacted = redactSensitiveAttributes(
      parsed as Record<string, unknown>
    );
    return redactSecretsInText(
      JSON.stringify(redacted).slice(0, MASKED_SNIPPET_MAX_LENGTH)
    );
  }
  return redactSecretsInText(rawBody.slice(0, MASKED_SNIPPET_MAX_LENGTH));
}
