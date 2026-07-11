import { describe, expect, test } from "bun:test";

import {
  checkConfigDocsDrift,
  parseDoc18VarNames,
  parseEnvExampleVarNames,
  runConfigDocsCheck
} from "../../scripts/config-docs-check";

describe("parseEnvExampleVarNames", () => {
  test("extracts both active and commented-out placeholder var names", () => {
    const source = [
      "# comment line, not a var",
      "APP_ENV=development",
      "# R2_ACCOUNT_ID=",
      "  # EMAIL_PROVIDER=mailketing",
      "",
      "NOT_UPPER_case=value"
    ].join("\n");

    const names = parseEnvExampleVarNames(source);

    expect(names.has("APP_ENV")).toBe(true);
    expect(names.has("R2_ACCOUNT_ID")).toBe(true);
    expect(names.has("EMAIL_PROVIDER")).toBe(true);
    // A pure prose comment line produces no match.
    expect(names.size).toBeGreaterThan(0);
  });
});

describe("parseDoc18VarNames", () => {
  test("extracts backtick-quoted ALL_CAPS tokens and excludes known non-variable tokens", () => {
    const source = [
      "| `APP_ENV` | Ya | `development` | ... |",
      "Satu-satunya role yang bisa `ALTER`/`DROP`/`CREATE`/`GRANT`.",
      "`VISITOR_ANALYTICS_MODES` is an internal constant, not an env var."
    ].join("\n");

    const names = parseDoc18VarNames(source);

    expect(names.has("APP_ENV")).toBe(true);
    expect(names.has("ALTER")).toBe(false);
    expect(names.has("DROP")).toBe(false);
    expect(names.has("VISITOR_ANALYTICS_MODES")).toBe(false);
  });
});

describe("checkConfigDocsDrift (Issue #689 — real drift detection)", () => {
  test("passes with no problems when all three sources agree", () => {
    const registryNames = new Set(["APP_ENV", "DATABASE_URL"]);
    const exemptedNames = new Set(["NODE_ENV"]);
    const envExampleNames = new Set(["APP_ENV", "DATABASE_URL"]);
    const doc18Names = new Set(["APP_ENV", "DATABASE_URL"]);

    const problems = checkConfigDocsDrift(
      registryNames,
      exemptedNames,
      envExampleNames,
      doc18Names
    );

    expect(problems).toEqual([]);
  });

  test("fails when a registry var is missing from .env.example", () => {
    const registryNames = new Set(["APP_ENV", "A_FICTIONAL_REGISTRY_ONLY_VAR"]);
    const envExampleNames = new Set(["APP_ENV"]);
    const doc18Names = new Set(["APP_ENV", "A_FICTIONAL_REGISTRY_ONLY_VAR"]);

    const problems = checkConfigDocsDrift(
      registryNames,
      new Set(),
      envExampleNames,
      doc18Names
    );

    expect(
      problems.some((p) => p.name === "A_FICTIONAL_REGISTRY_ONLY_VAR")
    ).toBe(true);
  });

  test("fails when a registry var is missing from doc 18", () => {
    const registryNames = new Set(["APP_ENV", "A_FICTIONAL_REGISTRY_ONLY_VAR"]);
    const envExampleNames = new Set([
      "APP_ENV",
      "A_FICTIONAL_REGISTRY_ONLY_VAR"
    ]);
    const doc18Names = new Set(["APP_ENV"]);

    const problems = checkConfigDocsDrift(
      registryNames,
      new Set(),
      envExampleNames,
      doc18Names
    );

    expect(
      problems.some((p) => p.name === "A_FICTIONAL_REGISTRY_ONLY_VAR")
    ).toBe(true);
  });

  test("fails when .env.example has a var absent from the registry and exemptions", () => {
    const registryNames = new Set(["APP_ENV"]);
    const envExampleNames = new Set([
      "APP_ENV",
      "A_FICTIONAL_ENV_EXAMPLE_ONLY_VAR"
    ]);
    const doc18Names = new Set(["APP_ENV"]);

    const problems = checkConfigDocsDrift(
      registryNames,
      new Set(),
      envExampleNames,
      doc18Names
    );

    expect(
      problems.some((p) => p.name === "A_FICTIONAL_ENV_EXAMPLE_ONLY_VAR")
    ).toBe(true);
  });

  test("fails when doc 18 documents a var absent from the registry and exemptions", () => {
    const registryNames = new Set(["APP_ENV"]);
    const envExampleNames = new Set(["APP_ENV"]);
    const doc18Names = new Set(["APP_ENV", "A_FICTIONAL_DOC_ONLY_VAR"]);

    const problems = checkConfigDocsDrift(
      registryNames,
      new Set(),
      envExampleNames,
      doc18Names
    );

    expect(problems.some((p) => p.name === "A_FICTIONAL_DOC_ONLY_VAR")).toBe(
      true
    );
  });

  test("an explicitly exempted var never produces a problem even though it's absent from the registry", () => {
    const registryNames = new Set(["APP_ENV"]);
    const exemptedNames = new Set(["NODE_ENV"]);
    const envExampleNames = new Set(["APP_ENV"]);
    const doc18Names = new Set(["APP_ENV", "NODE_ENV"]);

    const problems = checkConfigDocsDrift(
      registryNames,
      exemptedNames,
      envExampleNames,
      doc18Names
    );

    expect(problems).toEqual([]);
  });
});

describe("runConfigDocsCheck against the real repository files (Issue #689)", () => {
  test("the real src/lib/config/registry.ts, .env.example, and doc 18 are in sync today", async () => {
    const problems = await runConfigDocsCheck();

    expect(problems).toEqual([]);
  });
});
