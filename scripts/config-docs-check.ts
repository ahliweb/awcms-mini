/**
 * Config registry <-> `.env.example` <-> doc 18 three-way drift gate
 * (Issue #689, epic #679 platform-hardening — "add typed configuration
 * schema and remove dead environment variables").
 *
 * `src/lib/config/registry.ts` is the single source of truth for every
 * environment variable this repo's application/deployment tooling reads.
 * Before this issue, `.env.example` and
 * `docs/awcms-mini/18_configuration_env_reference.md` were maintained by
 * hand with no automated check that they agreed with each other or with
 * `scripts/validate-env.ts` — Issue #689's own evidence (`AUTH_JWT_SECRET`
 * documented despite opaque sessions, `FORM_DRAFT_RETENTION_DAYS`
 * documented in doc 18 §"lengkap .env.example lengkap (rekomendasi)" block
 * but absent from the real `.env.example`, `AWCMS_MINI_APP_DB_PASSWORD`
 * present in `.env.example` but never mentioned in doc 18 at all) is
 * exactly this kind of drift, caught for the first time by this gate.
 *
 * This script does NOT auto-generate `.env.example`/doc 18 from the
 * registry (the issue explicitly allows either approach; auto-generation
 * was judged higher-risk here — doc 18 mixes registry-derived tables with
 * hand-written prose/mermaid/cross-field explanation that a generator
 * would either have to preserve verbatim or destroy, and `.env.example`
 * carries per-line human commentary that doesn't fit a registry field).
 * Instead it performs a three-way SET comparison and fails loudly (exit 1)
 * on any disagreement, naming exactly which variable is missing from
 * which of the three surfaces — the operator then edits the file(s) by
 * hand, same as every other doc-parity gate in this repo
 * (`i18n:parity:check`, `check:docs`).
 *
 * ## Parsing approach
 *
 * - `.env.example`: every line matching `^\s*#*\s*([A-Z][A-Z0-9_]*)=` — this
 *   intentionally also matches commented-out placeholder lines (e.g.
 *   `# R2_ACCOUNT_ID=`), since this repo's convention is to document
 *   conditionally-required vars as commented placeholders rather than
 *   omit them (see `.env.example`'s own header comments).
 * - doc 18: every backtick-quoted ALL_CAPS token,
 *   `` /`([A-Z][A-Z0-9_]{2,})`/g `` — matches table cells like
 *   `` `APP_ENV` `` and the fenced `.env.example`-style recommendation
 *   block. `DOC18_NON_VARIABLE_TOKENS` below excludes verified false
 *   positives: SQL keywords quoted for readability
 *   (`ALTER`/`CREATE`/`DROP`/`GRANT`/`SELECT`), an internal code constant
 *   name mentioned in prose (`VISITOR_ANALYTICS_MODES`, exported from
 *   `visitor-analytics-config.ts`, not an env var), a documented
 *   code-constant-not-env-var (`BODY_SIZE_HARD_CEILING_BYTES`, Issue
 *   #686 — "Tidak ada env var — batas ini adalah konstanta kode"), this
 *   registry's own two exemption/token-list export names
 *   (`CONFIG_EXEMPTIONS`/`DOC18_NON_VARIABLE_TOKENS`, referenced by name
 *   in doc 18's own §Config registry section), and five variable NAMES
 *   doc 18 mentions specifically to say they do NOT
 *   exist (`BLOG_PUBLIC_BASE_PATH`/`BLOG_PUBLIC_ROUTE_MODE`/
 *   `DEPLOYMENT_PROFILE`/`FILE_STORAGE_DRIVER`/
 *   `LOCAL_FILE_UPLOADS_ENABLED`/`LOCAL_MEDIA_STORAGE_ENABLED` — see doc
 *   18 §News portal and §Full-online auth security hardening for the
 *   "sengaja TIDAK ditambahkan" explanations).
 * - `src/lib/config/registry.ts`'s `CONFIG_EXEMPTIONS` covers the other
 *   direction: real tokens that legitimately appear in doc 18/code but
 *   are deliberately NOT registry entries (illustrative example content
 *   for derived apps, or platform-level vars like `NODE_ENV`/`PORT`).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { CONFIG_EXEMPTIONS, CONFIG_REGISTRY } from "../src/lib/config/registry";

export const ENV_EXAMPLE_PATH = ".env.example";
export const DOC_18_PATH = "docs/awcms-mini/18_configuration_env_reference.md";

/** See file header §Parsing approach. */
export const DOC18_NON_VARIABLE_TOKENS: ReadonlySet<string> = new Set([
  "ALTER",
  "CREATE",
  "DROP",
  "GRANT",
  "SELECT",
  "VISITOR_ANALYTICS_MODES",
  "BODY_SIZE_HARD_CEILING_BYTES",
  "CONFIG_EXEMPTIONS",
  "DOC18_NON_VARIABLE_TOKENS",
  "BLOG_PUBLIC_BASE_PATH",
  "BLOG_PUBLIC_ROUTE_MODE",
  "DEPLOYMENT_PROFILE",
  "FILE_STORAGE_DRIVER",
  "LOCAL_FILE_UPLOADS_ENABLED",
  "LOCAL_MEDIA_STORAGE_ENABLED",
  // Issue #646: a valid VALUE of `TELEGRAM_DEFAULT_PARSE_MODE` (doc 18
  // §Telegram channel adapter), not itself an env var name — `MarkdownV2`
  // doesn't match the token regex (contains lowercase letters), but `HTML`
  // is a standalone all-caps backtick span and needs an explicit exemption.
  "HTML"
]);

