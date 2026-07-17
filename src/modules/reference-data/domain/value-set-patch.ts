/**
 * Partial-`PATCH` parse + merge for a reference value set's neutral metadata
 * (Issue #837 — the reference-data endpoint #822 missed). The route rebuilt its
 * update input with `description: typeof body.description === "string" ? ... :
 * null`, so a `PATCH { name }` that omitted `description` silently CLEARED the
 * stored description (`name` -> `""` is caught 400 by the validator, but the
 * description loss was senyap).
 *
 * Normative `PATCH` semantics instead: **absent = keep**, **`null` = clear**,
 * any string = replace. `name` is `NOT NULL` / required, so an explicit `null`
 * is rejected (400) rather than defaulted. VALUE-level validation stays in
 * `validateUpdateReferenceValueSetInput`, run once on the merged result.
 */
import type { PatchFieldError } from "../../_shared/partial-patch";
import {
  readNullableStringPatch,
  readRequiredStringPatch
} from "../../_shared/partial-patch";
import type { UpdateReferenceValueSetInput } from "./value-set";

export type ReferenceValueSetPatch = {
  name?: string;
  description?: string | null;
};

export type ParseReferenceValueSetPatchResult =
  | { ok: true; patch: ReferenceValueSetPatch }
  | { ok: false; errors: PatchFieldError[] };

export function parseReferenceValueSetPatch(
  body: Record<string, unknown>
): ParseReferenceValueSetPatchResult {
  const errors: PatchFieldError[] = [];
  const patch: ReferenceValueSetPatch = {};

  const name = readRequiredStringPatch(body, "name", errors);
  if (name !== undefined) patch.name = name;

  const description = readNullableStringPatch(body, "description", errors);
  if (description !== undefined) patch.description = description;

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, patch };
}

export function mergeReferenceValueSetPatch(
  existing: UpdateReferenceValueSetInput,
  patch: ReferenceValueSetPatch
): UpdateReferenceValueSetInput {
  return {
    name: patch.name === undefined ? existing.name : patch.name,
    description:
      patch.description === undefined ? existing.description : patch.description
  };
}
