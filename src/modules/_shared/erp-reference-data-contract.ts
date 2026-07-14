/**
 * Item/service, currency, unit-of-measure, inventory-movement, and
 * reconciliation reference contracts (Issue #755, epic #738
 * `platform-evolution` Wave 4, ADR-0020 — ERP extension readiness
 * contracts). Pure DATA shapes, zero imports from any module — same
 * "-contract.ts in `_shared/` root" convention `business-transaction-
 * contract.ts` documents in its own header.
 *
 * These are REFERENCE shapes only, not a reference-data STORE. An ERP
 * extension backs `ItemReference`/`CurrencyReference`/
 * `UnitOfMeasureReference` with whatever source it chooses — its own
 * tables, or (once merged and stable) Issue #750's `reference_data`
 * module's effective-dated value sets/module-contributed catalogs. This
 * file deliberately does NOT import anything from `reference_data` (which
 * was still an open, unmerged PR with unresolved Critical findings at the
 * time this contract was written — see ADR-0020 §Status for the pinned
 * caveat) — any code, current or future, that satisfies this shape is a
 * valid implementation, keeping this contract independently useful
 * whether or not a given deployment ever enables `reference_data`.
 */

import type { BusinessScopeReference } from "./ports/business-scope-hierarchy-port";

/**
 * ISO 4217 alphabetic code (e.g. `"IDR"`, `"USD"`) — the base never
 * validates this against a real currency table, only passes it through as
 * an opaque string.
 */
export type CurrencyReference = {
  currencyCode: string;
  /** Decimal places this currency's amounts are conventionally expressed with (e.g. 2 for `"USD"`, 0 for `"IDR"` in whole-rupiah contexts) — informational only, the base never enforces it. */
  minorUnitDigits: number;
};

/**
 * A unit-of-measure reference (e.g. `"PCS"`, `"KG"`, `"HR"`) — opaque
 * code, no conversion-factor graph defined here (an ERP extension owns its
 * own UoM conversion logic entirely).
 */
export type UnitOfMeasureReference = {
  unitCode: string;
  description: string;
};

/**
 * A reference to an item or service an ERP extension's own catalog owns —
 * the base has no item/catalog table; this type only lets OTHER contracts
 * in this file (and `business-transaction-contract.ts`'s posting payloads,
 * if an extension chooses to embed one) point at "some item" without the
 * base ever storing catalog data itself.
 */
export type ItemReference = {
  /** Extension-owned identifier, opaque to the base. */
  itemId: string;
  /** `"good"` — a physical/stock-tracked item (inventory movements apply). `"service"` — never inventory-tracked. */
  itemKind: "good" | "service";
  defaultUnit: UnitOfMeasureReference;
};

/**
 * `"receipt"` — stock increasing (e.g. purchase receipt, production
 * output). `"issue"` — stock decreasing (e.g. sale, consumption).
 * `"transfer"` — moves between two locations within the same tenant,
 * network stock unchanged. `"adjustment"` — a correction to on-hand
 * quantity not explained by an ordinary receipt/issue/transfer (requires
 * its own extension-level authorization, out of scope for this contract).
 */
export type InventoryMovementDirection =
  "receipt" | "issue" | "transfer" | "adjustment";

/**
 * A reference to one inventory movement an ERP extension's own stock
 * ledger owns. Quantity is a decimal-as-string (same "opaque control
 * total, base never sums it" convention `AccountingPostingRequestPayload.
 * totalDebit`/`totalCredit` already use) — this base repository has no
 * inventory valuation/costing concept (ADR-0020 explicit exclusion) and
 * never interprets this value beyond passing it through for reference/
 * reconciliation display.
 */
export type InventoryMovementReference = {
  tenantId: string;
  /** Extension-owned identifier, opaque to the base. */
  movementId: string;
  direction: InventoryMovementDirection;
  item: ItemReference;
  quantity: string;
  /** The business transaction this movement is evidence for/linked to, when one exists (e.g. a sales invoice's fulfilment) — optional, since an extension may record standalone stock adjustments with no linked transaction. */
  businessTransactionReference?: string;
};

/**
 * A named control total an ERP extension publishes for reconciliation
 * (e.g. "total posted debit for period 2026-07" vs. an independently
 * computed source total) — deliberately generic: the base never computes
 * or validates these totals itself, it only defines the SHAPE a
 * reconciliation report (an ERP extension's own, or a base `reporting`
 * projection an extension contributes per Issue #753) compares against.
 */
export type ReconciliationControlTotal = {
  label: string;
  /** Decimal-as-string, same opaque-amount convention as this file's other monetary/quantity fields. */
  expectedValue: string;
  actualValue: string;
  /** `true` when `expectedValue === actualValue` (string-exact comparison is deliberate — an ERP extension is responsible for normalizing both sides to the SAME decimal representation before comparing; this contract does not perform numeric parsing). */
  matched: boolean;
};

/**
 * A reference to one reconciliation run an ERP extension performed —
 * pairs a `periodKey` (same opaque string `PeriodLockPort`/
 * `AccountingPostingRequestPayload` use) with a set of control totals.
 */
export type ReconciliationReference = {
  tenantId: string;
  legalEntityScope?: BusinessScopeReference | null;
  periodKey: string;
  reconciledAt: string;
  controlTotals: readonly ReconciliationControlTotal[];
  /** `true` only when every entry in `controlTotals` has `matched: true`. */
  fullyReconciled: boolean;
};