export type DriftProblem = {
  name: string;
  message: string;
};

export function parseEnvExampleVarNames(source: string): Set<string> {
  const names = new Set<string>();

  for (const line of source.split("\n")) {
    const match = /^\s*#*\s*([A-Z][A-Z0-9_]*)=/.exec(line);

    if (match?.[1]) {
      names.add(match[1]);
    }
  }

  return names;
}

export function parseDoc18VarNames(source: string): Set<string> {
  const names = new Set<string>();
  const pattern = /`([A-Z][A-Z0-9_]{2,})`/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source)) !== null) {
    const token = match[1]!;

    if (!DOC18_NON_VARIABLE_TOKENS.has(token)) {
      names.add(token);
    }
  }

  return names;
}

/**
 * Pure three-way comparison, given already-parsed name sets — exported so
 * it's unit-testable against synthetic fixtures without touching the real
 * files on disk (same convention as `scripts/i18n-parity-check.ts`'s
 * `checkKeyParity`).
 */
export function checkConfigDocsDrift(
  registryNames: ReadonlySet<string>,
  exemptedNames: ReadonlySet<string>,
  envExampleNames: ReadonlySet<string>,
  doc18Names: ReadonlySet<string>
): DriftProblem[] {
  const problems: DriftProblem[] = [];
  const known = new Set([...registryNames, ...exemptedNames]);

  for (const name of registryNames) {
    if (!envExampleNames.has(name)) {
      problems.push({
        name,
        message: `"${name}" is in the config registry but missing from ${ENV_EXAMPLE_PATH}.`
      });
    }

    if (!doc18Names.has(name)) {
      problems.push({
        name,
        message: `"${name}" is in the config registry but missing from ${DOC_18_PATH}.`
      });
    }
  }

  for (const name of envExampleNames) {
    if (!known.has(name)) {
      problems.push({
        name,
        message: `"${name}" is in ${ENV_EXAMPLE_PATH} but missing from the config registry (src/lib/config/registry.ts) and not in CONFIG_EXEMPTIONS.`
      });
    }
  }

  for (const name of doc18Names) {
    if (!known.has(name)) {
      problems.push({
        name,
        message: `"${name}" is documented in ${DOC_18_PATH} but missing from the config registry (src/lib/config/registry.ts) and not in CONFIG_EXEMPTIONS.`
      });
    }
  }

  return problems;
}

export async function runConfigDocsCheck(
  rootDir = process.cwd()
): Promise<DriftProblem[]> {
  const [envExampleSource, doc18Source] = await Promise.all([
    readFile(path.join(rootDir, ENV_EXAMPLE_PATH), "utf8"),
    readFile(path.join(rootDir, DOC_18_PATH), "utf8")
  ]);

  const registryNames = new Set(CONFIG_REGISTRY.map((entry) => entry.name));
  const exemptedNames = new Set(
    CONFIG_EXEMPTIONS.map((exemption) => exemption.name)
  );

  return checkConfigDocsDrift(
    registryNames,
    exemptedNames,
    parseEnvExampleVarNames(envExampleSource),
    parseDoc18VarNames(doc18Source)
  );
}

if (import.meta.main) {
  const problems = await runConfigDocsCheck();

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(problem.message);
    }

    console.error(
      `\nconfig:docs:check GAGAL — ${problems.length} temuan drift antara src/lib/config/registry.ts, ${ENV_EXAMPLE_PATH}, dan ${DOC_18_PATH}. Perbarui ketiganya agar sinkron, atau tambahkan pengecualian eksplisit di CONFIG_EXEMPTIONS/DOC18_NON_VARIABLE_TOKENS dengan alasan tercatat bila variabel tersebut memang bukan bagian registry.`
    );
    process.exitCode = 1;
  } else {
    console.log(
      "config:docs:check OK — config registry, .env.example, dan doc 18 sinkron."
    );
  }
}
