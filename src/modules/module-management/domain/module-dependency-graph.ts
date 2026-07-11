/**
 * Registry-wide dependency-graph validation (Issue #680, epic #679).
 * `domain/tenant-module-lifecycle.ts`'s `hasDependencyCycle` only ever
 * checks ONE module (the one an admin is trying to enable) against the
 * live graph — it has no notion of "is the WHOLE registry a valid DAG",
 * which is exactly the gap that let `tenant_admin`/`profile_identity`/
 * `identity_access` sit in a live 3-cycle in `dependencies` arrays for a
 * long time undetected (nothing ever iterated the full registry). This
 * module is that whole-registry check — a CI/build-time gate
 * (`scripts/validate-module-graph.ts`, `bun run modules:dag:check`, spliced
 * into `bun run check` right after `api:spec:check`), and reused by
 * `scripts/modules-sync.ts` (refuses to sync a broken graph to the DB
 * mirror table).
 *
 * Four distinct problems detected, each independently, so all of them
 * appear in `issues` for the same run rather than stopping at the first:
 * - `self_dependency` — a module listing itself.
 * - `duplicate_dependency` — the same key repeated in one `dependencies`
 *   array (harmless for `hasDependencyCycle`'s DFS, but real registry
 *   noise `descriptor-sync.ts`'s upsert should never have to swallow).
 * - `missing_dependency` — a key that isn't any registered module's `key`.
 * - `cycle` — one or more modules whose dependency chain(s) never bottom
 *   out (detected registry-wide via Kahn's algorithm: repeatedly remove
 *   every node whose remaining dependencies are all already resolved;
 *   whatever is left when no more can be removed is, by definition, in a
 *   cycle). `path` is a human-readable module-key chain
 *   (`["tenant_admin", "profile_identity", "tenant_admin"]`) — module keys
 *   are static code identifiers, never secrets/tenant data, safe to print
 *   verbatim in CI output or an error message.
 *
 * Self-dependencies and duplicates are excluded from the edges Kahn's
 * algorithm walks (already reported as their own issue) so a self-loop or
 * a repeated key can never itself manufacture a spurious `cycle` report on
 * top of the more specific issue already raised for it.
 */
import type { ModuleDescriptor } from "../../_shared/module-contract";

export type ModuleDependencyGraphIssue =
  | { type: "self_dependency"; moduleKey: string }
  | { type: "duplicate_dependency"; moduleKey: string; dependencyKey: string }
  | { type: "missing_dependency"; moduleKey: string; dependencyKey: string }
  | { type: "cycle"; path: readonly string[] };

export type ModuleDependencyGraphValidationResult =
  | { valid: true }
  | { valid: false; issues: readonly ModuleDependencyGraphIssue[] };

export function formatModuleDependencyGraphIssue(
  issue: ModuleDependencyGraphIssue
): string {
  switch (issue.type) {
    case "self_dependency":
      return `Module "${issue.moduleKey}" declares itself as its own dependency.`;
    case "duplicate_dependency":
      return `Module "${issue.moduleKey}" declares dependency "${issue.dependencyKey}" more than once.`;
    case "missing_dependency":
      return `Module "${issue.moduleKey}" depends on "${issue.dependencyKey}", which is not a registered module.`;
    case "cycle":
      return `Circular dependency: ${issue.path.join(" -> ")}.`;
  }
}

/** DFS restricted to the already-known-cyclic node set, using the current recursion stack to find where a walk first revisits a node still on the stack — that suffix (plus the repeated node) is a genuine cycle path, not just "these nodes are somewhere in a cycle." */
function findCyclePath(
  cyclicKeys: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>
): string[] {
  const cyclicSet = new Set(cyclicKeys);
  const stack: string[] = [];
  const onStack = new Set<string>();
  const visited = new Set<string>();
  let found: string[] | null = null;

  function walk(key: string): void {
    if (found) {
      return;
    }

    stack.push(key);
    onStack.add(key);
    visited.add(key);

    for (const dep of edges.get(key) ?? []) {
      if (!cyclicSet.has(dep)) {
        continue;
      }

      if (onStack.has(dep)) {
        const cycleStart = stack.indexOf(dep);
        found = [...stack.slice(cycleStart), dep];
        return;
      }

      if (!visited.has(dep)) {
        walk(dep);
        if (found) {
          return;
        }
      }
    }

    stack.pop();
    onStack.delete(key);
  }

  walk(cyclicKeys[0]!);
  return found ?? [...cyclicKeys, cyclicKeys[0]!];
}

export function validateModuleDependencyGraph(
  descriptors: readonly ModuleDescriptor[]
): ModuleDependencyGraphValidationResult {
  const issues: ModuleDependencyGraphIssue[] = [];
  const descriptorByKey = new Map(descriptors.map((d) => [d.key, d]));

  // `validEdges` excludes self-dependencies and duplicates (already
  // reported above) AND missing keys (also already reported, and would
  // otherwise make every node they touch spuriously unresolved-forever in
  // the Kahn's-algorithm pass below, masking any REAL cycle as a
  // "MODULE_DEPENDENCY_MISSING"-shaped false cycle).
  const validEdges = new Map<string, string[]>();

  for (const descriptor of descriptors) {
    const seen = new Set<string>();
    const edges: string[] = [];

    for (const dependencyKey of descriptor.dependencies) {
      if (dependencyKey === descriptor.key) {
        issues.push({ type: "self_dependency", moduleKey: descriptor.key });
        continue;
      }

      if (seen.has(dependencyKey)) {
        issues.push({
          type: "duplicate_dependency",
          moduleKey: descriptor.key,
          dependencyKey
        });
        continue;
      }
      seen.add(dependencyKey);

      if (!descriptorByKey.has(dependencyKey)) {
        issues.push({
          type: "missing_dependency",
          moduleKey: descriptor.key,
          dependencyKey
        });
        continue;
      }

      edges.push(dependencyKey);
    }

    validEdges.set(descriptor.key, edges);
  }

  // Kahn's algorithm: a node is "resolvable" once every dependency it has
  // (via `validEdges`) has already been resolved. Repeatedly resolve
  // everything that's ready; whatever never becomes ready is, by
  // definition, part of a cycle (every unresolved node has at least one
  // unresolved dependency, and since the set is finite, that chain must
  // eventually loop back).
  const resolved = new Set<string>();
  let progressed = true;

  while (progressed) {
    progressed = false;

    for (const descriptor of descriptors) {
      if (resolved.has(descriptor.key)) {
        continue;
      }

      const deps = validEdges.get(descriptor.key) ?? [];
      if (deps.every((dep) => resolved.has(dep))) {
        resolved.add(descriptor.key);
        progressed = true;
      }
    }
  }

  const cyclic = descriptors
    .map((d) => d.key)
    .filter((key) => !resolved.has(key));

  if (cyclic.length > 0) {
    issues.push({ type: "cycle", path: findCyclePath(cyclic, validEdges) });
  }

  return issues.length > 0 ? { valid: false, issues } : { valid: true };
}
