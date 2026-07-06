import { describe, expect, test } from "bun:test";

import {
  THEME_INIT_SCRIPT_BODY,
  THEME_INIT_SCRIPT_HASH
} from "../src/lib/security/theme-init-script";

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  let binary = "";
  for (const byte of new Uint8Array(digest)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

describe("THEME_INIT_SCRIPT_HASH", () => {
  // Guards against silent drift (Issue #437): if THEME_INIT_SCRIPT_BODY is
  // ever edited without updating THEME_INIT_SCRIPT_HASH (or vice versa),
  // astro.config.mjs's `security.csp.scriptDirective.hashes` entry would
  // stop matching the real rendered script and a real browser would refuse
  // to run AdminLayout.astro's theme-flash-prevention script — this test
  // fails loudly instead of that happening silently.
  test("is really the SHA-256 of THEME_INIT_SCRIPT_BODY", async () => {
    const expected = `sha256-${await sha256Base64(THEME_INIT_SCRIPT_BODY)}`;

    expect(THEME_INIT_SCRIPT_HASH).toBe(expected);
  });

  test("THEME_INIT_SCRIPT_BODY reads its default from the DOM, not a textual substitution", () => {
    // If this were `define:vars`-interpolated instead, the rendered bytes
    // (and therefore the correct hash) would vary per tenant/request —
    // tried and found broken in real headless-Chrome verification (see
    // module doc comment in theme-init-script.ts).
    expect(THEME_INIT_SCRIPT_BODY).toContain(
      'document.documentElement.getAttribute("data-tenant-default-theme")'
    );
  });
});
