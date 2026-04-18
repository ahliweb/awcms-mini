import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const wranglerConfigPath = fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url));

test("wrangler config binds MEDIA_BUCKET to awcms-mini-s3", async () => {
  const contents = await readFile(wranglerConfigPath, "utf8");

  assert.match(contents, /"r2_buckets"\s*:\s*\[/);
  assert.match(contents, /"binding"\s*:\s*"MEDIA_BUCKET"/);
  assert.match(contents, /"bucket_name"\s*:\s*"awcms-mini-s3"/);
});
