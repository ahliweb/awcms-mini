/**
 * Neutral example seed contributions (Issue #750, epic #738
 * platform-evolution Wave 3, ADR-0021 §10) — currency, unit-of-measure,
 * and fiscal-calendar value sets `reference_data` contributes to ITSELF
 * via the SAME generic `ModuleDescriptor.referenceData.
 * contributesValueSets` mechanism any other module would use (dogfooding
 * the contract this module defines, same "foundation issue ships a
 * self-contained example" precedent `domain_event_runtime`'s
 * `sample.recorded` event set — Issue #742 — already establishes).
 *
 * **These are illustrative examples, NOT an authoritative or
 * comprehensive regulatory source** (issue #750 explicit requirement:
 * "without claiming comprehensive regulatory authority"). `currency` is a
 * small subset of ISO 4217; `fiscal_calendar` illustrates two common
 * patterns, not every jurisdiction's actual fiscal year. A derived
 * application that needs authoritative/complete data should replace or
 * extend these via this module's own import pipeline
 * (`application/import-service.ts`) or its own module contribution —
 * never treat these seed rows as a compliance source.
 */
import type { ReferenceValueSetContribution } from "../../_shared/module-contract";

export const CURRENCY_CONTRIBUTION: ReferenceValueSetContribution = {
  key: "currency",
  name: "Currency",
  description:
    "Illustrative subset of ISO 4217 currency codes — NOT a comprehensive or authoritative currency registry. Derived applications needing full ISO 4217 coverage should import their own dataset via this module's import pipeline.",
  overridePolicy: "tenant_extend",
  codes: [
    {
      code: "IDR",
      sortOrder: 0,
      labels: [
        { locale: "en", label: "Indonesian Rupiah" },
        { locale: "id", label: "Rupiah Indonesia" }
      ],
      metadata: { minorUnit: 2, symbol: "Rp" }
    },
    {
      code: "USD",
      sortOrder: 1,
      labels: [
        { locale: "en", label: "United States Dollar" },
        { locale: "id", label: "Dolar Amerika Serikat" }
      ],
      metadata: { minorUnit: 2, symbol: "$" }
    },
    {
      code: "EUR",
      sortOrder: 2,
      labels: [
        { locale: "en", label: "Euro" },
        { locale: "id", label: "Euro" }
      ],
      metadata: { minorUnit: 2, symbol: "€" }
    },
    {
      code: "SGD",
      sortOrder: 3,
      labels: [
        { locale: "en", label: "Singapore Dollar" },
        { locale: "id", label: "Dolar Singapura" }
      ],
      metadata: { minorUnit: 2, symbol: "S$" }
    },
    {
      code: "JPY",
      sortOrder: 4,
      labels: [
        { locale: "en", label: "Japanese Yen" },
        { locale: "id", label: "Yen Jepang" }
      ],
      metadata: { minorUnit: 0, symbol: "¥" }
    }
  ]
};

export const UNIT_OF_MEASURE_CONTRIBUTION: ReferenceValueSetContribution = {
  key: "unit_of_measure",
  name: "Unit of Measure",
  description:
    "Illustrative common units of measure — NOT a comprehensive UN/CEFACT or GS1 unit-of-measure registry. Derived applications needing full coverage should import their own dataset.",
  overridePolicy: "tenant_extend_and_override",
  codes: [
    {
      code: "pcs",
      sortOrder: 0,
      labels: [
        { locale: "en", label: "Piece" },
        { locale: "id", label: "Buah" }
      ]
    },
    {
      code: "kg",
      sortOrder: 1,
      labels: [
        { locale: "en", label: "Kilogram" },
        { locale: "id", label: "Kilogram" }
      ]
    },
    {
      code: "g",
      sortOrder: 2,
      labels: [
        { locale: "en", label: "Gram" },
        { locale: "id", label: "Gram" }
      ]
    },
    {
      code: "l",
      sortOrder: 3,
      labels: [
        { locale: "en", label: "Liter" },
        { locale: "id", label: "Liter" }
      ]
    },
    {
      code: "m",
      sortOrder: 4,
      labels: [
        { locale: "en", label: "Meter" },
        { locale: "id", label: "Meter" }
      ]
    },
    {
      code: "box",
      sortOrder: 5,
      labels: [
        { locale: "en", label: "Box" },
        { locale: "id", label: "Kotak" }
      ]
    }
  ]
};

export const FISCAL_CALENDAR_CONTRIBUTION: ReferenceValueSetContribution = {
  key: "fiscal_calendar",
  name: "Fiscal Calendar",
  description:
    "Illustrative fiscal-year patterns (calendar-year and April-March) — NOT authoritative for any specific jurisdiction's actual fiscal/tax year. Derived applications should confirm the correct fiscal calendar for their own jurisdiction.",
  overridePolicy: "tenant_override",
  codes: [
    {
      code: "calendar_year",
      sortOrder: 0,
      labels: [
        { locale: "en", label: "Calendar Year (January-December)" },
        { locale: "id", label: "Tahun Kalender (Januari-Desember)" }
      ],
      metadata: { startMonth: 1, endMonth: 12 }
    },
    {
      code: "fiscal_year_apr_mar",
      sortOrder: 1,
      labels: [
        { locale: "en", label: "Fiscal Year (April-March)" },
        { locale: "id", label: "Tahun Fiskal (April-Maret)" }
      ],
      metadata: { startMonth: 4, endMonth: 3 }
    }
  ]
};

export const REFERENCE_DATA_SEED_CONTRIBUTIONS: ReferenceValueSetContribution[] =
  [
    CURRENCY_CONTRIBUTION,
    UNIT_OF_MEASURE_CONTRIBUTION,
    FISCAL_CALENDAR_CONTRIBUTION
  ];
