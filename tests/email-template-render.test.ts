import { describe, expect, test } from "bun:test";

import { renderEmailTemplate } from "../src/modules/email/domain/email-template-render";

describe("renderEmailTemplate", () => {
  test("substitutes variables into subject and text body without escaping", () => {
    const result = renderEmailTemplate(
      {
        subjectTemplate: "Reset your password, {{userName}}",
        textBodyTemplate: "Click {{resetUrl}} to reset.",
        htmlBodyTemplate: null
      },
      {
        userName: "Alice & Bob",
        resetUrl: "https://example.com/reset?token=abc"
      }
    );

    expect(result.subject).toBe("Reset your password, Alice & Bob");
    expect(result.textBody).toBe(
      "Click https://example.com/reset?token=abc to reset."
    );
    expect(result.htmlBody).toBeUndefined();
  });

  test("HTML-escapes values substituted into the HTML body only", () => {
    const result = renderEmailTemplate(
      {
        subjectTemplate: "Hello {{name}}",
        textBodyTemplate: null,
        htmlBodyTemplate: "<p>Hello {{name}}</p>"
      },
      { name: "<script>alert(1)</script>" }
    );

    expect(result.subject).toBe("Hello <script>alert(1)</script>");
    expect(result.htmlBody).toBe(
      "<p>Hello &lt;script&gt;alert(1)&lt;/script&gt;</p>"
    );
  });

  test("missing variables render as an empty string, never a literal token", () => {
    const result = renderEmailTemplate(
      {
        subjectTemplate: "Hi {{missing}}",
        textBodyTemplate: "Body {{alsoMissing}}",
        htmlBodyTemplate: null
      },
      {}
    );

    expect(result.subject).toBe("Hi ");
    expect(result.textBody).toBe("Body ");
  });
});
