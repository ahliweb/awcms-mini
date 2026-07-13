/**
 * `PartyDirectoryPort` (Issue #748, epic #738 platform-evolution Wave 2) —
 * the capability `profile_identity` provides so a future domain module can
 * reference a canonical party (person/organization) WITHOUT importing
 * `profile_identity`'s tables or `application`/`domain` code directly. Lives
 * in neutral ground (`_shared`, imports NOTHING from any module), same
 * reasoning `public-content-port.ts`/`news-media-port.ts`/
 * `legal-hold-guard-port.ts` document in their own headers (ADR-0011).
 *
 * Two complementary capabilities:
 * - `resolveSummary`/`exists` — an ordinary PULL query, for a consumer that
 *   needs to check/display something right now.
 * - `resolveMergeSurvivor` — resolves through a merge chain: if `profileId`
 *   was itself merged away, returns the id it currently survives as (walks
 *   `merged_into_profile_id` to its end, so a consumer never has to
 *   special-case "this id used to be valid, now it's been merged"). A
 *   consumer that wants to react at the MOMENT a merge happens (rather than
 *   pull-resolving on next read) should instead subscribe to the
 *   `awcms-mini.profile-identity.profile.merged` domain event
 *   (`domain-event-runtime`, Issue #742) — this port is the pull-based
 *   complement, not a replacement for that push-based path.
 *
 * `resolvePublicSafeSummary` returns the explicit `PartyPublicSafeDTO`
 * allow-list (`profile-identity/domain/projection.ts`) — `null` for a
 * soft-deleted/merged-away/inactive profile, matching that projector's own
 * contract.
 *
 * The concrete implementation
 * (`profile-identity/application/party-directory-port-adapter.ts`) is a
 * thin wrapper around `party-directory.ts`'s `fetchPartyById`. Only the
 * TRUE composition roots — a consumer module's own route handler or
 * application code that needs this capability — import both the concrete
 * adapter and pass it in as a parameter, matching every other port in this
 * repo (no DI framework, ADR-0011).
 */
export type PartyDirectorySummaryDTO = {
  id: string;
  profileType: string;
  displayName: string;
  status: string;
};

export type PartyDirectoryPublicSafeDTO = {
  id: string;
  profileType: string;
  displayName: string;
};

export type PartyDirectoryPort = {
  /** `true` only if `profileId` exists for `tenantId` and is not soft-deleted — existence/ownership check, not a visibility/permission check. */
  exists(tx: Bun.SQL, tenantId: string, profileId: string): Promise<boolean>;

  /** `null` if the profile doesn't exist for `tenantId` or is soft-deleted (including merged-away). */
  resolveSummary(
    tx: Bun.SQL,
    tenantId: string,
    profileId: string
  ): Promise<PartyDirectorySummaryDTO | null>;

  /**
   * Walks `merged_into_profile_id` to its end and returns the CURRENT
   * survivor id — returns `profileId` itself unchanged if it was never
   * merged. `null` if `profileId` doesn't exist for `tenantId` at all (not
   * even as a merged-away loser).
   */
  resolveMergeSurvivor(
    tx: Bun.SQL,
    tenantId: string,
    profileId: string
  ): Promise<string | null>;

  /** The explicit public-safe allow-list projection — `null` if not eligible (soft-deleted, merged-away, or not `active`). */
  resolvePublicSafeSummary(
    tx: Bun.SQL,
    tenantId: string,
    profileId: string
  ): Promise<PartyDirectoryPublicSafeDTO | null>;
};
