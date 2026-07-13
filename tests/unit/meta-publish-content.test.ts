import { describe, expect, test } from "bun:test";

import {
  isAcceptableProviderMediaUrl,
  validateFacebookPagePublishEligibility,
  validateInstagramPublishEligibility
} from "../../src/modules/social-publishing/domain/meta-publish-content";
import type { SocialPublishContentSnapshot } from "../../src/modules/social-publishing/domain/social-provider-adapter";

const R2_ENV = { NEWS_MEDIA_R2_PUBLIC_BASE_URL: "https://media.example.com" };

function content(
  overrides: Partial<SocialPublishContentSnapshot> = {}
): SocialPublishContentSnapshot {
  return {
    title: "Hello world",
    excerptOrCaption: "An eligible article about the world.",
    canonicalUrl: "https://tenant.example.test/news/hello-world",
    imageUrl: null,
    ...overrides
  };
}

describe("validateFacebookPagePublishEligibility (Issue #644)", () => {
  test("eligible with no image (link post — Facebook scrapes its own preview)", () => {
    expect(validateFacebookPagePublishEligibility(content())).toEqual({
      eligible: true
    });
  });

  test("ineligible without a canonical URL", () => {
    const result = validateFacebookPagePublishEligibility(
      content({ canonicalUrl: "" })
    );
    expect(result).toEqual({
      eligible: false,
      errorCode: "missing_canonical_url",
      errorMessage: expect.any(String)
    });
  });

  test("ineligible without a caption", () => {
    const result = validateFacebookPagePublishEligibility(
      content({ excerptOrCaption: "   " })
    );
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.errorCode).toBe("missing_caption");
    }
  });
});

describe("validateInstagramPublishEligibility (Issue #644)", () => {
  test("ineligible without an image — Instagram has no text-only link post", () => {
    const result = validateInstagramPublishEligibility(content(), R2_ENV);
    expect(result).toEqual({
      eligible: false,
      errorCode: "unsupported_content_type",
      errorMessage: expect.any(String)
    });
  });

  test("eligible with a verified R2 image URL", () => {
    const result = validateInstagramPublishEligibility(
      content({ imageUrl: "https://media.example.com/news/1/photo.jpg" }),
      R2_ENV
    );
    expect(result).toEqual({ eligible: true });
  });

  test("ineligible when the image URL is not from the configured R2 origin (defense-in-depth — Issue #644 acceptance criterion)", () => {
    const result = validateInstagramPublishEligibility(
      content({ imageUrl: "https://evil.example.com/photo.jpg" }),
      R2_ENV
    );
    expect(result).toEqual({
      eligible: false,
      errorCode: "unverified_media_url",
      errorMessage: expect.any(String)
    });
  });
});

describe("isAcceptableProviderMediaUrl (Issue #644 — R2 image validation)", () => {
  test("accepts an https URL matching the configured origin exactly", () => {
    expect(
      isAcceptableProviderMediaUrl(
        "https://media.example.com/path/to/image.jpg",
        R2_ENV
      )
    ).toBe(true);
  });

  test("rejects a different host, even as a suffix/prefix trick", () => {
    expect(
      isAcceptableProviderMediaUrl(
        "https://media.example.com.evil.com/image.jpg",
        R2_ENV
      )
    ).toBe(false);
    expect(
      isAcceptableProviderMediaUrl(
        "https://evil-media.example.com/image.jpg",
        R2_ENV
      )
    ).toBe(false);
  });

  test("rejects a trailing-dot FQDN bypass attempt (Issue #635 lesson)", () => {
    expect(
      isAcceptableProviderMediaUrl(
        "https://media.example.com./image.jpg",
        R2_ENV
      )
    ).toBe(false);
  });

  test("rejects a non-https scheme even on the right host", () => {
    expect(
      isAcceptableProviderMediaUrl("http://media.example.com/image.jpg", R2_ENV)
    ).toBe(false);
  });

  test("rejects an unparseable URL", () => {
    expect(isAcceptableProviderMediaUrl("not-a-url", R2_ENV)).toBe(false);
  });

  test("false when NEWS_MEDIA_R2_PUBLIC_BASE_URL is not configured", () => {
    expect(
      isAcceptableProviderMediaUrl("https://media.example.com/image.jpg", {})
    ).toBe(false);
  });
});
