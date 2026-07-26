/**
 * validate-module-imports.ts — `bun run modules:imports:check`.
 *
 * Cross-module IMPORT graph vs declared `dependencies`. Fails loud when a file
 * in `src/modules/<A>` imports at runtime from `src/modules/<B>` without `B`'s
 * module key appearing in `A`'s descriptor `dependencies`.
 *
 * ## Why this exists, when `modules:dag:check` already validates dependencies
 *
 * `modules:dag:check` validates the declared graph — self-edges, duplicates,
 * missing keys, cycles. It is fed `listModules()`, i.e. the **hand-written**
 * `dependencies` arrays. That makes it structurally incapable of noticing the
 * one thing that actually rots: an import edge that exists in the CODE but was
 * never declared. A module can grow a runtime dependency on another module and
 * every existing gate stays green, because nothing ever compared the two.
 *
 * This is not hypothetical bookkeeping. `dependencies` is semantically
 * load-bearing (Issue #845, PR #855): it drives protected-module computation,
 * deployment-profile presets, and the reverse-dependency guard that refuses to
 * disable a module something else needs. An UNDECLARED edge therefore means the
 * platform can disable `B` while `A` still calls into it at runtime — the
 * failure only shows up in production, in a tenant that happened to disable the
 * right module.
 *
 * The invariant was verified clean when this gate was written: 0 undeclared
 * edges across 241 cross-module runtime import edges (43 distinct module→module
 * pairs once `_shared` is excluded) in 597 files. That is precisely why it is
 * cheap to add NOW: the gate locks in a good state instead of arriving with a
 * backlog attached.
 *
 * ## Runtime imports only, and that is deliberate
 *
 * Detection uses `Bun.Transpiler.scanImports`, which ERASES `import type`
 * before reporting. That is the semantics we want, not a limitation to work
 * around: `dependencies` governs runtime enablement, so a type-only import —
 * which vanishes at build time and cannot call anything — must NOT be forced to
 * declare a runtime dependency. Requiring it would push contributors to add a
 * FALSE `dependencies` edge purely to appease a gate, and that edge would then
 * change protected-module, preset, and reverse-dep-guard behaviour for real.
 * A gate that pressures people into lying about the dependency graph is worse
 * than no gate.
 *
 * Scanning is a real parse, not a regex over source text. Import syntax has
 * enough shapes (multi-line named imports, side-effect imports, dynamic
 * `import()`, `export ... from`) that a pattern list would quietly miss some,
 * and a gate with silent blind spots reads as "verified" while proving little.
 *
 * ## Directory names are NOT module keys
 *
 * The map from directory to key is built by importing each
 * `src/modules/<dir>/module.ts` and reading the descriptor's own `key`, because
 * the two genuinely diverge — `workflow-approval/` declares key `workflow`. A
 * `dir.replace("-", "_")` transform would silently mis-resolve that module and
 * then either miss its violations or invent ones. Deriving from the descriptor
 * means the mapping cannot drift from the registry.
 *
 * ## `_shared` is a seam, and the check is one-directional
 *
 * `src/modules/_shared` holds the capability PORTS (ADR-0011/ADR-0013) that
 * exist so modules can collaborate without importing each other. Imports INTO
 * `_shared` are therefore always allowed and never need declaring — that is the
 * sanctioned path.
 *
 * The reverse is reported as its own violation: `_shared` importing a concrete
 * module inverts the port relationship, making the shared seam depend on an
 * implementation. That is the exact shape Issue #859 had to unpick (a static
 * import from `social` into `news` config resolution), so it is worth catching
 * as a distinct, separately-named failure rather than folding into the generic
 * message.
 *
 * No I/O beyond reading the module sources, no network, no database.
 */
import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { listBaseModules } from "../src/modules";

const ROOT = resolve(import.meta.dir, "..");
const MODULES_DIR = resolve(ROOT, "src/modules");
const SHARED_DIR = "_shared";

