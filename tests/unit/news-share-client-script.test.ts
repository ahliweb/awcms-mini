import { describe, expect, test } from "bun:test";

/**
 * Structural checks on the static client script (Issue #642) that the
 * public share widget references via same-origin `<script src>` — same
 * "assert the exact bytes, don't re-derive/execute them" convention
 * `tests/theme-init-script.test.ts` uses for the one other hand-authored
 * client script in this repo. This file cannot exercise real
 * `navigator.share`/`navigator.clipboard` browser behavior (no DOM/browser
 * runtime in `bun test`) — that belongs to a Playwright e2e smoke test
 * (`awcms-mini-browser-test` skill) if/when one is added; this test instead
 * guards the two properties a security review most cares about: no
 * third-party network origin is ever referenced, and the two
 * security-sensitive browser APIs (`navigator.share`, secure-context/
 * `isSecureContext` gating, `navigator.clipboard`) are actually present in
 * the shipped file.
 */

const SCRIPT_PATH = `${import.meta.dir}/../../public/js/news-share.js`;

describe("public/js/news-share.js (Issue #642)", () => {
  test("references navigator.share gated by window.isSecureContext", async () => {
    const source = await Bun.file(SCRIPT_PATH).text();

    expect(source).toContain("navigator.share");
    expect(source).toContain("window.isSecureContext");
  });

  test("references navigator.clipboard.writeText with a non-clipboard-API fallback", async () => {
    const source = await Bun.file(SCRIPT_PATH).text();

    expect(source).toContain("navigator.clipboard");
    expect(source).toContain("writeText");
    expect(source).toContain("execCommand");
  });

  test("never references any third-party/external network origin", async () => {
    const source = await Bun.file(SCRIPT_PATH).text();
    const externalUrlMatches = source.match(/https?:\/\/[^\s"'`)]+/g) ?? [];

    expect(externalUrlMatches).toEqual([]);
  });

  test("does not use eval/Function constructor/document.write", async () => {
    const source = await Bun.file(SCRIPT_PATH).text();

    expect(source).not.toContain("eval(");
    expect(source).not.toContain("new Function(");
    expect(source).not.toContain("document.write");
  });

  test("the native-share click handler ignores a user-cancel AbortError without showing an error message", async () => {
    const source = await Bun.file(SCRIPT_PATH).text();

    expect(source).toContain("AbortError");
  });
});
