import { describe, expect, test } from "bun:test";

import {
  renderSocialPublishCaption,
  validateCreateSocialPublishTemplateInput
} from "../../src/modules/social-publishing/domain/social-publish-template-validation";

describe("renderSocialPublishCaption (Issue #643)", () => {
  test("substitutes all three recognized placeholders", () => {
    const rendered = renderSocialPublishCaption(
      "{{title}} — {{excerpt}} {{canonicalUrl}}",
      {
        title: "Big News",
        excerpt: "Something happened.",
        canonicalUrl: "https://example.test/news/big-news"
      }
    );
    expect(rendered).toBe(
      "Big News — Something happened. https://example.test/news/big-news"
    );
  });

  test("leaves an unrecognized placeholder untouched", () => {
    const rendered = renderSocialPublishCaption("{{title}} {{unknown}}", {
      title: "Big News",
      excerpt: "",
      canonicalUrl: "https://example.test/news/big-news"
    });
    expect(rendered).toBe("Big News {{unknown}}");
  });

  test("substitutes repeated occurrences of the same placeholder", () => {
    const rendered = renderSocialPublishCaption("{{title}} / {{title}}", {
      title: "Repeat",
      excerpt: "",
      canonicalUrl: "https://example.test"
    });
    expect(rendered).toBe("Repeat / Repeat");
  });
});

describe("validateCreateSocialPublishTemplateInput (Issue #643)", () => {
  test("accepts a well-formed template", () => {
    const result = validateCreateSocialPublishTemplateInput({
      name: "Default",
      captionTemplate: "{{title}} {{canonicalUrl}}"
    });
    expect(result.valid).toBe(true);
  });

  test("rejects a name over 200 characters", () => {
    const result = validateCreateSocialPublishTemplateInput({
      name: "a".repeat(201),
      captionTemplate: "{{title}}"
    });
    expect(result.valid).toBe(false);
  });

  test("rejects a captionTemplate over 2000 characters", () => {
    const result = validateCreateSocialPublishTemplateInput({
      name: "Default",
      captionTemplate: "a".repeat(2001)
    });
    expect(result.valid).toBe(false);
  });

  test("rejects a malformed optional providerKey", () => {
    const result = validateCreateSocialPublishTemplateInput({
      name: "Default",
      captionTemplate: "{{title}}",
      providerKey: "Not Valid"
    });
    expect(result.valid).toBe(false);
  });
});
