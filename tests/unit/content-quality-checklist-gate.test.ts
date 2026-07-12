/**
 * Unit tests for `content-quality-checklist-gate.ts` (Issue #640) — the
 * application-layer orchestration between the pure evaluator and a
 * `NewsMediaPort`. Uses a fake in-memory `NewsMediaPort` (same technique
 * `news-media-port.ts`'s own header describes: any function taking a
 * `NewsMediaPort` parameter can be unit-tested without a real database by
 * injecting a fake), so no DATABASE_URL/Postgres is needed — `tx` is never
 * actually dereferenced by the fake, only forwarded.
 */
import { describe, expect, test } from "bun:test";

import { evaluateContentQualityChecklistForContent } from "../../src/modules/blog-content/application/content-quality-checklist-gate";
import type {
  NewsMediaPort,
  ResolvedNewsMediaReferenceDTO
} from "../../src/modules/_shared/ports/news-media-port";

const FEATURED_ID = "11111111-1111-1111-1111-111111111111";
const GALLERY_ID = "22222222-2222-2222-2222-222222222222";

function fakePort(options: {
  modeActive: boolean;
  resolvable?: Record<string, ResolvedNewsMediaReferenceDTO>;
}): NewsMediaPort {
  const resolvable = options.resolvable ?? {};

  return {
    async isFullOnlineR2ModeActiveForTenant() {
      return options.modeActive;
    },
    async isMediaReferenceSafe(_tx, _tenantId, mediaObjectId) {
      return mediaObjectId in resolvable;
    },
    async resolveMediaReferences(_tx, _tenantId, mediaObjectIds) {
      const map = new Map<string, ResolvedNewsMediaReferenceDTO>();
      for (const id of mediaObjectIds) {
        if (resolvable[id]) {
          map.set(id, resolvable[id]);
        }
      }
      return map;
    }
  };
}

const FAKE_TX = {} as Bun.SQL;

const BASE_CONTENT = {
  title: "Hello",
  slug: "hello",
  excerpt: "Excerpt",
  metaDescription: "Meta description",
  contentText: "Body",
  contentJson: { blocks: [{ type: "paragraph", text: "Body" }] },
  featuredMediaId: null as string | null
};

describe("evaluateContentQualityChecklistForContent (Issue #640)", () => {
  test("returns a non-applicable result when full-online R2-only mode is not active for the tenant", async () => {
    const result = await evaluateContentQualityChecklistForContent(
      FAKE_TX,
      "tenant-a",
      "post",
      BASE_CONTENT,
      0,
      fakePort({ modeActive: false }),
      {}
    );

    expect(result.applicable).toBe(false);
    expect(result.passed).toBe(true);
  });

  test("resolves featuredMediaId through the port and passes when verified", async () => {
    const result = await evaluateContentQualityChecklistForContent(
      FAKE_TX,
      "tenant-a",
      "post",
      { ...BASE_CONTENT, featuredMediaId: FEATURED_ID },
      1,
      fakePort({
        modeActive: true,
        resolvable: {
          [FEATURED_ID]: {
            publicUrl: "https://media.example.test/x.jpg",
            altText: "Alt",
            mimeType: "image/jpeg",
            width: 800,
            height: 600,
            sizeBytes: 1000
          }
        }
      }),
      {}
    );

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  test("blocks when featuredMediaId does not resolve (unverified/cross-tenant/nonexistent)", async () => {
    const result = await evaluateContentQualityChecklistForContent(
      FAKE_TX,
      "tenant-a",
      "post",
      { ...BASE_CONTENT, featuredMediaId: FEATURED_ID },
      1,
      fakePort({ modeActive: true, resolvable: {} }),
      {}
    );

    expect(result.passed).toBe(false);
    expect(result.blockers.map((b) => b.ruleId)).toContain(
      "featured_image_verified_r2"
    );
  });

  test("resolves gallery mediaObjectIds via the port and blocks the unresolved one", async () => {
    const result = await evaluateContentQualityChecklistForContent(
      FAKE_TX,
      "tenant-a",
      "post",
      {
        ...BASE_CONTENT,
        contentJson: {
          blocks: [
            {
              type: "gallery",
              items: [{ mediaType: "image", mediaObjectId: GALLERY_ID }]
            }
          ]
        }
      },
      1,
      fakePort({ modeActive: true, resolvable: {} }),
      {}
    );

    expect(result.passed).toBe(false);
    expect(result.blockers.map((b) => b.ruleId)).toContain(
      "gallery_images_verified"
    );
  });

  test("tenant policy override is applied through to the pure evaluator", async () => {
    const result = await evaluateContentQualityChecklistForContent(
      FAKE_TX,
      "tenant-a",
      "post",
      { ...BASE_CONTENT, excerpt: null },
      1,
      fakePort({ modeActive: true }),
      { excerpt_present: "blocking" }
    );

    expect(result.passed).toBe(false);
    expect(result.blockers.map((b) => b.ruleId)).toContain("excerpt_present");
  });
});
