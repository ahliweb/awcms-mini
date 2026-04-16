import { getDatabase, withTransaction } from "../index.mjs";
import { createAdministrativeRegionRepository } from "../repositories/administrative-regions.mjs";

function normalizeNullableString(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const nextValue = String(value).trim();
  return nextValue.length > 0 ? nextValue : null;
}

function deriveAdministrativeRegionId(code) {
  return `administrative_region_${String(code)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")}`;
}

function normalizeAdministrativeRegionSeedRecord(record) {
  return {
    id: normalizeNullableString(record.id),
    code: String(record.code ?? "").trim(),
    name: String(record.name ?? "").trim(),
    type: String(record.type ?? "").trim(),
    parent_code: normalizeNullableString(record.parent_code),
    province_code: normalizeNullableString(record.province_code),
    regency_code: normalizeNullableString(record.regency_code),
    district_code: normalizeNullableString(record.district_code),
    village_code: normalizeNullableString(record.village_code),
    is_active: record.is_active !== false,
  };
}

function validateAdministrativeRegionSeedRecord(record) {
  if (!record.code) {
    throw new TypeError("Administrative region seed record requires a code.");
  }

  if (!record.name) {
    throw new TypeError(`Administrative region seed record '${record.code}' requires a name.`);
  }

  if (!record.type) {
    throw new TypeError(`Administrative region seed record '${record.code}' requires a type.`);
  }
}

function normalizeAdministrativeRegionSeedRecords(records) {
  const normalized = records.map((record) => {
    const nextRecord = normalizeAdministrativeRegionSeedRecord(record);
    validateAdministrativeRegionSeedRecord(nextRecord);
    return nextRecord;
  });

  const seenCodes = new Set();

  for (const record of normalized) {
    if (seenCodes.has(record.code)) {
      throw new TypeError(`Duplicate administrative region code in seed data: ${record.code}`);
    }

    seenCodes.add(record.code);
  }

  return normalized;
}

function resolveAdministrativeRegionImportOrder(records) {
  const ordered = [];
  const pending = new Map(records.map((record) => [record.code, record]));

  while (pending.size > 0) {
    let progressed = false;

    for (const [code, record] of pending.entries()) {
      if (!record.parent_code || !pending.has(record.parent_code)) {
        ordered.push(record);
        pending.delete(code);
        progressed = true;
      }
    }

    if (!progressed) {
      throw new TypeError(
        `Unable to resolve administrative region parent chain for: ${[...pending.keys()].sort((left, right) => left.localeCompare(right)).join(", ")}`,
      );
    }
  }

  return ordered;
}

export async function importAdministrativeRegions(options = {}) {
  const database = options.database ?? getDatabase();
  const repositoryFactory = options.repositoryFactory ?? createAdministrativeRegionRepository;
  const normalizedRecords = resolveAdministrativeRegionImportOrder(normalizeAdministrativeRegionSeedRecords(options.records ?? []));

  return withTransaction(database, async (trx) => {
    const repository = repositoryFactory(trx);
    const imported = [];
    let created = 0;
    let updated = 0;

    for (const record of normalizedRecords) {
      const parent = record.parent_code ? await repository.getAdministrativeRegionByCode(record.parent_code) : null;

      if (record.parent_code && !parent) {
        throw new TypeError(`Administrative region parent not found during import: ${record.parent_code}`);
      }

      const existing = await repository.getAdministrativeRegionByCode(record.code);
      const nextId = existing?.id ?? record.id ?? deriveAdministrativeRegionId(record.code);
      const nextPath = parent ? `${parent.path}/${nextId}` : nextId;
      const values = {
        code: record.code,
        name: record.name,
        type: record.type,
        parent_id: parent?.id ?? null,
        path: nextPath,
        province_code: record.province_code,
        regency_code: record.regency_code,
        district_code: record.district_code,
        village_code: record.village_code,
        is_active: record.is_active,
      };

      const importedRecord = existing
        ? await repository.updateAdministrativeRegion(existing.id, values)
        : await repository.createAdministrativeRegion({ id: nextId, ...values });

      if (existing) {
        updated += 1;
      } else {
        created += 1;
      }

      imported.push(importedRecord);
    }

    return {
      created,
      updated,
      total: imported.length,
      items: imported,
    };
  });
}

export {
  deriveAdministrativeRegionId,
  normalizeAdministrativeRegionSeedRecord,
  normalizeAdministrativeRegionSeedRecords,
  resolveAdministrativeRegionImportOrder,
};
