import type {
  PartyDirectoryPort,
  PartyDirectoryPublicSafeDTO,
  PartyDirectorySummaryDTO
} from "../../_shared/ports/party-directory-port";
import { fetchPartyById } from "./party-directory";
import { toPartyPublicSafeDTO } from "../domain/projection";

async function exists(
  tx: Bun.SQL,
  tenantId: string,
  profileId: string
): Promise<boolean> {
  const record = await fetchPartyById(tx, tenantId, profileId);
  return record !== null;
}

async function resolveSummary(
  tx: Bun.SQL,
  tenantId: string,
  profileId: string
): Promise<PartyDirectorySummaryDTO | null> {
  const record = await fetchPartyById(tx, tenantId, profileId);

  if (!record) {
    return null;
  }

  return {
    id: record.id,
    profileType: record.profileType,
    displayName: record.displayName,
    status: record.status
  };
}

const MAX_MERGE_CHAIN_HOPS = 20;

async function resolveMergeSurvivor(
  tx: Bun.SQL,
  tenantId: string,
  profileId: string
): Promise<string | null> {
  let currentId = profileId;

  for (let hop = 0; hop < MAX_MERGE_CHAIN_HOPS; hop += 1) {
    const record = await fetchPartyById(tx, tenantId, currentId, {
      includeDeleted: true
    });

    if (!record) {
      return null;
    }

    if (!record.mergedIntoProfileId) {
      return currentId;
    }

    currentId = record.mergedIntoProfileId;
  }

  // Defensive bound only — `awcms_mini_profiles_merged_into_idx` plus the
  // application-layer invariant that a merge survivor is never itself
  // soft-deleted-as-a-loser at creation time makes a chain this long
  // unreachable in practice; returning the last-known id here rather than
  // throwing keeps this a read-only, side-effect-free port method.
  return currentId;
}

async function resolvePublicSafeSummary(
  tx: Bun.SQL,
  tenantId: string,
  profileId: string
): Promise<PartyDirectoryPublicSafeDTO | null> {
  const record = await fetchPartyById(tx, tenantId, profileId);

  if (!record) {
    return null;
  }

  return toPartyPublicSafeDTO(record);
}

export const partyDirectoryPortAdapter: PartyDirectoryPort = {
  exists,
  resolveSummary,
  resolveMergeSurvivor,
  resolvePublicSafeSummary
};
