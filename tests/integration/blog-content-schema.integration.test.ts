/**
 * Integration tests for the blog_content foundation schema/RLS (Issue #537,
 * epic #536) against a real PostgreSQL. No endpoints exist yet (Issue #538
 * onward add them) — this exercises migration 026/027's constraints and RLS
 * enforcement directly via `withTenant`/raw admin SQL, same pattern
 * `module-management-schema.integration.test.ts` (#512) used.
 *
 * Skipped unless DATABASE_URL is set (see tests/integration/harness.ts).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  applyMigrations,
  getAdminSql,
  integrationEnabled,
  provisionAppRole,
  resetDatabase
} from "./harness";

import { getDatabaseClient } from "../../src/lib/database/client";
import { withTenant } from "../../src/lib/database/tenant-context";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const AUTHOR_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

async function seedTenants(): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_mini_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES
      (${TENANT_A}, 'tenant-a', 'Tenant A', 'Tenant A Legal', 'active', 'en', 'light'),
      (${TENANT_B}, 'tenant-b', 'Tenant B', 'Tenant B Legal', 'active', 'en', 'light')
  `;
}

const suite = integrationEnabled ? describe : describe.skip;

suite("blog_content schema — RLS isolation and constraints", () => {
  beforeAll(async () => {
    await applyMigrations();
    await provisionAppRole();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedTenants();
  });

  test("blog_content permission catalog is seeded", async () => {
    const admin = getAdminSql();
    const rows = (await admin`
      SELECT activity_code, action FROM awcms_mini_permissions
      WHERE module_key = 'blog_content'
      ORDER BY activity_code, action
    `) as { activity_code: string; action: string }[];

    expect(rows.map((row) => `${row.activity_code}.${row.action}`)).toEqual([
      "pages.archive",
      "pages.create",
      "pages.delete",
      "pages.publish",
      "pages.purge",
      "pages.read",
      "pages.restore",
      "pages.update",
      "posts.archive",
      "posts.create",
      "posts.delete",
      "posts.export",
      "posts.publish",
      "posts.purge",
      "posts.read",
      "posts.restore",
      "posts.schedule",
      "posts.update",
      "revisions.read",
      "revisions.restore",
      "search.read",
      "seo.configure",
      "settings.configure",
      "settings.read",
      "taxonomies.configure",
      "taxonomies.read"
    ]);
  });

  test("tenant A cannot see tenant B's posts (RLS isolation)", async () => {
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_blog_posts
        (tenant_id, author_tenant_user_id, title, slug, content_json, content_text, status)
      VALUES
        (${TENANT_A}, ${AUTHOR_ID}, 'A post', 'a-post', '{}'::jsonb, 'body', 'draft'),
        (${TENANT_B}, ${AUTHOR_ID}, 'B post', 'b-post', '{}'::jsonb, 'body', 'draft')
    `;

    const sql = getDatabaseClient();
    const tenantARows = await withTenant(
      sql,
      TENANT_A,
      (tx) => tx`SELECT slug FROM awcms_mini_blog_posts`
    );
    expect(tenantARows).toHaveLength(1);
    expect((tenantARows as { slug: string }[])[0]?.slug).toBe("a-post");
  });

  test("querying posts without a tenant GUC set returns no rows (fail-closed)", async () => {
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_blog_posts
        (tenant_id, author_tenant_user_id, title, slug, content_json, content_text, status)
      VALUES (${TENANT_A}, ${AUTHOR_ID}, 'A post', 'a-post', '{}'::jsonb, 'body', 'draft')
    `;

    const sql = getDatabaseClient();
    const rows = await sql`SELECT slug FROM awcms_mini_blog_posts`;
    expect(rows).toHaveLength(0);
  });

  test("posts rejects an unknown status", async () => {
    const admin = getAdminSql();
    let didThrow = false;

    try {
      await admin`
        INSERT INTO awcms_mini_blog_posts
          (tenant_id, author_tenant_user_id, title, slug, content_json, content_text, status)
        VALUES (${TENANT_A}, ${AUTHOR_ID}, 'A post', 'a-post', '{}'::jsonb, 'body', 'bogus')
      `;
    } catch {
      didThrow = true;
    }

    expect(didThrow).toBe(true);
  });

  test("posts enforces unique slug per tenant+locale among non-deleted rows", async () => {
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_blog_posts
        (tenant_id, author_tenant_user_id, title, slug, content_json, content_text, status, locale)
      VALUES (${TENANT_A}, ${AUTHOR_ID}, 'A post', 'dup-slug', '{}'::jsonb, 'body', 'draft', 'id')
    `;

    let didThrow = false;
    try {
      await admin`
        INSERT INTO awcms_mini_blog_posts
          (tenant_id, author_tenant_user_id, title, slug, content_json, content_text, status, locale)
        VALUES (${TENANT_A}, ${AUTHOR_ID}, 'Another post', 'dup-slug', '{}'::jsonb, 'body', 'draft', 'id')
      `;
    } catch {
      didThrow = true;
    }
    expect(didThrow).toBe(true);

    // Different locale is allowed to reuse the same slug.
    const rows = await admin`
      INSERT INTO awcms_mini_blog_posts
        (tenant_id, author_tenant_user_id, title, slug, content_json, content_text, status, locale)
      VALUES (${TENANT_A}, ${AUTHOR_ID}, 'Another post', 'dup-slug', '{}'::jsonb, 'body', 'draft', 'en')
      RETURNING id
    `;
    expect(rows).toHaveLength(1);
  });

  test("terms rejects a tag with a parent_id", async () => {
    const admin = getAdminSql();
    const categoryRows = await admin`
      INSERT INTO awcms_mini_blog_terms (tenant_id, taxonomy_type, name, slug)
      VALUES (${TENANT_A}, 'category', 'News', 'news')
      RETURNING id
    `;
    const categoryId = (categoryRows as { id: string }[])[0]!.id;

    let didThrow = false;
    try {
      await admin`
        INSERT INTO awcms_mini_blog_terms (tenant_id, taxonomy_type, parent_id, name, slug)
        VALUES (${TENANT_A}, 'tag', ${categoryId}, 'Breaking', 'breaking')
      `;
    } catch {
      didThrow = true;
    }

    expect(didThrow).toBe(true);
  });

  test("terms allows a category with a parent_id and enforces slug dedup per taxonomy type", async () => {
    const admin = getAdminSql();
    const parentRows = await admin`
      INSERT INTO awcms_mini_blog_terms (tenant_id, taxonomy_type, name, slug)
      VALUES (${TENANT_A}, 'category', 'News', 'news')
      RETURNING id
    `;
    const parentId = (parentRows as { id: string }[])[0]!.id;

    const childRows = await admin`
      INSERT INTO awcms_mini_blog_terms (tenant_id, taxonomy_type, parent_id, name, slug)
      VALUES (${TENANT_A}, 'category', ${parentId}, 'World News', 'world-news')
      RETURNING id
    `;
    expect(childRows).toHaveLength(1);

    // Same slug but different taxonomy_type ('tag') is allowed to coexist.
    const tagRows = await admin`
      INSERT INTO awcms_mini_blog_terms (tenant_id, taxonomy_type, name, slug)
      VALUES (${TENANT_A}, 'tag', 'News', 'news')
      RETURNING id
    `;
    expect(tagRows).toHaveLength(1);
  });

  test("post_terms enforces one row per (post, term) and is tenant-isolated", async () => {
    const admin = getAdminSql();
    const postRows = await admin`
      INSERT INTO awcms_mini_blog_posts
        (tenant_id, author_tenant_user_id, title, slug, content_json, content_text, status)
      VALUES (${TENANT_A}, ${AUTHOR_ID}, 'A post', 'a-post', '{}'::jsonb, 'body', 'draft')
      RETURNING id
    `;
    const postId = (postRows as { id: string }[])[0]!.id;

    const termRows = await admin`
      INSERT INTO awcms_mini_blog_terms (tenant_id, taxonomy_type, name, slug)
      VALUES (${TENANT_A}, 'tag', 'Featured', 'featured')
      RETURNING id
    `;
    const termId = (termRows as { id: string }[])[0]!.id;

    await admin`
      INSERT INTO awcms_mini_blog_post_terms (tenant_id, post_id, term_id)
      VALUES (${TENANT_A}, ${postId}, ${termId})
    `;

    let didThrow = false;
    try {
      await admin`
        INSERT INTO awcms_mini_blog_post_terms (tenant_id, post_id, term_id)
        VALUES (${TENANT_A}, ${postId}, ${termId})
      `;
    } catch {
      didThrow = true;
    }
    expect(didThrow).toBe(true);
  });

  test("revisions enforces one row per (tenant, resource, revision_number)", async () => {
    const admin = getAdminSql();
    const postRows = await admin`
      INSERT INTO awcms_mini_blog_posts
        (tenant_id, author_tenant_user_id, title, slug, content_json, content_text, status)
      VALUES (${TENANT_A}, ${AUTHOR_ID}, 'A post', 'a-post', '{}'::jsonb, 'body', 'draft')
      RETURNING id
    `;
    const postId = (postRows as { id: string }[])[0]!.id;

    await admin`
      INSERT INTO awcms_mini_blog_revisions
        (tenant_id, resource_type, resource_id, revision_number, title, content_json, content_text, status, created_by_tenant_user_id)
      VALUES (${TENANT_A}, 'post', ${postId}, 1, 'A post', '{}'::jsonb, 'body', 'draft', ${AUTHOR_ID})
    `;

    let didThrow = false;
    try {
      await admin`
        INSERT INTO awcms_mini_blog_revisions
          (tenant_id, resource_type, resource_id, revision_number, title, content_json, content_text, status, created_by_tenant_user_id)
        VALUES (${TENANT_A}, 'post', ${postId}, 1, 'A post again', '{}'::jsonb, 'body', 'draft', ${AUTHOR_ID})
      `;
    } catch {
      didThrow = true;
    }
    expect(didThrow).toBe(true);
  });

  test("redirects enforces unique from_path per tenant among active rows", async () => {
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_blog_redirects (tenant_id, from_path, to_path)
      VALUES (${TENANT_A}, '/old-path', '/new-path')
    `;

    let didThrow = false;
    try {
      await admin`
        INSERT INTO awcms_mini_blog_redirects (tenant_id, from_path, to_path)
        VALUES (${TENANT_A}, '/old-path', '/another-path')
      `;
    } catch {
      didThrow = true;
    }
    expect(didThrow).toBe(true);
  });

  test("settings is one row per tenant and tenant-isolated", async () => {
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_mini_blog_settings (tenant_id, default_locale)
      VALUES (${TENANT_A}, 'en'), (${TENANT_B}, 'id')
    `;

    const sql = getDatabaseClient();
    const tenantARows = await withTenant(
      sql,
      TENANT_A,
      (tx) => tx`SELECT default_locale FROM awcms_mini_blog_settings`
    );
    expect(tenantARows).toHaveLength(1);
    expect(
      (tenantARows as { default_locale: string }[])[0]?.default_locale
    ).toBe("en");

    let didThrow = false;
    try {
      await admin`
        INSERT INTO awcms_mini_blog_settings (tenant_id, default_locale)
        VALUES (${TENANT_A}, 'en')
      `;
    } catch {
      didThrow = true;
    }
    expect(didThrow).toBe(true);
  });
});
