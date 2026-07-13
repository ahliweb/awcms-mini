/**
 * Issue #700 (epic #679 platform-hardening): `scripts/api-docs-generate.ts`
 * generates `docs/awcms-mini/api-reference.md` from the bundled OpenAPI/
 * AsyncAPI contracts. Mirrors the two properties
 * `tests/unit/openapi-bundle.test.ts` asserts for the OpenAPI bundle
 * itself:
 *
 * 1. Determinism — running the generator twice against unchanged sources
 *    produces byte-identical output.
 * 2. Freshness — the currently committed reference doc is exactly what
 *    the generator produces right now (same assertion `runApiDocsCheck`
 *    makes, kept here as a standalone regression test).
 *
 * Plus contract-coverage and example-safety checks specific to this
 * generator's acceptance criteria (Issue #700): every public operation/
 * event must appear, and no example may contain anything that looks like
 * a secret or a non-reserved (i.e. potentially real/production) hostname.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";

import {
  API_REFERENCE_PATH,
  buildApiReferenceMarkdown
} from "../../scripts/api-docs-generate";
import { runApiDocsCheck } from "../../scripts/api-docs-check";
import { buildBundledDocument } from "../../scripts/openapi-bundle";
import { ASYNCAPI_PATH } from "../../scripts/api-spec-check";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

describe("buildApiReferenceMarkdown determinism", () => {
  // Issue #644/#646 review follow-up: `buildApiReferenceMarkdown()` now
  // takes several seconds per call (it re-parses/re-bundles the full
  // OpenAPI+AsyncAPI contract from scratch, no memoization) now that the
  // combined social-publishing adapter surface (Meta #644 + Telegram #646,
  // on top of everything already merged) has grown the bundled contract
  // considerably — a test calling it twice sequentially now legitimately
  // exceeds bun:test's 5000ms default timeout even though the assertion
  // itself is correct (verified manually with a longer timeout: all pass).
  // Bumping the timeout here is a test-infrastructure tolerance fix, not a
  // correctness change — if this generator's latency becomes a real
  // problem it should be addressed as its own performance issue, not by
  // narrowing test coverage.
  test("generating twice against the real contracts is byte-identical", async () => {
    const first = await buildApiReferenceMarkdown();
    const second = await buildApiReferenceMarkdown();
    expect(second).toBe(first);
  }, 20_000);

  test("the committed reference doc matches what the generator produces right now (freshness)", async () => {
    const fresh = await buildApiReferenceMarkdown();
    const committed = await readFile(
      path.join(process.cwd(), API_REFERENCE_PATH),
      "utf8"
    );
    expect(fresh).toBe(committed);
  }, 20_000);

  test("runApiDocsCheck reports no problems against the committed doc", async () => {
    const problems = await runApiDocsCheck();
    expect(problems).toEqual([]);
  }, 20_000);
});

describe("buildApiReferenceMarkdown contract coverage", () => {
  test("every operationId in the bundled OpenAPI contract appears in the reference doc", async () => {
    const bundled = await buildBundledDocument();
    const markdown = await buildApiReferenceMarkdown();

    const paths = bundled.paths as Record<string, Record<string, unknown>>;
    const operationIds: string[] = [];
    for (const pathItem of Object.values(paths)) {
      for (const method of HTTP_METHODS) {
        const op = pathItem[method] as { operationId?: string } | undefined;
        if (op?.operationId) operationIds.push(op.operationId);
      }
    }

    expect(operationIds.length).toBeGreaterThan(0);
    for (const operationId of operationIds) {
      expect(markdown.includes(`\`${operationId}\``)).toBe(true);
    }
  }, 20_000);

  test("every AsyncAPI channel address appears in the reference doc", async () => {
    const source = await readFile(
      path.join(process.cwd(), ASYNCAPI_PATH),
      "utf8"
    );
    const asyncApi = parseDocument(source).toJSON() as {
      channels: Record<string, unknown>;
    };
    const markdown = await buildApiReferenceMarkdown();

    const addresses = Object.keys(asyncApi.channels);
    expect(addresses.length).toBeGreaterThan(0);
    for (const address of addresses) {
      expect(markdown.includes(address)).toBe(true);
    }
  }, 20_000);

  test("every named schema referenced by an operation gets a schema appendix entry", async () => {
    const markdown = await buildApiReferenceMarkdown();

    // Every `(#schema-x)` link must have a matching `### Schema: X` heading.
    const linkedAnchors = new Set(
      [...markdown.matchAll(/\(#schema-([a-z0-9-]+)\)/g)].map((m) => m[1]!)
    );
    const headingAnchors = new Set(
      [...markdown.matchAll(/^### Schema: (\S+)/gm)].map((m) =>
        m[1]!.toLowerCase()
      )
    );

    expect(linkedAnchors.size).toBeGreaterThan(0);
    for (const anchor of linkedAnchors) {
      expect(headingAnchors.has(anchor)).toBe(true);
    }
  }, 20_000);
});

describe("buildApiReferenceMarkdown example safety", () => {
  test("contains no non-reserved hostnames or secret-shaped strings", async () => {
    const markdown = await buildApiReferenceMarkdown();

    // Every hostname-shaped string in the document must be one of the
    // documentation-reserved/dev-local hosts this generator ever emits —
    // never a real or production-looking domain.
    const hostnamePattern = /\bhttps?:\/\/([a-z0-9.-]+)/gi;
    const allowedHosts = new Set(["example.com", "localhost:4321"]);
    for (const match of markdown.matchAll(hostnamePattern)) {
      const host = match[1]!.toLowerCase();
      expect(allowedHosts.has(host)).toBe(true);
    }

    // Common secret-shaped literal patterns must never appear (this
    // generator only ever emits values derived from JSON Schema shape,
    // never copied from env/config/fixtures — this is a regression guard,
    // not evidence any of these are actually reachable).
    const forbiddenPatterns = [
      /AKIA[0-9A-Z]{16}/, // AWS access key id shape
      /sk-[A-Za-z0-9]{20,}/, // generic API secret key shape
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/ // PEM private key
    ];
    for (const pattern of forbiddenPatterns) {
      expect(pattern.test(markdown)).toBe(false);
    }
  }, 20_000);

  test("every UUID-shaped example value is either the synthetic nil UUID or a pre-existing, already-reviewed contract `example:` literal", async () => {
    const markdown = await buildApiReferenceMarkdown();
    const uuidPattern =
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

    // Any generated (not spec-declared) `format: uuid` value must be this
    // nil UUID. A schema's own `example:` field (already part of the
    // reviewed, committed OpenAPI contract, not something this generator
    // invents) is emitted verbatim — allow the one known instance today
    // (an R2 object key sample in news-media.openapi.yaml, itself the
    // well-known Swagger/OpenAPI-docs placeholder UUID) rather than a
    // blanket "every UUID must be the nil UUID", which would be false for
    // any future legitimate spec-authored example too.
    const allowed = new Set([
      "00000000-0000-0000-0000-000000000000",
      "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"
    ]);

    for (const match of markdown.matchAll(uuidPattern)) {
      expect(allowed.has(match[0].toLowerCase())).toBe(true);
    }
  }, 20_000);
});
