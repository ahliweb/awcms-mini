/**
 * saas-contract-registry-check.ts — `bun run saas-contracts:registry:check`,
 * part of `bun run check`.
 *
 * Issue #874 (epic #868 SaaS control plane, ADR-0022). The read-only gate for
 * the SaaS commercial contract registry. Four checks in one pass, all wired
 * into `bun run check` (so a defect can never merge green):
 *
 * 1. **Registry validation + source ownership** — `validateSaasContractRegistry`
 *    over the composed `listModules()`: rejects duplicate keys, unknown owners,
 *    unsafe units, unbounded/NaN/negative values, conflicting aggregation
 *    semantics, missing/invalid privacy classification, quota→meter dangling
 *    references, hard-enforced informational meters, and the deprecated pre-#874
 *    thin key fields.
 * 2. **Event/AsyncAPI parity** — every commercial-event descriptor's
 *    `eventType` MUST be an actual channel in
 *    `asyncapi/awcms-mini-domain-events.asyncapi.yaml`. The pure validator
 *    already checks `eventType ∈ ownerModule.events.publishes` (which
 *    `api:spec:check` ties to a channel); this reads the AsyncAPI file directly
 *    so the parity is enforced end to end here too, not only transitively.
 * 3. **Catalog/entitlement/meter reference** — a byproduct of (1): the same
 *    `resolveSaasContractRegistry` the catalog and entitlement modules resolve
 *    from is validated here, so a reference either resolves for all consumers or
 *    fails the build for all of them.
 * 4. **Freshness** — regenerates the machine-readable JSON + human-readable MD
 *    inventory in memory and diffs the committed files (same idiom as
 *    `work-class-registry-check.ts`).
 *
 * The pure validation (1) and the inventory build (4) are I/O-free; only this
 * script reads the AsyncAPI file (2) and the committed inventory (4) — same
 * "pure domain, thin I/O boundary" split every other registry gate uses.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

import { listModules } from "../src/modules";
import {
  formatSaasContractRegistryIssue,
  resolveSaasContractRegistry,
  validateSaasContractRegistry
} from "../src/modules/_shared/saas-contract-registry";
import {
  SAAS_CONTRACT_INVENTORY_JSON_PATH,
  SAAS_CONTRACT_INVENTORY_MD_PATH,
  buildSaasContractInventoryJson,
  buildSaasContractInventoryMarkdown
} from "./saas-contract-inventory-generate";
import { ASYNCAPI_PATH } from "./api-spec-check";

export async function runSaasContractRegistryCheck(
  rootDir = process.cwd()
): Promise<string[]> {
  const problems: string[] = [];
  const modules = listModules();

  // (1) + (3) registry validation + source ownership + reference resolution.
  const validation = validateSaasContractRegistry(modules);
  for (const issue of validation.issues) {
    problems.push(formatSaasContractRegistryIssue(issue));
  }

  // (2) event/AsyncAPI parity — every commercial event must be a real channel.
  const registry = resolveSaasContractRegistry(modules);
  if (registry.commercialEventTypes.size > 0) {
    let channelAddresses: Set<string>;
    try {
      const raw = await readFile(path.join(rootDir, ASYNCAPI_PATH), "utf8");
      const document = parse(raw) as {
        channels?: Record<string, { address?: unknown }>;
      } | null;
      // A commercial event's `eventType` is an AsyncAPI channel ADDRESS, which
      // is the `address` field of a channel — NOT its map key. They are equal by
      // convention in this repo today, but keying on the map id would false-pass
      // (or false-fail) the moment a channel id diverges from its address, so
      // read `address` and fall back to the id only when absent (Issue #874
      // audit L3).
      channelAddresses = new Set(
        Object.entries(document?.channels ?? {}).map(([id, channel]) =>
          typeof channel?.address === "string" ? channel.address : id
        )
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return [
        ...problems,
        `Could not read/parse ${ASYNCAPI_PATH} for commercial-event parity: ${message}`
      ];
    }
    for (const eventType of registry.commercialEventTypes) {
      if (!channelAddresses.has(eventType)) {
        problems.push(
          `[${eventType}] commercial-event descriptor has no matching channel in ${ASYNCAPI_PATH} — event/AsyncAPI parity broken.`
        );
      }
    }
  }

  // (4) freshness — regenerate and diff committed inventory artifacts.
  const [freshJson, freshMd] = await Promise.all([
    Promise.resolve(buildSaasContractInventoryJson(modules)),
    buildSaasContractInventoryMarkdown(modules, rootDir)
  ]);

  const diffs: Array<{ label: string; freshValue: string }> = [
    { label: SAAS_CONTRACT_INVENTORY_JSON_PATH, freshValue: freshJson },
    { label: SAAS_CONTRACT_INVENTORY_MD_PATH, freshValue: freshMd }
  ];
  for (const { label, freshValue } of diffs) {
    let committed: string;
    try {
      committed = await readFile(path.join(rootDir, label), "utf8");
    } catch {
      problems.push(
        `${label} is missing — run \`bun run saas-contracts:inventory:generate\` and commit the result.`
      );
      continue;
    }
    if (committed !== freshValue) {
      problems.push(
        `${label} does not match a fresh regeneration — run ` +
          "`bun run saas-contracts:inventory:generate` and commit the result " +
          "(a SaaS contract descriptor was likely added/changed without regenerating the inventory)."
      );
    }
  }

  return problems;
}

if (import.meta.main) {
  const problems = await runSaasContractRegistryCheck();

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`  ${problem}`);
    }
    console.error(
      `\nsaas-contracts:registry:check FAILED — ${problems.length} problem(s).`
    );
    process.exitCode = 1;
  } else {
    console.log(
      "saas-contracts:registry:check OK — SaaS contract registry valid, AsyncAPI parity intact, inventory fresh."
    );
  }
}