/** Extensions whose files we scan, and which we try when resolving an extensionless specifier. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;

export type Violation =
  | {
      kind: "undeclared_dependency";
      fromDir: string;
      fromKey: string;
      toDir: string;
      toKey: string;
      file: string;
      specifier: string;
    }
  | {
      kind: "shared_depends_on_module";
      toDir: string;
      file: string;
      specifier: string;
    }
  | {
      kind: "unmapped_directory";
      dir: string;
    };

/** One runtime import edge already resolved to its owning module directories. */
export type ResolvedImportEdge = {
  /** Module directory the importing file lives in. */
  fromDir: string;
  /** Module directory the specifier resolves into. */
  toDir: string;
  /** Repo-relative path of the importing file, for the failure message. */
  file: string;
  specifier: string;
};

/**
 * The whole decision, as a pure function over already-resolved edges.
 *
 * Kept separate from `main`'s filesystem walk so the rules can be tested
 * directly with synthetic edges — including the cases that are awkward to
 * stage on disk (a `_shared` inversion, an unmapped directory). Testing a gate
 * only through its I/O shell tends to verify that it RUNS rather than that it
 * DECIDES correctly, which is how a gate ends up unable to fail.
 */
export function computeImportViolations(input: {
  edges: readonly ResolvedImportEdge[];
  /** module directory -> registered descriptor key */
  dirToKey: ReadonlyMap<string, string>;
  /** descriptor key -> declared dependency keys */
  dependenciesByKey: ReadonlyMap<string, ReadonlySet<string>>;
  /** Directories with no resolvable descriptor, reported as their own failure. */
  unmappedDirectories?: readonly string[];
}): Violation[] {
  const violations: Violation[] = (input.unmappedDirectories ?? []).map(
    (dir) => ({ kind: "unmapped_directory" as const, dir })
  );

  for (const edge of input.edges) {
    if (edge.fromDir === edge.toDir) continue;

    if (edge.fromDir === SHARED_DIR) {
      violations.push({
        kind: "shared_depends_on_module",
        toDir: edge.toDir,
        file: edge.file,
        specifier: edge.specifier
      });
      continue;
    }

    if (edge.toDir === SHARED_DIR) continue; // the sanctioned port seam

    const fromKey = input.dirToKey.get(edge.fromDir);
    const toKey = input.dirToKey.get(edge.toDir);
    if (!fromKey || !toKey) continue; // already reported as unmapped

    if (!input.dependenciesByKey.get(fromKey)?.has(toKey)) {
      violations.push({
        kind: "undeclared_dependency",
        fromDir: edge.fromDir,
        fromKey,
        toDir: edge.toDir,
        toKey,
        file: edge.file,
        specifier: edge.specifier
      });
    }
  }

  return violations;
}

async function listModuleDirectories(): Promise<string[]> {
  const entries = await readdir(MODULES_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * directory -> module key, read from each directory's own descriptor rather
 * than transformed from the directory name (see header).
 */
async function buildDirectoryToKeyMap(
  directories: readonly string[]
): Promise<{ map: Map<string, string>; unmapped: string[] }> {
  const registeredKeys = new Set(listBaseModules().map((module) => module.key));
  const map = new Map<string, string>();
  const unmapped: string[] = [];

  for (const dir of directories) {
    if (dir === SHARED_DIR) continue;

    const modulePath = join(MODULES_DIR, dir, "module.ts");
    let exports: Record<string, unknown>;
    try {
      exports = (await import(modulePath)) as Record<string, unknown>;
    } catch {
      unmapped.push(dir);
      continue;
    }

    const descriptor = Object.values(exports).find(
      (value): value is { key: string } =>
        typeof value === "object" &&
        value !== null &&
        typeof (value as { key?: unknown }).key === "string" &&
        registeredKeys.has((value as { key: string }).key)
    );

    if (descriptor) {
      map.set(dir, descriptor.key);
    } else {
      unmapped.push(dir);
    }
  }

  return { map, unmapped };
}

async function listSourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
    // `entry.parentPath` is where recursive readdir reports the containing dir.
    found.push(join(entry.parentPath ?? dir, entry.name));
  }
  return found;
}

