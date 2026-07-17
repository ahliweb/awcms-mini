/**
 * Composition-root wiring gate for inverted domain-event consumer
 * registration (Issue #826).
 *
 * #826 broke the `domain_event_runtime <-> integration_hub` import cycle by
 * inverting registration: a module that owns a consumer registers it from
 * its own `infrastructure/domain-event-consumer-registration.ts`, and the
 * runtime imports no consumer module at all. That is the right direction —
 * but it trades a compile-time guarantee for a runtime one. The old static
 * array could not be incomplete; a side-effect registration can, if the
 * file is never imported in a given process.
 *
 * And it fails SILENTLY, which is why this gate is not optional:
 * `dispatch-domain-events.ts` iterates REGISTERED CONSUMERS and selects
 * deliveries per consumer, so an unregistered consumer's deliveries are
 * never claimed — no error, no dead-letter, no log line. They simply sit
 * `pending` forever. For `integration_hub` that means outbound webhooks
 * silently never delivering. (The publish and replay paths fail more
 * visibly — zero delivery rows created, or `UnknownReplayConsumerError` —
 * but "more visibly" is not "visibly".)
 *
 * So: every registration file that EXISTS must be imported by every
 * composition root that executes consumers. Discovering the files by
 * convention (rather than listing them) is what makes this catch the case
 * it is built for — a NEW module adding a registration file and forgetting
 * a root. That is the same class of gap as PR #769/#770's "validator exists
 * but is never wired to the real path", applied to registration.
 *
 * ── PUBLISH side (Issue #848) ────────────────────────────────────────────
 * The DISPATCH/REPLAY roots below are named by hand because their rule is
 * "every root imports EVERY registration file" — right for a root that
 * RESOLVES handlers (it can be handed any consumer's delivery). The PUBLISH
 * side is different and is now DERIVED, not named: `appendDomainEvent`
 * creates delivery rows FROM THE REGISTRY at publish time, so a publisher
 * that has not imported the registration for a consumer subscribed to its
 * event creates ZERO rows for an event that really happened — strictly
 * worse than a missed dispatch (a missed dispatch leaves rows `pending` and
 * re-running recovers them; a missed publish loses them permanently, with
 * nothing to reconstruct from, and silently).
 *
 * PR #847 asserted this with a HAND-NAMED `PUBLISH_ROOTS` list — an
 * untested assumption that a new cross-module consumer whose event type is
 * published elsewhere would silently slip past until someone remembered to
 * add an entry. #848 removes the list and DERIVES the roots from code (see
 * `derivePublishRoots` below): for every registered consumer that is not
 * one of the runtime's own (`BASE_DOMAIN_EVENT_CONSUMERS`), it resolves the
 * exported event-type constants each `appendDomainEvent` call publishes
 * (real identifier resolution via ES import — not a literal grep, and it
 * follows ternary operands), finds the publishers of that consumer's event
 * types, and requires each same-module publisher to import that consumer's
 * registration. A publisher in a DIFFERENT module than the consumer is not
 * silently required to import across the boundary (that would manufacture
 * exactly the cross-module edge #826 deleted) — it is FLAGGED as an
 * architectural signal, because the registration then belongs in a process
 * composition root, not in the publisher's module.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  BASE_DOMAIN_EVENT_CONSUMERS,
  DOMAIN_EVENT_CONSUMERS
} from "../../src/modules/domain-event-runtime/infrastructure/consumer-registry";
import type { DomainEventConsumerDefinition } from "../../src/modules/domain-event-runtime/domain/consumer-types";

const REPO_ROOT = path.join(import.meta.dir, "../..");
const MODULES_ROOT = path.join(REPO_ROOT, "src/modules");

const REGISTRATION_FILE_NAME = "domain-event-consumer-registration.ts";

/**
 * Every process/entry point that resolves a consumer's HANDLER. A new one
 * must be added here AND import every registration file. Publish roots are
 * NOT listed here — they are derived (Issue #848); this list's rule ("every
 * root imports EVERY registration file") is right for a handler-RESOLVING
 * root (dispatch/replay can be handed any consumer's delivery) but wrong for
 * a PUBLISHER, which must import only the registration for a consumer of an
 * event IT actually publishes, or forcing `integration_hub`'s publisher to
 * import `reporting`'s registration would manufacture the cross-module edge
 * Issue #826 deleted.
 */
