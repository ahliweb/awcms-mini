import { describe, expect, test } from "bun:test";

import { buildSocialPublishIdempotencyKey } from "../../src/modules/social-publishing/domain/social-publish-idempotency";

describe("buildSocialPublishIdempotencyKey (Issue #643)", () => {
  test("is deterministic for the same (tenant, article, account, provider, action)", () => {
    const a = buildSocialPublishIdempotencyKey(
      "tenant-1",
      "article-1",
      "account-1",
      "telegram_channel",
      "publish"
    );
    const b = buildSocialPublishIdempotencyKey(
      "tenant-1",
      "article-1",
      "account-1",
      "telegram_channel",
      "publish"
    );
    expect(a).toBe(b);
  });

  test("differs when any single input changes", () => {
    const base = buildSocialPublishIdempotencyKey(
      "tenant-1",
      "article-1",
      "account-1",
      "telegram_channel",
      "publish"
    );

    expect(
      buildSocialPublishIdempotencyKey(
        "tenant-2",
        "article-1",
        "account-1",
        "telegram_channel",
        "publish"
      )
    ).not.toBe(base);

    expect(
      buildSocialPublishIdempotencyKey(
        "tenant-1",
        "article-2",
        "account-1",
        "telegram_channel",
        "publish"
      )
    ).not.toBe(base);

    expect(
      buildSocialPublishIdempotencyKey(
        "tenant-1",
        "article-1",
        "account-2",
        "telegram_channel",
        "publish"
      )
    ).not.toBe(base);

    expect(
      buildSocialPublishIdempotencyKey(
        "tenant-1",
        "article-1",
        "account-1",
        "facebook_page",
        "publish"
      )
    ).not.toBe(base);
  });

  test("returns a hex sha256 digest", () => {
    const key = buildSocialPublishIdempotencyKey(
      "tenant-1",
      "article-1",
      "account-1",
      "telegram_channel",
      "publish"
    );
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });
});