/**
 * Which module directory a resolved specifier lands in, or null when it points
 * outside `src/modules` (`src/lib`, node builtins, packages — all irrelevant
 * here, since only module-to-module edges are governed by `dependencies`).
 */
function moduleDirectoryOf(absolutePath: string): string | null {
  const rel = relative(MODULES_DIR, absolutePath);
  if (rel.startsWith("..") || rel.length === 0) return null;
  const [first] = rel.split("/");
  return first && first.length > 0 ? first : null;
}

async function main(): Promise<void> {
  const directories = await listModuleDirectories();
  const { map: dirToKey, unmapped } = await buildDirectoryToKeyMap(directories);

  const dependenciesByKey = new Map(
    listBaseModules().map((module) => [
      module.key,
      new Set(module.dependencies)
    ])
  );

  const unparseable: string[] = [];
  const edges: ResolvedImportEdge[] = [];
  const transpiler = new Bun.Transpiler({ loader: "tsx" });
  let scannedFiles = 0;

  for (const dir of directories) {
    const files = await listSourceFiles(join(MODULES_DIR, dir));

    for (const file of files) {
      scannedFiles += 1;
      const source = await Bun.file(file).text();

      let imports: { path: string }[];
      try {
        imports = transpiler.scanImports(source);
      } catch {
        // A file this scanner cannot parse must not pass silently.
        unparseable.push(`${relative(ROOT, file)} (unparseable)`);
        continue;
      }

      for (const { path: specifier } of imports) {
        if (!specifier.startsWith(".")) continue;

        const resolved = resolve(dirname(file), specifier);
        const targetDir = moduleDirectoryOf(resolved);
        if (!targetDir || targetDir === dir) continue;

        edges.push({
          fromDir: dir,
          toDir: targetDir,
          file: relative(ROOT, file),
          specifier
        });
      }
    }
  }

  const violations = computeImportViolations({
    edges,
    dirToKey,
    dependenciesByKey,
    unmappedDirectories: [...unmapped, ...unparseable]
  });
  const crossModuleEdges = edges.length;

  if (violations.length === 0) {
    console.log(
      `modules:imports:check OK — ${scannedFiles} module source files scanned, ` +
        `${crossModuleEdges} cross-module runtime import edges, all covered by declared dependencies.`
    );
    return;
  }

  console.error("modules:imports:check FAILED —");
  for (const violation of violations) {
    if (violation.kind === "undeclared_dependency") {
      console.error(
        `  ${violation.file}\n` +
          `    imports "${violation.specifier}" -> module "${violation.toKey}", ` +
          `but "${violation.fromKey}" does not declare it in dependencies.\n` +
          `    Fix by ONE of: (a) add "${violation.toKey}" to ${violation.fromDir}/module.ts dependencies ` +
          `if this really is a runtime dependency; (b) make it an \`import type\` if only the type is needed; ` +
          `(c) route the call through a capability port in _shared/ so the modules stay decoupled.`
      );
    } else if (violation.kind === "shared_depends_on_module") {
      console.error(
        `  ${violation.file}\n` +
          `    _shared imports "${violation.specifier}" -> module "${violation.toDir}". ` +
          `Ports must not depend on implementations (ADR-0011/ADR-0013; see Issue #859).\n` +
          `    Invert it: declare the port in _shared and have the module inject its implementation at the composition root.`
      );
    } else {
      console.error(
        `  module directory "${violation.dir}" has no resolvable descriptor key — ` +
          `cannot check its imports. Every directory under src/modules (except _shared) must export ` +
          `a registered ModuleDescriptor from module.ts.`
      );
    }
  }
  process.exitCode = 1;
}

if (import.meta.main) {
  await main();
}