const COMPOSITION_ROOTS = [
  // DISPATCH — `bun run domain-events:dispatch`, its own process.
  "scripts/domain-events-dispatch.ts",
  // REPLAY — resolves the handler via `getConsumerByName`.
  "src/pages/api/v1/domain-events/deliveries/[id]/replay.ts"
];

function findRegistrationFiles(): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(MODULES_ROOT)) {
    const infraDir = path.join(MODULES_ROOT, entry, "infrastructure");

    try {
      if (!statSync(infraDir).isDirectory()) continue;
    } catch {
      continue;
    }

    if (readdirSync(infraDir).includes(REGISTRATION_FILE_NAME)) {
      found.push(`${entry}/infrastructure/${REGISTRATION_FILE_NAME}`);
    }
  }

  return found.sort();
}

/** First path segment under `src/modules` — the module directory name. */
function moduleDirOf(relFromModules: string): string {
  return relFromModules.split("/")[0]!;
}

/** All non-test `.ts` files under `src/modules`. */
function walkModuleSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkModuleSources(abs));
    else if (entry.name.endsWith(".ts") && !/\.test\.ts$/.test(entry.name)) {
      out.push(abs);
    }
  }
  return out;
}

/** `import { A, B as C } from "spec"` / `import D from "spec"` → name → spec. */
function importedIdentifierSources(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const re =
    /import\s+(?:type\s+)?(\{[^}]*\}|[A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const clause = m[1]!;
    const spec = m[2]!;
    if (clause.startsWith("{")) {
      for (const raw of clause.slice(1, -1).split(",")) {
        const name = raw
          .trim()
          .split(/\s+as\s+/)
          .pop()!
          .trim();
        if (name) map.set(name, spec);
      }
    } else {
      map.set(clause.trim(), spec);
    }
  }
  return map;
}

/**
 * The text of every `appendDomainEvent(...)` call's `eventType:` operand.
 * Scans from the key to the operand's terminating top-level `,`/`}` while
 * tracking `()[]{}` nesting, so a multi-line TERNARY operand (e.g.
 * `cond ? A_EVENT_TYPE : B_EVENT_TYPE`) is captured whole — a real case in
 * `workflow-instance.ts`/`workflow-instance-decision.ts`.
 */
function eventTypeOperands(source: string): string[] {
  const operands: string[] = [];
  const callRe = /\bappendDomainEvent\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(source))) {
    const keyIdx = source.indexOf("eventType:", m.index);
    if (keyIdx === -1) continue;
    let depth = 0;
    let buf = "";
    for (let i = keyIdx + "eventType:".length; i < source.length; i++) {
      const ch = source[i]!;
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) {
        if (depth === 0) break;
        depth--;
      } else if (ch === "," && depth === 0) break;
      buf += ch;
    }
    operands.push(buf.trim());
  }
  return operands;
}

const namespaceCache = new Map<string, Record<string, unknown>>();
async function importRelative(fromFile: string, spec: string) {
  const resolved = path.resolve(path.dirname(fromFile), spec);
  const withExt = resolved.endsWith(".ts") ? resolved : `${resolved}.ts`;
  if (!namespaceCache.has(withExt)) {
    namespaceCache.set(
      withExt,
      (await import(pathToFileURL(withExt).href)) as Record<string, unknown>
    );
  }
  return namespaceCache.get(withExt)!;
}

type DerivedPublishRoot = {
  consumerName: string;
  eventType: string;
  /** Publisher file, relative to repo root. */
  publisher: string;
  /** Registration file the publisher must import, relative to repo root. */
  registration: string;
  /** Absolute path of that registration file (for import-statement matching). */
  registrationAbs: string;
  sameModule: boolean;
};

type Derivation = {
  registrationFiles: string[];
  nonBaseConsumers: { name: string; eventTypes: readonly string[] }[];
  /** consumerName → registration file (relative to repo root). */
  registrationByConsumer: Map<string, string>;
  /** eventType string → set of publisher files (relative to repo root). */
  publishersByEventType: Map<string, Set<string>>;
  /** appendDomainEvent calls whose eventType operand resolved to nothing. */
  blindSpots: { publisher: string; operand: string }[];
  publishRoots: DerivedPublishRoot[];
};

