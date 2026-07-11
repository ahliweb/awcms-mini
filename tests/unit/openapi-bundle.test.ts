/**
 * Issue #695 (epic #679): the bundler (`scripts/openapi-bundle.ts`) merges
 * `openapi/awcms-mini-public-api.src.yaml` + `openapi/modules/*.yaml` into
 * the published `openapi/awcms-mini-public-api.openapi.yaml`. Two
 * properties matter most given the split's blast radius:
 *
 * 1. Determinism: running the bundler twice against unchanged sources must
 *    produce byte-identical output (no dependency on unstable `readdir`
 *    order).
 * 2. Freshness: the currently committed bundled file must be exactly what
 *    the bundler produces right now — this is the same assertion
 *    `checkBundleFreshness` makes in `scripts/api-spec-check.ts`, kept here
 *    too as a standalone regression test that doesn't depend on the rest of
 *    `runApiSpecChecks`.
 *
 * Duplicate-path/duplicate-schema detection is exercised against synthetic
 * temp fixtures, not the real spec (which has neither).
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { bundleOpenApi, BUNDLED_PATH } from "../../scripts/openapi-bundle";

describe("bundleOpenApi determinism", () => {
  test("bundling the real source fragments twice produces byte-identical output", async () => {
    const first = await bundleOpenApi();
    const second = await bundleOpenApi();

    expect(second).toBe(first);
  });

  test("the committed bundled file matches what the bundler produces right now (freshness)", async () => {
    const fresh = await bundleOpenApi();
    const committed = await readFile(
      path.join(process.cwd(), BUNDLED_PATH),
      "utf8"
    );

    expect(fresh).toBe(committed);
  });
});

describe("bundleOpenApi fixture behavior", () => {
  const rootFixture = `
openapi: 3.1.0
info:
  title: Fixture API
  version: 1.0.0
tags:
  - name: Widgets
    description: Widgets.
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
  parameters: {}
  responses: {}
  schemas:
    ApiSuccess:
      type: object
security:
  - bearerAuth: []
`;

  async function withFixture(
    moduleFiles: Record<string, string>,
    run: (rootDir: string) => Promise<void>
  ): Promise<void> {
    const rootDir = await mkdtemp(path.join(tmpdir(), "openapi-bundle-"));

    try {
      await mkdir(path.join(rootDir, "openapi/modules"), { recursive: true });
      await writeFile(
        path.join(rootDir, "openapi/awcms-mini-public-api.src.yaml"),
        rootFixture,
        "utf8"
      );

      for (const [name, content] of Object.entries(moduleFiles)) {
        await writeFile(
          path.join(rootDir, "openapi/modules", name),
          content,
          "utf8"
        );
      }

      await run(rootDir);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  }

  test("merges paths and schemas from every module fragment, sorted alphabetically", async () => {
    await withFixture(
      {
        "b-widgets.openapi.yaml": `
paths:
  /api/v1/widgets:
    get:
      tags: [Widgets]
      operationId: listWidgets
      security: []
      responses:
        "200":
          description: ok
components:
  schemas:
    Widget:
      type: object
`,
        "a-accounts.openapi.yaml": `
paths:
  /api/v1/accounts:
    get:
      tags: [Widgets]
      operationId: listAccounts
      security: []
      responses:
        "200":
          description: ok
components:
  schemas:
    Account:
      type: object
`
      },
      async (rootDir) => {
        const yamlText = await bundleOpenApi(rootDir);

        const pathsIndex = yamlText.indexOf("paths:");
        const accountsIndex = yamlText.indexOf("/api/v1/accounts:");
        const widgetsIndex = yamlText.indexOf("/api/v1/widgets:");
        expect(pathsIndex).toBeGreaterThan(-1);
        expect(accountsIndex).toBeGreaterThan(pathsIndex);
        expect(widgetsIndex).toBeGreaterThan(accountsIndex);

        const schemasIndex = yamlText.indexOf("schemas:");
        const accountSchemaIndex = yamlText.indexOf("Account:");
        const widgetSchemaIndex = yamlText.indexOf("Widget:");
        expect(accountSchemaIndex).toBeGreaterThan(schemasIndex);
        expect(widgetSchemaIndex).toBeGreaterThan(accountSchemaIndex);
      }
    );
  });

  test("bundling twice against the same fixture sources is byte-identical", async () => {
    await withFixture(
      {
        "widgets.openapi.yaml": `
paths:
  /api/v1/widgets:
    get:
      tags: [Widgets]
      operationId: listWidgets
      security: []
      responses:
        "200":
          description: ok
`
      },
      async (rootDir) => {
        const first = await bundleOpenApi(rootDir);
        const second = await bundleOpenApi(rootDir);
        expect(second).toBe(first);
      }
    );
  });

  test("throws when two module fragments declare the same path", async () => {
    await withFixture(
      {
        "a.openapi.yaml": `
paths:
  /api/v1/widgets:
    get:
      operationId: opA
      security: []
      responses: { "200": { description: ok } }
`,
        "b.openapi.yaml": `
paths:
  /api/v1/widgets:
    post:
      operationId: opB
      security: []
      responses: { "200": { description: ok } }
`
      },
      async (rootDir) => {
        await expect(bundleOpenApi(rootDir)).rejects.toBeInstanceOf(Error);
      }
    );
  });

  test("throws when two module fragments declare the same schema name", async () => {
    await withFixture(
      {
        "a.openapi.yaml": `
paths:
  /api/v1/a:
    get:
      operationId: opA
      security: []
      responses: { "200": { description: ok } }
components:
  schemas:
    Shared:
      type: object
`,
        "b.openapi.yaml": `
paths:
  /api/v1/b:
    get:
      operationId: opB
      security: []
      responses: { "200": { description: ok } }
components:
  schemas:
    Shared:
      type: string
`
      },
      async (rootDir) => {
        await expect(bundleOpenApi(rootDir)).rejects.toBeInstanceOf(Error);
      }
    );
  });
});
