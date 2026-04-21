import test from "node:test";
import assert from "node:assert/strict";

import {
  SECRET_HYGIENE_SCAN_TARGETS,
  scanSecretHygieneLine,
  scanSecretHygieneText,
} from "../../scripts/check-secret-hygiene.mjs";

test("secret hygiene scan allows reviewed placeholders and non-secret defaults", async () => {
  const findings = scanSecretHygieneText(
    ".env.example",
    [
      "COOLIFY_ACCESS_TOKEN=replace-with-local-only-coolify-token",
      "APP_SECRET=replace-with-a-strong-app-secret",
      "DATABASE_URL=postgres://awcms_mini_dev:<password>@localhost:55432/awcms_mini_dev",
      "COOLIFY_BASE_URL=https://app.coolify.io",
    ].join("\n"),
  );

  assert.deepEqual(findings, []);
});

test("secret hygiene scan flags hardcoded sensitive env assignments", async () => {
  const findings = scanSecretHygieneLine(".env.example", "APP_SECRET=super-secret-value", 1);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "sensitive-env-assignment");
  assert.equal(findings[0].detail, "APP_SECRET");
});

test("secret hygiene scan flags hardcoded process env secrets", async () => {
  const findings = scanSecretHygieneLine(
    "scripts/example.mjs",
    'process.env.COOLIFY_ACCESS_TOKEN = "coolify-live-token-value";',
    1,
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "sensitive-process-env-assignment");
  assert.equal(findings[0].detail, "COOLIFY_ACCESS_TOKEN");
});

test("secret hygiene scan flags credential-bearing URLs", async () => {
  const findings = scanSecretHygieneLine(
    "docs/process/example.md",
    "postgres://awcms_mini_app:real-password@id1.ahlikoding.com:5432/awcms_mini?sslmode=verify-full",
    1,
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "credential-url");
});

test("secret hygiene scan flags inline bearer tokens", async () => {
  const findings = scanSecretHygieneLine(
    "docs/process/example.md",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature",
    1,
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "bearer-token");
});

test("secret hygiene scan targets the reviewed maintained surfaces", async () => {
  assert.deepEqual(SECRET_HYGIENE_SCAN_TARGETS, [
    { path: ".env.example", type: "file" },
    { path: "README.md", type: "file" },
    { path: "scripts", type: "directory", extensions: [".mjs"] },
    { path: "docs/process", type: "directory", extensions: [".md"] },
    { path: "docs/security", type: "directory", extensions: [".md"] },
  ]);
});