function looksLikeConsumerDefinition(
  value: unknown
): value is DomainEventConsumerDefinition {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    Array.isArray(v.eventTypes) &&
    typeof v.handler === "function"
  );
}

async function derivePublishRoots(): Promise<Derivation> {
  const registrationFiles = findRegistrationFiles();

  // Import every registration file (side effect: registers its consumer),
  // guaranteeing the registry is complete even when this test runs in
  // isolation, and read back the exported consumer object(s) so each
  // consumer can be mapped to the file that owns it — structurally, not by
  // guessing a module key from a directory name (module keys and directory
  // names diverge, e.g. `workflow` vs `workflow-approval`).
  const registrationByConsumer = new Map<string, string>();
  for (const relFromModules of registrationFiles) {
    const abs = path.join(MODULES_ROOT, relFromModules);
    const ns = (await import(pathToFileURL(abs).href)) as Record<
      string,
      unknown
    >;
    const relFromRepo = path.relative(REPO_ROOT, abs);
    for (const exported of Object.values(ns)) {
      if (looksLikeConsumerDefinition(exported)) {
        registrationByConsumer.set(exported.name, relFromRepo);
      }
    }
  }

  const baseNames = new Set(BASE_DOMAIN_EVENT_CONSUMERS.map((c) => c.name));
  const nonBaseConsumers = DOMAIN_EVENT_CONSUMERS.filter(
    (c) => !baseNames.has(c.name)
  ).map((c) => ({ name: c.name, eventTypes: c.eventTypes }));

  // Build eventType-string → publishers, resolving each operand's exported
  // constants through the publisher file's OWN imports (real ES import, not
  // a literal grep — the identifier may be re-exported/renamed and may be a
  // ternary of several constants).
  const publishersByEventType = new Map<string, Set<string>>();
  const blindSpots: { publisher: string; operand: string }[] = [];
  const publisherFiles = walkModuleSources(MODULES_ROOT).filter((f) =>
    /\bappendDomainEvent\s*\(/.test(readFileSync(f, "utf-8"))
  );
  for (const file of publisherFiles) {
    const src = readFileSync(file, "utf-8");
    const importSources = importedIdentifierSources(src);
    const relFromRepo = path.relative(REPO_ROOT, file);
    for (const operand of eventTypeOperands(src)) {
      const ids = operand.match(/[A-Za-z_$][\w$]*/g) ?? [];
      let resolvedAny = false;
      for (const id of ids) {
        const spec = importSources.get(id);
        if (!spec || !spec.startsWith(".")) continue;
        const ns = await importRelative(file, spec);
        if (typeof ns[id] === "string") {
          resolvedAny = true;
          const eventType = ns[id] as string;
          if (!publishersByEventType.has(eventType)) {
            publishersByEventType.set(eventType, new Set());
          }
          publishersByEventType.get(eventType)!.add(relFromRepo);
        }
      }
      if (!resolvedAny) blindSpots.push({ publisher: relFromRepo, operand });
    }
  }

  // Cross-join: for each non-base consumer's event type, every publisher of
  // that type is a publish root that must import that consumer's
  // registration.
  const publishRoots: DerivedPublishRoot[] = [];
  for (const consumer of nonBaseConsumers) {
    const registration = registrationByConsumer.get(consumer.name);
    if (!registration) continue; // guarded by a dedicated test below
    const registrationAbs = path.join(REPO_ROOT, registration);
    const registrationModule = moduleDirOf(
      path.relative(MODULES_ROOT, registrationAbs)
    );
    for (const eventType of consumer.eventTypes) {
      for (const publisher of publishersByEventType.get(eventType) ?? []) {
        const publisherModule = moduleDirOf(
          path.relative(MODULES_ROOT, path.join(REPO_ROOT, publisher))
        );
        publishRoots.push({
          consumerName: consumer.name,
          eventType,
          publisher,
          registration,
          registrationAbs,
          sameModule: publisherModule === registrationModule
        });
      }
    }
  }

  return {
    registrationFiles,
    nonBaseConsumers,
    registrationByConsumer,
    publishersByEventType,
    blindSpots,
    publishRoots
  };
}

/**
 * Does `source` contain a side-effect IMPORT STATEMENT whose specifier
 * resolves (relative to `fromFile`) to `targetAbs`? Matches the STATEMENT,
 * never a mere mention — `source.includes(specifier)` is satisfied by a
 * COMMENT naming the path, the exact "prose satisfies the gate" defect that
 * shipped in #847's first publish-side check (and lives one line above the
 * real import in `inbound-webhook-intake.ts`). Resolving-and-comparing also
 * means a same-named registration in a DIFFERENT module cannot satisfy it.
 */
function importsSideEffect(
  source: string,
  fromFile: string,
  targetAbs: string
): boolean {
  const re = /^\s*import\s+["']([^"']+)["']\s*;?\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const spec = m[1]!;
    if (!spec.startsWith(".")) continue;
    const resolved = path.resolve(path.dirname(fromFile), spec);
    const withExt = resolved.endsWith(".ts") ? resolved : `${resolved}.ts`;
    if (withExt === targetAbs) return true;
  }
  return false;
}

