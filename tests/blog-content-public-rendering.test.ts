import { describe, expect, test } from "bun:test";

import {
  collectRenderableGalleryMediaObjectIds,
  renderContentJsonToHtml
} from "../src/modules/blog-content/domain/content-block-rendering";
import {
  resolveCanonicalUrl,
  resolveMetaDescription,
  resolveOgImageUrl,
  resolveSeoTitle
} from "../src/modules/blog-content/domain/seo-rendering";
import {
  renderPaginationNavHtml,
  renderPostSummaryListHtml,
  renderPublicPageShell
} from "../src/modules/blog-content/domain/public-page-rendering";
import { escapeHtml } from "../src/lib/html/escape";

describe("escapeHtml", () => {
  test("escapes all five special characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("renderContentJsonToHtml", () => {
  test("renders a paragraph block, escaped", () => {
    const html = renderContentJsonToHtml({
      blocks: [{ type: "paragraph", text: "<script>alert(1)</script>" }]
    });
    expect(html).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  });

  test("renders a heading with a valid level", () => {
    const html = renderContentJsonToHtml({
      blocks: [{ type: "heading", level: 2, text: "Hello" }]
    });
    expect(html).toBe("<h2>Hello</h2>");
  });

  test("skips a heading with an out-of-range level", () => {
    const html = renderContentJsonToHtml({
      blocks: [{ type: "heading", level: 9, text: "Hello" }]
    });
    expect(html).toBe("");
  });

  test("renders an unordered and ordered list", () => {
    const unordered = renderContentJsonToHtml({
      blocks: [{ type: "list", items: ["a", "b"] }]
    });
    expect(unordered).toBe("<ul><li>a</li><li>b</li></ul>");

    const ordered = renderContentJsonToHtml({
      blocks: [{ type: "list", ordered: true, items: ["a"] }]
    });
    expect(ordered).toBe("<ol><li>a</li></ol>");
  });

  test("renders a quote block, escaped", () => {
    const html = renderContentJsonToHtml({
      blocks: [{ type: "quote", text: "To be & not to be" }]
    });
    expect(html).toBe("<blockquote>To be &amp; not to be</blockquote>");
  });

  test("silently skips an unknown block type", () => {
    const html = renderContentJsonToHtml({
      blocks: [{ type: "raw_html", html: "<script>evil()</script>" }]
    });
    expect(html).toBe("");
  });

  test("never emits a script/iframe/embed/object tag regardless of input", () => {
    const html = renderContentJsonToHtml({
      blocks: [
        { type: "paragraph", text: "<iframe src=evil></iframe>" },
        { type: "list", items: ["<embed src=evil>", "<object data=evil>"] },
        { type: "quote", text: "<img src=x onerror=alert(1)>" }
      ]
    });
    // Safety property: every "<" that came from user content is escaped to
    // "&lt;" — so no *unescaped* opening tag can ever reach the browser's
    // HTML parser, regardless of what tag/attribute name appears inside
    // the now-inert escaped text (e.g. "&lt;img ... onerror=...&gt;" is
    // literal text, not a parsed <img> element).
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<embed");
    expect(html).not.toContain("<object");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;iframe");
    expect(html).toContain("&lt;img");
  });

  test("returns empty string when blocks is missing or not an array", () => {
    expect(renderContentJsonToHtml({})).toBe("");
    expect(renderContentJsonToHtml({ blocks: "not-an-array" })).toBe("");
  });

  test("renders a gallery block with image and video items (Issue #542)", () => {
    const html = renderContentJsonToHtml({
      blocks: [
        {
          type: "gallery",
          items: [
            {
              mediaType: "image",
              url: "https://cdn.example.com/a.jpg",
              caption: "A & B"
            },
            { mediaType: "video", url: "https://cdn.example.com/a.mp4" }
          ]
        }
      ]
    });
    expect(html).toContain('<img src="https://cdn.example.com/a.jpg"');
    expect(html).toContain("A &amp; B");
    expect(html).toContain(
      '<video src="https://cdn.example.com/a.mp4" controls>'
    );
  });

  test("skips a gallery item with an unsafe/relative URL", () => {
    const html = renderContentJsonToHtml({
      blocks: [
        {
          type: "gallery",
          items: [
            { mediaType: "image", url: "javascript:alert(1)" },
            { mediaType: "image", url: "/relative/path.jpg" }
          ]
        }
      ]
    });
    expect(html).toBe("");
  });

  test("skips a gallery item with an invalid mediaType", () => {
    const html = renderContentJsonToHtml({
      blocks: [
        {
          type: "gallery",
          items: [{ mediaType: "audio", url: "https://cdn.example.com/a.mp3" }]
        }
      ]
    });
    expect(html).toBe("");
  });

  test("returns null for an empty gallery items array", () => {
    expect(
      renderContentJsonToHtml({ blocks: [{ type: "gallery", items: [] }] })
    ).toBe("");
  });

  test("Issue #636: renders an image gallery item using mediaObjectId, resolved via the resolvedMediaUrls map", () => {
    const contentJson = {
      blocks: [
        {
          type: "gallery",
          items: [
            {
              mediaType: "image",
              mediaObjectId: "11111111-1111-1111-1111-111111111111",
              caption: "R2 image"
            }
          ]
        }
      ]
    };
    const resolvedMediaUrls = new Map([
      [
        "11111111-1111-1111-1111-111111111111",
        "https://media.example.test/news-media/tenant/2026/07/a.jpg"
      ]
    ]);

    const html = renderContentJsonToHtml(contentJson, resolvedMediaUrls);
    expect(html).toContain(
      '<img src="https://media.example.test/news-media/tenant/2026/07/a.jpg"'
    );
    expect(html).toContain("R2 image");
  });

  test("Issue #636: skips an image gallery item whose mediaObjectId is not in resolvedMediaUrls (unresolved/unsafe/absent — never a broken <img>)", () => {
    const contentJson = {
      blocks: [
        {
          type: "gallery",
          items: [
            {
              mediaType: "image",
              mediaObjectId: "22222222-2222-2222-2222-222222222222"
            }
          ]
        }
      ]
    };

    expect(renderContentJsonToHtml(contentJson, new Map())).toBe("");
    expect(renderContentJsonToHtml(contentJson)).toBe("");
  });

  test("Issue #636: mediaObjectId takes precedence over url when both happen to be present", () => {
    const contentJson = {
      blocks: [
        {
          type: "gallery",
          items: [
            {
              mediaType: "image",
              mediaObjectId: "33333333-3333-3333-3333-333333333333",
              url: "https://untrusted.example.com/a.jpg"
            }
          ]
        }
      ]
    };
    const resolvedMediaUrls = new Map([
      [
        "33333333-3333-3333-3333-333333333333",
        "https://media.example.test/trusted.jpg"
      ]
    ]);

    const html = renderContentJsonToHtml(contentJson, resolvedMediaUrls);
    expect(html).toContain('src="https://media.example.test/trusted.jpg"');
    expect(html).not.toContain("untrusted.example.com");
  });
});

describe("collectRenderableGalleryMediaObjectIds (Issue #636)", () => {
  test("empty for content with no gallery blocks", () => {
    expect(
      collectRenderableGalleryMediaObjectIds({
        blocks: [{ type: "paragraph", text: "hi" }]
      })
    ).toEqual([]);
  });

  test("collects mediaObjectId from image items only, ignoring video items and url-based items", () => {
    const ids = collectRenderableGalleryMediaObjectIds({
      blocks: [
        {
          type: "gallery",
          items: [
            {
              mediaType: "image",
              mediaObjectId: "11111111-1111-1111-1111-111111111111"
            },
            { mediaType: "video", mediaObjectId: "should-be-ignored" },
            { mediaType: "image", url: "https://cdn.example.com/a.jpg" }
          ]
        }
      ]
    });
    expect(ids).toEqual(["11111111-1111-1111-1111-111111111111"]);
  });

  test("deduplicates repeated mediaObjectId references across blocks", () => {
    const ids = collectRenderableGalleryMediaObjectIds({
      blocks: [
        {
          type: "gallery",
          items: [
            {
              mediaType: "image",
              mediaObjectId: "11111111-1111-1111-1111-111111111111"
            }
          ]
        },
        {
          type: "gallery",
          items: [
            {
              mediaType: "image",
              mediaObjectId: "11111111-1111-1111-1111-111111111111"
            }
          ]
        }
      ]
    });
    expect(ids).toEqual(["11111111-1111-1111-1111-111111111111"]);
  });
});

describe("resolveSeoTitle", () => {
  test("prefers seoTitle when present", () => {
    expect(
      resolveSeoTitle({ seoTitle: "SEO Title", title: "Post Title" })
    ).toBe("SEO Title");
  });

  test("falls back to title when seoTitle is null/empty", () => {
    expect(resolveSeoTitle({ seoTitle: null, title: "Post Title" })).toBe(
      "Post Title"
    );
    expect(resolveSeoTitle({ seoTitle: "  ", title: "Post Title" })).toBe(
      "Post Title"
    );
  });
});

describe("resolveMetaDescription", () => {
  test("prefers metaDescription, then excerpt, then a generated summary", () => {
    expect(
      resolveMetaDescription({
        metaDescription: "Meta desc",
        excerpt: "Excerpt",
        contentText: "Body text"
      })
    ).toBe("Meta desc");

    expect(
      resolveMetaDescription({
        metaDescription: null,
        excerpt: "Excerpt",
        contentText: "Body text"
      })
    ).toBe("Excerpt");

    expect(
      resolveMetaDescription({
        metaDescription: null,
        excerpt: null,
        contentText: "Body text here."
      })
    ).toBe("Body text here.");
  });

  test("truncates a long generated summary at a word boundary with an ellipsis", () => {
    const longText = "word ".repeat(50).trim();
    const description = resolveMetaDescription({
      metaDescription: null,
      excerpt: null,
      contentText: longText
    });
    expect(description.length).toBeLessThanOrEqual(164);
    expect(description.endsWith("...")).toBe(true);
  });
});

describe("resolveCanonicalUrl", () => {
  test("uses the post's canonicalUrl when it is a safe absolute URL", () => {
    const url = resolveCanonicalUrl(
      { canonicalUrl: "https://example.com/custom" },
      "https://example.com/blog/acme/self"
    );
    expect(url).toBe("https://example.com/custom");
  });

  test("falls back to selfUrl when canonicalUrl is null", () => {
    const url = resolveCanonicalUrl(
      { canonicalUrl: null },
      "https://example.com/blog/acme/self"
    );
    expect(url).toBe("https://example.com/blog/acme/self");
  });

  test("ignores an unsafe canonicalUrl (javascript:) and falls back to selfUrl", () => {
    const url = resolveCanonicalUrl(
      { canonicalUrl: "javascript:alert(1)" },
      "https://example.com/blog/acme/self"
    );
    expect(url).toBe("https://example.com/blog/acme/self");
  });

  test("returns null when neither canonicalUrl nor selfUrl is safe", () => {
    const url = resolveCanonicalUrl({ canonicalUrl: null }, "not-a-url");
    expect(url).toBeNull();
  });
});

describe("renderPublicPageShell", () => {
  test("escapes title/description and includes a canonical link when present", () => {
    const html = renderPublicPageShell({
      title: "<script>alert(1)</script>",
      description: "desc",
      canonicalUrl: "https://example.com/post",
      bodyHtml: "<p>body</p>",
      locale: "en"
    });
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain(
      '<link rel="canonical" href="https://example.com/post" />'
    );
    expect(html).toContain('<html lang="en">');
  });

  test("omits the canonical link entirely when canonicalUrl is null", () => {
    const html = renderPublicPageShell({
      title: "Title",
      description: "desc",
      canonicalUrl: null,
      bodyHtml: "<p>body</p>",
      locale: "en"
    });
    expect(html).not.toContain('rel="canonical"');
  });

  test("Issue #636: omits og:image/twitter:image entirely when ogImageUrl is null/absent", () => {
    const withoutOption = renderPublicPageShell({
      title: "Title",
      description: "desc",
      canonicalUrl: null,
      bodyHtml: "<p>body</p>",
      locale: "en"
    });
    expect(withoutOption).not.toContain("og:image");
    expect(withoutOption).not.toContain("twitter:image");

    const withNull = renderPublicPageShell({
      title: "Title",
      description: "desc",
      canonicalUrl: null,
      bodyHtml: "<p>body</p>",
      locale: "en",
      ogImageUrl: null
    });
    expect(withNull).not.toContain("og:image");
  });

  test("Issue #636: emits escaped og:image/twitter:image tags when ogImageUrl is present", () => {
    const html = renderPublicPageShell({
      title: "Title",
      description: "desc",
      canonicalUrl: null,
      bodyHtml: "<p>body</p>",
      locale: "en",
      ogImageUrl: "https://media.example.test/a.jpg?x=1&y=2",
      ogImageAlt: "A <b>photo</b>"
    });
    expect(html).toContain(
      '<meta property="og:image" content="https://media.example.test/a.jpg?x=1&amp;y=2" />'
    );
    expect(html).toContain(
      '<meta name="twitter:card" content="summary_large_image" />'
    );
    expect(html).toContain(
      '<meta name="twitter:image" content="https://media.example.test/a.jpg?x=1&amp;y=2" />'
    );
    expect(html).toContain(
      '<meta property="og:image:alt" content="A &lt;b&gt;photo&lt;/b&gt;" />'
    );
  });

  test("Issue #636: omits og:image:alt when ogImageAlt is not provided", () => {
    const html = renderPublicPageShell({
      title: "Title",
      description: "desc",
      canonicalUrl: null,
      bodyHtml: "<p>body</p>",
      locale: "en",
      ogImageUrl: "https://media.example.test/a.jpg"
    });
    expect(html).toContain('<meta property="og:image"');
    expect(html).not.toContain("og:image:alt");
  });
});

describe("resolveOgImageUrl (Issue #636)", () => {
  test("null when there is no resolved featured media URL", () => {
    expect(resolveOgImageUrl(null)).toBeNull();
  });

  test("passes through a safe absolute http(s) URL", () => {
    expect(resolveOgImageUrl("https://media.example.test/a.jpg")).toBe(
      "https://media.example.test/a.jpg"
    );
  });

  test("null for an unsafe URL (defense-in-depth even though the registry's publicUrl is already trusted)", () => {
    expect(resolveOgImageUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("renderPostSummaryListHtml", () => {
  test("renders an empty-state message when there are no posts", () => {
    const html = renderPostSummaryListHtml("acme", [], "Nothing here.");
    expect(html).toBe("<p>Nothing here.</p>");
  });

  test("renders a link per post, escaped", () => {
    const html = renderPostSummaryListHtml(
      "acme",
      [{ title: "<b>Hi</b>", slug: "hi", excerpt: null }],
      "empty"
    );
    expect(html).toContain('href="/blog/acme/hi"');
    expect(html).toContain("&lt;b&gt;Hi&lt;/b&gt;");
  });
});

describe("renderPaginationNavHtml", () => {
  test("shows only Next on page 1 with more pages", () => {
    const html = renderPaginationNavHtml(1, true, "/blog/acme");
    expect(html).toContain("Next");
    expect(html).not.toContain("Previous");
  });

  test("shows only Previous on the last page", () => {
    const html = renderPaginationNavHtml(2, false, "/blog/acme");
    expect(html).toContain("Previous");
    expect(html).not.toContain("Next");
  });
});
