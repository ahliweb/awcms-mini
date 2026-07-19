/**
 * saas-contract-inventory-generate.ts — `bun run saas-contracts:inventory:generate`.
 *
 * Issue #874 (epic #868 SaaS control plane, ADR-0022). Generates the
 * machine-readable + human-readable inventory of the SaaS commercial contract
 * registry — every feature/meter/quota/commercial-event descriptor declared
 * across the composed module registry (`listModules()`), with owner module,
 * version, unit, aggregation, privacy class, and billable status (Issue #874
 * AC "generated inventory lists owner module, version, unit, aggregation,
 * privacy class, and billable status").
 *
 * Same generate/check split as `work-class-registry-generate.ts`/`-check.ts`
 * (Issue #743) and `repo-inventory-generate.ts`/`-check.ts` (Issue #688): this
 * script MUTATES (writes) the artifacts, so it cannot be part of `bun run
 * check` directly; `saas-contract-registry-check.ts` is the read-only twin that
 * regenerates in memory and diffs against the committed files (freshness gate).
 *
 * Deterministic, no wall-clock timestamp (same "freshness enforced structurally"
 * reasoning `repo-inventory-generate.ts`/`work-class-registry-generate.ts`
 * document): every array is sorted by key, and the Markdown is Prettier-
 * formatted with the project's own config so the committed artifact already
 * satisfies `bun run lint` (which checks every `.md`) and a regeneration is
 * byte-identical for identical input.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import prettier from "prettier";

import { listModules } from "../src/modules";
import { SAAS_CONTRACT_VERSION } from "../src/modules/_shared/module-contract";
import { resolveSaasContractRegistry } from "../src/modules/_shared/saas-contract-registry";

export const SAAS_CONTRACT_INVENTORY_JSON_PATH =
  "docs/awcms-mini/saas-contract-registry.generated.json";
export const SAAS_CONTRACT_INVENTORY_MD_PATH =
  "docs/awcms-mini/saas-contract-registry.generated.md";

export type SaasContractInventory = {
  saasContractVersion: string;
  features: {
    key: string;
    ownerModule: string;
    description: string;
  }[];
  meters: {
    key: string;
    ownerModule: string;
    eventVersion: string;
    valueType: string;
    aggregation: string;
    correction: string;
    classification: string;
    billable: boolean;
    privacyClassification: string;
    minValue: number;
    maxValue: number;
  }[];
  quotas: {
    key: string;
    ownerModule: string;
    meterKey: string;
    unit: string;
    resetPeriod: string;
    enforcement: string;
  }[];
  commercialEvents: {
    eventType: string;
    ownerModule: string;
    eventVersion: string;
    kind: string;
  }[];
};

/** Pure — builds the inventory from a resolved registry (default `listModules()`), exported so the check twin and tests can build it without touching disk. */
export function buildSaasContractInventory(
  modules = listModules()
): SaasContractInventory {
  const registry = resolveSaasContractRegistry(modules);

  const features = [...registry.features.values()]
    .map((f) => ({
      key: f.key,
      ownerModule: f.ownerModuleKey,
      description: f.description
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const meters = [...registry.meters.values()]
    .map((m) => ({
      key: m.key,
      ownerModule: m.ownerModuleKey,
      eventVersion: m.eventVersion,
      valueType: m.valueType,
      aggregation: m.aggregation,
      correction: m.correction,
      classification: m.classification,
      billable: m.classification === "billable",
      privacyClassification: m.privacyClassification,
      minValue: m.bounds.minValue,
      maxValue: m.bounds.maxValue
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const quotas = [...registry.quotas.values()]
    .map((q) => ({
      key: q.key,
      ownerModule: q.ownerModuleKey,
      meterKey: q.meterKey,
      unit: q.unit,
      resetPeriod: q.resetPeriod,
      enforcement: q.enforcement
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const commercialEvents = [...registry.commercialEvents.values()]
    .map((e) => ({
      eventType: e.eventType,
      ownerModule: e.ownerModuleKey,
      eventVersion: e.eventVersion,
      kind: e.kind
    }))
    .sort((a, b) => a.eventType.localeCompare(b.eventType));

  return {
    saasContractVersion: SAAS_CONTRACT_VERSION,
    features,
    meters,
    quotas,
    commercialEvents
  };
}

/** Deterministic JSON text (2-space indent, trailing newline) for a plain string-equality freshness diff. */
export function buildSaasContractInventoryJson(
  modules = listModules()
): string {
  return `${JSON.stringify(buildSaasContractInventory(modules), null, 2)}\n`;
}

function mdEscape(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function buildRawMarkdown(inventory: SaasContractInventory): string {
  const lines: string[] = [];
  lines.push("# AWCMS-Mini SaaS Contract Registry (generated)");
  lines.push("");
  lines.push(
    "Do not edit by hand. Regenerate with `bun run saas-contracts:inventory:generate` " +
      "(`scripts/saas-contract-inventory-generate.ts`, Issue #874). The read-only twin " +
      "`bun run saas-contracts:registry:check` fails `bun run check` if this file is stale " +
      "or if any descriptor is invalid."
  );
  lines.push("");
  lines.push(`SaaS contract version: \`${inventory.saasContractVersion}\``);
  lines.push("");

  lines.push(`## Features (${inventory.features.length})`);
  lines.push("");
  lines.push("| Key | Owner module | Description |");
  lines.push("| --- | --- | --- |");
  for (const f of inventory.features) {
    lines.push(
      `| \`${mdEscape(f.key)}\` | \`${mdEscape(f.ownerModule)}\` | ${mdEscape(f.description)} |`
    );
  }
  lines.push("");

  lines.push(`## Meters (${inventory.meters.length})`);
  lines.push("");
  lines.push(
    "| Key | Owner module | Event version | Value type | Aggregation | Correction | Billable | Privacy class | Min | Max |"
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const m of inventory.meters) {
    lines.push(
      `| \`${mdEscape(m.key)}\` | \`${mdEscape(m.ownerModule)}\` | ${m.eventVersion} | ${m.valueType} | ${m.aggregation} | ${m.correction} | ${m.billable ? "yes" : "no"} | ${m.privacyClassification} | ${m.minValue} | ${m.maxValue} |`
    );
  }
  lines.push("");

  lines.push(`## Quotas (${inventory.quotas.length})`);
  lines.push("");
  lines.push(
    "| Key | Owner module | Meter | Unit | Reset period | Enforcement |"
  );
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const q of inventory.quotas) {
    lines.push(
      `| \`${mdEscape(q.key)}\` | \`${mdEscape(q.ownerModule)}\` | \`${mdEscape(q.meterKey)}\` | ${mdEscape(q.unit)} | ${q.resetPeriod} | ${q.enforcement} |`
    );
  }
  lines.push("");

  lines.push(`## Commercial events (${inventory.commercialEvents.length})`);
  lines.push("");
  lines.push("| Event type | Owner module | Event version | Kind |");
  lines.push("| --- | --- | --- | --- |");
  for (const e of inventory.commercialEvents) {
    lines.push(
      `| \`${mdEscape(e.eventType)}\` | \`${mdEscape(e.ownerModule)}\` | ${e.eventVersion} | ${e.kind} |`
    );
  }
  lines.push("");

  return lines.join("\n");
}

/** Prettier-formatted Markdown so the committed artifact already satisfies `bun run lint`. */
export async function buildSaasContractInventoryMarkdown(
  modules = listModules(),
  rootDir = process.cwd()
): Promise<string> {
  const raw = buildRawMarkdown(buildSaasContractInventory(modules));
  const filepath = path.join(rootDir, SAAS_CONTRACT_INVENTORY_MD_PATH);
  const config = (await prettier.resolveConfig(filepath)) ?? {};
  return prettier.format(raw, { ...config, filepath, parser: "markdown" });
}

async function main(): Promise<void> {
  const modules = listModules();
  const json = buildSaasContractInventoryJson(modules);
  const md = await buildSaasContractInventoryMarkdown(modules);

  await writeFile(SAAS_CONTRACT_INVENTORY_JSON_PATH, json, "utf8");
  await writeFile(SAAS_CONTRACT_INVENTORY_MD_PATH, md, "utf8");

  const parsed = JSON.parse(json) as SaasContractInventory;
  console.log(
    `saas-contracts:inventory:generate OK — wrote ${SAAS_CONTRACT_INVENTORY_JSON_PATH} + ` +
      `${SAAS_CONTRACT_INVENTORY_MD_PATH} (${parsed.features.length} feature(s), ` +
      `${parsed.meters.length} meter(s), ${parsed.quotas.length} quota(s), ` +
      `${parsed.commercialEvents.length} commercial event(s)).`
  );
}

if (import.meta.main) {
  await main();
}