const derivation = await derivePublishRoots();

describe("domain-event consumer registration wiring (Issue #826)", () => {
  const registrationFiles = derivation.registrationFiles;

  test("the registration files this gate is built for actually exist (sanity check for this test itself)", () => {
    // Without this, deleting every registration file would make the gate
    // below vacuously pass — a test that cannot fail proves nothing.
    expect(registrationFiles).toEqual([
      "integration-hub/infrastructure/domain-event-consumer-registration.ts",
      "reporting/infrastructure/domain-event-consumer-registration.ts"
    ]);
  });

  for (const root of COMPOSITION_ROOTS) {
    for (const registrationFile of registrationFiles) {
      test(`${root} imports ${registrationFile}`, () => {
        const source = readFileSync(path.join(REPO_ROOT, root), "utf-8");
        const moduleSpecifier = registrationFile.replace(/\.ts$/, "");

        // An import STATEMENT ending in this specifier — not any mention of
        // it. `includes()` is satisfied by a comment naming the path, which
        // is the same defect this PR fixes in `ci-check-parity.test.ts` and
        // which the publish-side check below shipped with until it was
        // caught. The relative prefix varies by root (`../`, `../../…`), so
        // the specifier is anchored at the end of the module string.
        const importStatement = new RegExp(
          `^\\s*import\\s+["'][^"']*${moduleSpecifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\.ts)?["']\\s*;?\\s*$`,
          "m"
        );

        expect(
          importStatement.test(source),
          `${root} must \`import "…/${moduleSpecifier}";\` for its side effect. ` +
            `Without it, that consumer is not registered in this process and its deliveries are never claimed — silently, forever.`
        ).toBe(true);
      });
    }
  }

  // ── PUBLISH-side wiring, DERIVED from the registry (Issue #848) ──────────

  test("every non-base registered consumer maps to a registration file (else its publish root cannot be derived)", () => {
    // The derivation attributes a consumer to its registration file by that
    // file's EXPORTED consumer object. A cross-module consumer that registers
    // without exporting its definition would be invisible to the derivation —
    // fail loudly rather than silently skip its publish-root coverage.
    const unmapped = derivation.nonBaseConsumers.filter(
      (c) => !derivation.registrationByConsumer.has(c.name)
    );
    expect(
      unmapped.map((c) => c.name),
      "each non-base consumer must be exported from its `*/infrastructure/domain-event-consumer-registration.ts` so the publish-side derivation can find which registration a publisher of its event type must import"
    ).toEqual([]);
  });

  test("the publish-root derivation resolves every appendDomainEvent eventType operand (no blind spots)", () => {
    // If the derivation cannot resolve an operand to an exported event-type
    // constant, it is blind to that publish site and could silently miss a
    // real cross-module publish root. Keep every `eventType` a resolvable
    // exported constant (identifier or ternary of identifiers).
    expect(
      derivation.blindSpots,
      "appendDomainEvent eventType operand(s) the publish-root derivation could not resolve to an exported constant — make them resolvable exported constants, or the derivation is blind to those publishers"
    ).toEqual([]);
  });

  test("the publish-root derivation is not vacuous — it finds at least the integration_hub inbound publisher (sanity check for the derivation itself)", () => {
    // Anchors the derivation against a known-true fact so the per-root loop
    // below cannot silently register ZERO assertions (a vacuous pass). This
    // is the one same-module publish root the registry currently implies:
    // `integration_hub.outbound_subscription_fanout` subscribes to
    // `integration-hub.inbound-message.normalized`, published only by
    // `inbound-webhook-intake.ts` in the SAME module.
    const anchor = derivation.publishRoots.find(
      (r) =>
        r.consumerName === "integration_hub.outbound_subscription_fanout" &&
        r.publisher ===
          "src/modules/integration-hub/application/inbound-webhook-intake.ts"
    );
    expect(
      anchor,
      "expected the derivation to find integration_hub's inbound-webhook-intake.ts as a same-module publish root"
    ).toBeDefined();
    expect(anchor!.sameModule).toBe(true);
  });

  // Same-module publish roots: the publisher must import its own module's
  // consumer registration, or `appendDomainEvent` creates ZERO delivery rows
  // for a subscribed consumer at publish time — permanently and silently.
  for (const root of derivation.publishRoots.filter((r) => r.sameModule)) {
    test(`${root.publisher} imports ${root.registration} (publish-side for ${root.consumerName}: unregistered consumer = zero delivery rows, permanently)`, () => {
      const publisherAbs = path.join(REPO_ROOT, root.publisher);
      const source = readFileSync(publisherAbs, "utf-8");

      expect(
        importsSideEffect(source, publisherAbs, root.registrationAbs),
        `${root.publisher} publishes ${root.eventType} but does not import ${root.registration}.\n` +
          `Delivery rows are created FROM THE REGISTRY at publish time, so without this side-effect import the ` +
          `subscribed consumer ${root.consumerName} gets ZERO rows for an event that did happen — no error, no ` +
          `dead-letter, nothing to replay.\n` +
          `Add: import "../infrastructure/${REGISTRATION_FILE_NAME.replace(".ts", "")}";`
      ).toBe(true);
    });
  }

  // Cross-module publish roots: the publisher and the consumer's registration
  // live in DIFFERENT modules. Requiring the publisher to import across the
  // boundary would recreate exactly the cross-module edge Issue #826 removed,
  // so this is an ARCHITECTURAL SIGNAL, not something to satisfy with an
  // import: the registration belongs in a shared process composition root
  // (server entry / dispatch script), added to `COMPOSITION_ROOTS`. There are
  // none today; each one that appears fails here until it is resolved.
  const crossModulePublishRoots = derivation.publishRoots.filter(
    (r) => !r.sameModule
  );
  test("no cross-module publish root exists (deriving one would need a process-root registration, not a publisher-module import)", () => {
    expect(
      crossModulePublishRoots.map(
        (r) => `${r.publisher} publishes ${r.eventType} for ${r.consumerName}`
      ),
      "a publisher in a different module than the consumer's registration was found — its event's consumer cannot be " +
        "registered by importing across the module boundary (that recreates the cycle #826 removed). Move that " +
        "consumer's registration into a shared process composition root and add that root to COMPOSITION_ROOTS."
    ).toEqual([]);
  });

  test("the runtime's own registry imports no consumer module (the cycle #826 broke)", () => {
    const registry = readFileSync(
      path.join(
        MODULES_ROOT,
        "domain-event-runtime/infrastructure/consumer-registry.ts"
      ),
      "utf-8"
    );

    // `logging` is deliberately allowed — foundational infrastructure
    // beneath this runtime, one-directional by construction, and declared.
    for (const forbidden of ["integration-hub", "reporting"]) {
      expect(
        registry.includes(`../../${forbidden}/`),
        `consumer-registry.ts must not import ${forbidden}'s code — that is the import cycle Issue #826 removed. ` +
          `Have ${forbidden} call registerDomainEventConsumer() from its own registration file instead.`
      ).toBe(false);
    }
  });
});
