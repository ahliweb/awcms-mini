import { describe, expect, test } from "bun:test";

import {
  renderCategoryGridSectionHtml,
  renderGalleryBlockSectionHtml,
  renderHomepageSectionsHtml,
  renderPostCardListHtml
} from "../../src/modules/news-portal/domain/homepage-section-rendering";

describe("renderPostCardListHtml (Issue #637)", () => {
  test("renders an empty state message when there are no cards", () => {
    const html = renderPostCardListHtml("/news", [], "Nothing here.");
    expect(html).toContain("Nothing here.");
    expect(html).not.toContain("<img");
  });

  test("renders a card with an image when imageUrl is present, escaping all fields", () => {
    const html = renderPostCardListHtml(
      "/news",
      [
        {
          title: "<script>alert(1)</script>",
          slug: "hello",
          excerpt: "An excerpt",
          imageUrl: "https://media.example.com/a.jpg",
          imageAlt: "An alt"
        }
      ],
      "empty"
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('<img src="https://media.example.com/a.jpg"');
    expect(html).toContain('alt="An alt"');
    expect(html).toContain('href="/news/hello"');
    expect(html).toContain("An excerpt");
  });

  test("renders a card with no <img> tag at all when imageUrl is null", () => {
    const html = renderPostCardListHtml(
      "/news",
      [
        {
          title: "No image",
          slug: "no-image",
          excerpt: null,
          imageUrl: null,
          imageAlt: null
        }
      ],
      "empty"
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("No image");
  });
});

describe("renderCategoryGridSectionHtml (Issue #637)", () => {
  test("renders one group per category with its own post list", () => {
    const html = renderCategoryGridSectionHtml(
      "/news",
      [
        {
          categoryName: "World",
          categorySlug: "world",
          posts: [
            {
              title: "Post A",
              slug: "post-a",
              excerpt: null,
              imageUrl: null,
              imageAlt: null
            }
          ]
        },
        { categoryName: "Sports", categorySlug: "sports", posts: [] }
      ],
      "No posts."
    );
    expect(html).toContain("World");
    expect(html).toContain("Post A");
    expect(html).toContain("Sports");
    expect(html).toContain("No posts.");
  });
});

describe("renderGalleryBlockSectionHtml (Issue #637)", () => {
  const MEDIA_ID = "11111111-1111-1111-1111-111111111111";

  test("renders resolved gallery images via the shared content-block gallery renderer", () => {
    const media = new Map([[MEDIA_ID, "https://media.example.com/a.jpg"]]);
    const html = renderGalleryBlockSectionHtml(
      [MEDIA_ID],
      "Caption",
      media,
      "empty"
    );
    expect(html).toContain("https://media.example.com/a.jpg");
    expect(html).toContain("Caption");
  });

  test("renders the empty state when no media resolves (unverified/cross-tenant/deleted since configured)", () => {
    const html = renderGalleryBlockSectionHtml(
      [MEDIA_ID],
      null,
      new Map(),
      "No images."
    );
    expect(html).toContain("No images.");
    expect(html).not.toContain("<img");
  });
});

describe("renderHomepageSectionsHtml (Issue #637)", () => {
  test("wraps each rendered section in its own <section> with sectionKey/type attributes and optional heading", () => {
    const html = renderHomepageSectionsHtml([
      {
        sectionKey: "front-page",
        sectionType: "headline",
        title: "Top Story",
        bodyHtml: "<p>body</p>"
      },
      {
        sectionKey: "no-title",
        sectionType: "latest_posts",
        title: null,
        bodyHtml: "<p>other</p>"
      }
    ]);
    expect(html).toContain('data-section-key="front-page"');
    expect(html).toContain("homepage-section-headline");
    expect(html).toContain("<h2>Top Story</h2>");
    expect(html).toContain('data-section-key="no-title"');
    expect(html).not.toContain("<h2></h2>");
  });
});
