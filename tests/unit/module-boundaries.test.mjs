import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const srcDir = join(repoRoot, "src");
const modulesDir = join(srcDir, "modules");
const sourceExtensions = new Set([".js", ".mjs", ".ts", ".tsx"]);

function toPosixPath(path) {
  return path.split(sep).join("/");
}

function walkSourceFiles(dir) {
  if (!existsSync(dir)) return [];

  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSourceFiles(full));
      continue;
    }
    if (sourceExtensions.has(extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

function extractImportSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /\bimport\s+(?:[^"'()]+?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:[^"'()]+?\s+from\s+)["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function resolveImportPath(sourceFile, specifier) {
  if (specifier.startsWith(".")) {
    return normalize(resolve(dirname(sourceFile), specifier));
  }

  if (specifier.startsWith("src/modules/")) {
    return normalize(resolve(repoRoot, specifier));
  }

  if (specifier.startsWith("/src/modules/")) {
    return normalize(resolve(repoRoot, `.${specifier}`));
  }

  if (isAbsolute(specifier) && normalize(specifier).startsWith(modulesDir)) {
    return normalize(specifier);
  }

  return null;
}

function moduleNameFor(path) {
  const rel = toPosixPath(relative(modulesDir, path));
  if (rel.startsWith("..") || rel === "") return null;
  return rel.split("/")[0] || null;
}

function importsForModules() {
  const files = walkSourceFiles(modulesDir);
  const imports = [];

  for (const file of files) {
    const sourceModule = moduleNameFor(file);
    const source = readFileSync(file, "utf8");

    for (const specifier of extractImportSpecifiers(source)) {
      const target = resolveImportPath(file, specifier);
      if (!target || !target.startsWith(modulesDir)) continue;

      const targetModule = moduleNameFor(target);
      if (!sourceModule || !targetModule || sourceModule === targetModule)
        continue;

      imports.push({
        file: toPosixPath(relative(repoRoot, file)),
        sourceModule,
        specifier,
        target: toPosixPath(relative(repoRoot, target)),
        targetModule,
      });
    }
  }

  return imports;
}

function findCycles(edges) {
  const graph = new Map();
  for (const [from, to] of edges) {
    if (!graph.has(from)) graph.set(from, new Set());
    graph.get(from).add(to);
    if (!graph.has(to)) graph.set(to, new Set());
  }

  const cycles = [];
  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  function visit(node) {
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      cycles.push([...stack.slice(start), node].join(" -> "));
      return;
    }
    if (visited.has(node)) return;

    visiting.add(node);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      visit(next);
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  }

  for (const node of graph.keys()) {
    visit(node);
  }

  return [...new Set(cycles)];
}

test("module boundaries: modul lain tidak boleh import internal module lintas boundary", () => {
  const offenders = importsForModules().filter((entry) =>
    entry.target.includes(`/internal`),
  );

  assert.deepEqual(
    offenders,
    [],
    `Cross-module import harus lewat public contract. Pelanggar: ${JSON.stringify(offenders, null, 2)}`,
  );
});

test("module boundaries: tidak ada circular dependency antar modul", () => {
  const edges = importsForModules().map((entry) => [
    entry.sourceModule,
    entry.targetModule,
  ]);
  const cycles = findCycles(edges);

  assert.deepEqual(
    cycles,
    [],
    `Circular dependency antar modul dilarang: ${cycles.join("; ")}`,
  );
});
