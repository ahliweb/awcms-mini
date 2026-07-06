/**
 * Minimal template rendering (Issue #495) — just enough for the dispatcher
 * to turn a claimed `email_messages` row's `template_key`/`variables` into
 * actual send content, since `sql/020` (Issue #494) deliberately does not
 * persist a rendered body. This is intentionally NOT the full "safe
 * rendering" scope of Issue #498 (per-category variable allowlists,
 * preview/dry-run, default system templates) — it is a narrow seam #498
 * is expected to replace/extend, not a competing implementation. The only
 * safety property enforced here: values substituted into
 * `htmlBodyTemplate` are HTML-escaped (basic XSS prevention); values
 * substituted into `textBodyTemplate`/`subjectTemplate` are not (plain
 * text has no markup to escape).
 */

export type EmailTemplateSource = {
  subjectTemplate: string;
  textBodyTemplate: string | null;
  htmlBodyTemplate: string | null;
};

export type RenderedEmail = {
  subject: string;
  textBody?: string;
  htmlBody?: string;
};

const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

function escapeHtmlValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Unknown/missing variables render as an empty string — never leaves a literal `{{token}}` in sent content. */
function substitute(
  template: string,
  variables: Record<string, string>,
  escapeHtml: boolean
): string {
  return template.replace(VARIABLE_PATTERN, (_match, key: string) => {
    const raw = variables[key] ?? "";
    return escapeHtml ? escapeHtmlValue(raw) : raw;
  });
}

export function renderEmailTemplate(
  template: EmailTemplateSource,
  variables: Record<string, string>
): RenderedEmail {
  return {
    subject: substitute(template.subjectTemplate, variables, false),
    textBody: template.textBodyTemplate
      ? substitute(template.textBodyTemplate, variables, false)
      : undefined,
    htmlBody: template.htmlBodyTemplate
      ? substitute(template.htmlBodyTemplate, variables, true)
      : undefined
  };
}
