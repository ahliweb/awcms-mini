import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

const API_BASE = "/_emdash/api/plugins/awcms-users-admin";

interface UserListItem {
  id: string;
  email: string;
  username: string | null;
  displayName: string | null;
  status: string;
  lastLoginAt: string | null;
  mustResetPassword: boolean;
  isProtected: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  profile: {
    phone: string | null;
    timezone: string | null;
    locale: string | null;
    notes: string | null;
    avatarMediaId: string | null;
    createdAt: string | null;
    updatedAt: string | null;
  };
  activeSessionCount: number;
}

interface LifecycleResult {
  item: UserListItem;
}

interface RoleListItem {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  staffLevel: number;
  isSystem: boolean;
  isAssignable: boolean;
  isProtected: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  activeAssignmentCount: number;
}

interface JobLevelListItem {
  id: string;
  code: string;
  name: string;
  rankOrder: number;
  description: string | null;
  isSystem: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  activeTitleCount: number;
}

interface JobTitleListItem {
  id: string;
  jobLevelId: string;
  levelCode: string | null;
  levelName: string | null;
  levelRankOrder: number;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RegionListItem {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  level: number;
  path: string;
  sortOrder: number;
  isActive: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AdministrativeRegionListItem {
  id: string;
  code: string;
  name: string;
  type: string;
  parentId: string | null;
  path: string;
  provinceCode: string | null;
  regencyCode: string | null;
  districtCode: string | null;
  villageCode: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface UserAdministrativeRegionAssignmentItem {
  id: string;
  userId: string;
  administrativeRegionId: string;
  administrativeRegionCode: string | null;
  administrativeRegionName: string | null;
  administrativeRegionType: string | null;
  administrativeRegionPath: string | null;
  assignmentType: string;
  startsAt: string;
  endsAt: string | null;
  isPrimary: boolean;
  assignedByUserId: string | null;
  createdAt: string;
}

interface UserAdministrativeRegionsSnapshot {
  assignments: UserAdministrativeRegionAssignmentItem[];
  regions: AdministrativeRegionListItem[];
}

interface UserTwoFactorStatus {
  userId: string;
  enrolled: boolean;
  pending: boolean;
  verifiedAt: string | null;
  lastUsedAt: string | null;
  recoveryCodeCount: number;
}

interface SecurityPolicySnapshot {
  policy: {
    mandatoryTwoFactorRoleIds: string[];
  };
  roles: PermissionMatrixRole[];
}

interface AdministrativeRegionSnapshot {
  items: AdministrativeRegionListItem[];
  importStatus: {
    source: string;
    command: string;
    latestUpdatedAt: string | null;
    total: number;
  };
}

interface UserJobAssignmentItem {
  id: string;
  userId: string;
  jobLevelId: string;
  jobLevelCode: string | null;
  jobLevelName: string | null;
  jobLevelRankOrder: number;
  jobTitleId: string | null;
  jobTitleCode: string | null;
  jobTitleName: string | null;
  supervisorUserId: string | null;
  supervisorDisplayName: string | null;
  employmentStatus: string;
  startsAt: string;
  endsAt: string | null;
  isPrimary: boolean;
  assignedByUserId: string | null;
  notes: string | null;
  createdAt: string;
}

interface SupervisorCandidate {
  id: string;
  displayName: string;
  email: string;
}

interface UserJobsSnapshot {
  assignments: UserJobAssignmentItem[];
  jobLevels: JobLevelListItem[];
  jobTitles: JobTitleListItem[];
  supervisorCandidates: SupervisorCandidate[];
}

interface UserRegionAssignmentItem {
  id: string;
  userId: string;
  regionId: string;
  regionCode: string | null;
  regionName: string | null;
  regionLevel: number;
  regionPath: string | null;
  assignmentType: string;
  startsAt: string;
  endsAt: string | null;
  isPrimary: boolean;
  assignedByUserId: string | null;
  createdAt: string;
}

interface UserRegionsSnapshot {
  assignments: UserRegionAssignmentItem[];
  regions: RegionListItem[];
}

interface PermissionMatrixRole {
  id: string;
  slug: string;
  name: string;
  staffLevel: number;
  isAssignable: boolean;
  isProtected: boolean;
}

interface PermissionMatrixRow {
  id: string;
  code: string;
  domain: string;
  resource: string;
  action: string;
  description: string | null;
  isProtected: boolean;
  grantsByRoleId: Record<string, boolean>;
}

interface PermissionMatrixSnapshot {
  roles: PermissionMatrixRole[];
  rows: PermissionMatrixRow[];
}

function formatDateTime(value: string | null) {
  if (!value) {
    return "Never";
  }

  return new Date(value).toLocaleString();
}

function statusTone(status: string) {
  if (status === "active") return "#166534";
  if (status === "invited") return "#92400e";
  if (status === "locked" || status === "disabled") return "#991b1b";
  if (status === "deleted") return "#52525b";
  return "#334155";
}

function roleTone(item: RoleListItem) {
  if (item.isProtected) return { background: "#fee2e2", color: "#991b1b", border: "1px solid #fecaca" };
  if (!item.isAssignable) return { background: "#ede9fe", color: "#5b21b6", border: "1px solid #ddd6fe" };
  return { background: "#ecfeff", color: "#155e75", border: "1px solid #a5f3fc" };
}

function jobLevelTone(item: JobLevelListItem) {
  if (item.rankOrder >= 8) return { background: "#ede9fe", color: "#5b21b6", border: "1px solid #ddd6fe" };
  if (item.rankOrder >= 5) return { background: "#ecfeff", color: "#155e75", border: "1px solid #a5f3fc" };
  return { background: "#f5f5f4", color: "#57534e", border: "1px solid #e7e5e4" };
}

function permissionTone(row: PermissionMatrixRow) {
  if (row.isProtected) {
    return { background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca" };
  }

  return { background: "#f8fafc", color: "#475569", border: "1px solid #e2e8f0" };
}

function buildDraftByRoleId(snapshot: PermissionMatrixSnapshot) {
  return Object.fromEntries(
    snapshot.roles.map((role) => [
      role.id,
      snapshot.rows.filter((row) => row.grantsByRoleId[role.id]).map((row) => row.id),
    ]),
  );
}

function countPendingMatrixChanges(snapshot: PermissionMatrixSnapshot, draftByRoleId: Record<string, string[]>) {
  return snapshot.rows.reduce(
    (count, row) =>
      count +
      snapshot.roles.reduce((roleCount, role) => {
        const current = row.grantsByRoleId[role.id] === true;
        const next = (draftByRoleId[role.id] ?? []).includes(row.id);
        return roleCount + (current === next ? 0 : 1);
      }, 0),
    0,
  );
}

function hasProtectedMatrixChanges(snapshot: PermissionMatrixSnapshot, draftByRoleId: Record<string, string[]>) {
  return snapshot.rows.some((row) => {
    if (!row.isProtected) {
      return false;
    }

    return snapshot.roles.some((role) => {
      const current = row.grantsByRoleId[role.id] === true;
      const next = (draftByRoleId[role.id] ?? []).includes(row.id);
      return current !== next;
    });
  });
}

function useUserList() {
  const [items, setItems] = React.useState<UserListItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const response = await apiFetch(`${API_BASE}/users/list`);
      const data = await parseApiResponse<{ items: UserListItem[] }>(response, "Failed to load users");
      setItems(data.items);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to load users");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await apiFetch(`${API_BASE}/users/list`);
        const data = await parseApiResponse<{ items: UserListItem[] }>(response, "Failed to load users");
        if (!cancelled) {
          setItems(data.items);
          setError(null);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Failed to load users");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  return { items, loading, error, reload: load };
}

function useRoleList() {
  const [items, setItems] = React.useState<RoleListItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await apiFetch(`${API_BASE}/roles/list`);
        const data = await parseApiResponse<{ items: RoleListItem[] }>(response, "Failed to load roles");
        if (!cancelled) {
          setItems(data.items);
          setError(null);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Failed to load roles");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  return { items, loading, error };
}

function useJobLevelList() {
  const [items, setItems] = React.useState<JobLevelListItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await apiFetch(`${API_BASE}/jobs/levels/list`);
        const data = await parseApiResponse<{ items: JobLevelListItem[] }>(response, "Failed to load job levels");
        if (!cancelled) {
          setItems(data.items);
          setError(null);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Failed to load job levels");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  return { items, loading, error };
}

function useJobTitleList() {
  const [items, setItems] = React.useState<JobTitleListItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await apiFetch(`${API_BASE}/jobs/titles/list`);
        const data = await parseApiResponse<{ items: JobTitleListItem[] }>(response, "Failed to load job titles");
        if (!cancelled) {
          setItems(data.items);
          setError(null);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Failed to load job titles");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  return { items, loading, error };
}

function usePermissionMatrix() {
  const [snapshot, setSnapshot] = React.useState<PermissionMatrixSnapshot | null>(null);
  const [draftByRoleId, setDraftByRoleId] = React.useState<Record<string, string[]>>({});
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [confirmProtectedChanges, setConfirmProtectedChanges] = React.useState(false);
  const [elevatedFlowConfirmed, setElevatedFlowConfirmed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await apiFetch(`${API_BASE}/permissions/matrix`);
        const data = await parseApiResponse<PermissionMatrixSnapshot>(response, "Failed to load permission matrix");
        if (!cancelled) {
          setSnapshot(data);
          setDraftByRoleId(buildDraftByRoleId(data));
          setError(null);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Failed to load permission matrix");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  const toggleGrant = React.useCallback((roleId: string, permissionId: string) => {
    setDraftByRoleId((current) => {
      const currentPermissionIds = current[roleId] ?? [];
      const nextPermissionIds = currentPermissionIds.includes(permissionId)
        ? currentPermissionIds.filter((value) => value !== permissionId)
        : [...currentPermissionIds, permissionId].sort((left, right) => left.localeCompare(right));

      return {
        ...current,
        [roleId]: nextPermissionIds,
      };
    });
  }, []);

  const resetDraft = React.useCallback(() => {
    if (!snapshot) {
      return;
    }

    setDraftByRoleId(buildDraftByRoleId(snapshot));
    setConfirmProtectedChanges(false);
    setElevatedFlowConfirmed(false);
  }, [snapshot]);

  const applyDraft = React.useCallback(async () => {
    if (!snapshot) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const response = await apiFetch(`${API_BASE}/permissions/matrix/apply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          rolePermissionIdsByRoleId: draftByRoleId,
          confirmProtectedChanges,
          elevatedFlowConfirmed,
        }),
      });
      const data = await parseApiResponse<{ snapshot: PermissionMatrixSnapshot }>(response, "Failed to apply permission matrix");
      setSnapshot(data.snapshot);
      setDraftByRoleId(buildDraftByRoleId(data.snapshot));
      setConfirmProtectedChanges(false);
      setElevatedFlowConfirmed(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to apply permission matrix");
    } finally {
      setSaving(false);
    }
  }, [confirmProtectedChanges, draftByRoleId, elevatedFlowConfirmed, snapshot]);

  const pendingChanges = snapshot ? countPendingMatrixChanges(snapshot, draftByRoleId) : 0;
  const protectedChanges = snapshot ? hasProtectedMatrixChanges(snapshot, draftByRoleId) : false;

  return {
    snapshot,
    draftByRoleId,
    loading,
    error,
    saving,
    pendingChanges,
    protectedChanges,
    confirmProtectedChanges,
    setConfirmProtectedChanges,
    elevatedFlowConfirmed,
    setElevatedFlowConfirmed,
    toggleGrant,
    resetDraft,
    applyDraft,
  };
}

function useLogicalRegions() {
  const [items, setItems] = React.useState<RegionListItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const response = await apiFetch(`${API_BASE}/regions/list`);
      const data = await parseApiResponse<{ items: RegionListItem[] }>(response, "Failed to load logical regions");
      setItems(data.items);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to load logical regions");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const createRegion = React.useCallback(async (input: { code: string; name: string; parentId: string; sortOrder: string }) => {
    setSubmitting("create");
    setError(null);

    try {
      const response = await apiFetch(`${API_BASE}/regions/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: input.code,
          name: input.name,
          parentId: input.parentId,
          sortOrder: input.sortOrder ? Number.parseInt(input.sortOrder, 10) : 0,
        }),
      });
      const data = await parseApiResponse<{ items: RegionListItem[] }>(response, "Failed to create logical region");
      setItems(data.items);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to create logical region");
    } finally {
      setSubmitting(null);
    }
  }, []);

  const updateRegion = React.useCallback(async (input: { regionId: string; code: string; name: string; sortOrder: string }) => {
    setSubmitting(`update:${input.regionId}`);
    setError(null);

    try {
      const response = await apiFetch(`${API_BASE}/regions/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          regionId: input.regionId,
          code: input.code,
          name: input.name,
          sortOrder: input.sortOrder ? Number.parseInt(input.sortOrder, 10) : 0,
          isActive: true,
        }),
      });
      const data = await parseApiResponse<{ items: RegionListItem[] }>(response, "Failed to update logical region");
      setItems(data.items);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to update logical region");
    } finally {
      setSubmitting(null);
    }
  }, []);

  const reparentRegion = React.useCallback(async (input: { regionId: string; parentId: string }) => {
    setSubmitting(`reparent:${input.regionId}`);
    setError(null);

    try {
      const response = await apiFetch(`${API_BASE}/regions/reparent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          regionId: input.regionId,
          parentId: input.parentId,
        }),
      });
      const data = await parseApiResponse<{ items: RegionListItem[] }>(response, "Failed to reparent logical region");
      setItems(data.items);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to reparent logical region");
    } finally {
      setSubmitting(null);
    }
  }, []);

  return { items, loading, error, submitting, createRegion, updateRegion, reparentRegion };
}

function useAdministrativeRegions() {
  const [snapshot, setSnapshot] = React.useState<AdministrativeRegionSnapshot | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await apiFetch(`${API_BASE}/administrative-regions/list`);
        const data = await parseApiResponse<AdministrativeRegionSnapshot>(response, "Failed to load administrative regions");
        if (!cancelled) {
          setSnapshot(data);
          setError(null);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Failed to load administrative regions");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  return { snapshot, loading, error };
}

interface InviteResult {
  invite: {
    userId: string;
    email: string;
    expiresAt: string;
    activationUrl: string;
  };
}

function InviteUserCard({ onCreated }: { onCreated: () => Promise<void> | void }) {
  const [email, setEmail] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<InviteResult["invite"] | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await apiFetch(`${API_BASE}/users/invite`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          displayName,
        }),
      });
      const data = await parseApiResponse<InviteResult>(response, "Failed to create invite");
      setResult(data.invite);
      setEmail("");
      setDisplayName("");
      await onCreated();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to create invite");
    } finally {
      setSubmitting(false);
    }
  }

  function handleEmailChange(event: React.ChangeEvent<HTMLInputElement>) {
    setEmail(event.target.value);
  }

  function handleDisplayNameChange(event: React.ChangeEvent<HTMLInputElement>) {
    setDisplayName(event.target.value);
  }

  return (
    <div
      style={{
        border: "1px solid #e4e4e7",
        borderRadius: 16,
        background: "#fff",
        padding: 16,
        marginBottom: 16,
      }}
    >
      <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>Invite user</h2>
      <p style={{ margin: "0 0 16px", color: "#52525b" }}>Create an invited account and copy its activation link.</p>
      <form onSubmit={handleSubmit} style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        <label style={{ display: "grid", gap: 6 }}>
          <span>Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={handleEmailChange}
            style={{ border: "1px solid #d4d4d8", borderRadius: 12, padding: "10px 12px" }}
          />
        </label>
        <label style={{ display: "grid", gap: 6 }}>
          <span>Display name</span>
          <input
            type="text"
            value={displayName}
            onChange={handleDisplayNameChange}
            style={{ border: "1px solid #d4d4d8", borderRadius: 12, padding: "10px 12px" }}
          />
        </label>
        <div style={{ display: "flex", alignItems: "end" }}>
          <button
            type="submit"
            disabled={submitting}
            style={{ border: 0, borderRadius: 999, padding: "10px 16px", background: "#111827", color: "#fff", fontWeight: 600 }}
          >
            {submitting ? "Creating..." : "Create invite"}
          </button>
        </div>
      </form>
      {error ? <div style={{ marginTop: 12, color: "#b91c1c" }}>{error}</div> : null}
      {result ? (
        <div style={{ marginTop: 16, padding: 12, borderRadius: 12, background: "#f8fafc", color: "#334155" }}>
          <div style={{ fontWeight: 600 }}>{result.email}</div>
          <div style={{ marginTop: 6, wordBreak: "break-all" }}>{result.activationUrl}</div>
          <div style={{ marginTop: 6, fontSize: 13, color: "#64748b" }}>
            Expires {formatDateTime(result.expiresAt)}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function useUserDetail() {
  const [item, setItem] = React.useState<UserListItem | null>(null);
  const [jobsSnapshot, setJobsSnapshot] = React.useState<UserJobsSnapshot | null>(null);
  const [regionsSnapshot, setRegionsSnapshot] = React.useState<UserRegionsSnapshot | null>(null);
  const [administrativeRegionsSnapshot, setAdministrativeRegionsSnapshot] = React.useState<UserAdministrativeRegionsSnapshot | null>(null);
  const [twoFactorStatus, setTwoFactorStatus] = React.useState<UserTwoFactorStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState<string | null>(null);

  const fetchUser = React.useCallback(async (userId: string) => {
    const response = await apiFetch(`${API_BASE}/users/detail?id=${encodeURIComponent(userId)}`);
    return parseApiResponse<{ item: UserListItem }>(response, "Failed to load user");
  }, []);

  const fetchJobs = React.useCallback(async (userId: string) => {
    const response = await apiFetch(`${API_BASE}/users/jobs?id=${encodeURIComponent(userId)}`);
    return parseApiResponse<UserJobsSnapshot>(response, "Failed to load jobs");
  }, []);

  const fetchRegions = React.useCallback(async (userId: string) => {
    const response = await apiFetch(`${API_BASE}/users/regions?id=${encodeURIComponent(userId)}`);
    return parseApiResponse<UserRegionsSnapshot>(response, "Failed to load logical regions");
  }, []);

  const fetchAdministrativeRegions = React.useCallback(async (userId: string) => {
    const response = await apiFetch(`${API_BASE}/users/administrative-regions?id=${encodeURIComponent(userId)}`);
    return parseApiResponse<UserAdministrativeRegionsSnapshot>(response, "Failed to load administrative regions");
  }, []);

  const fetchTwoFactorStatus = React.useCallback(async (userId: string) => {
    const response = await apiFetch(`${API_BASE}/users/2fa/status?id=${encodeURIComponent(userId)}`);
    return parseApiResponse<UserTwoFactorStatus>(response, "Failed to load 2FA status");
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");

    if (!id) {
      setError("Missing required user id");
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    async function load() {
      try {
        const data = await fetchUser(id);
        const jobs = await fetchJobs(id);
        const regions = await fetchRegions(id);
        const administrativeRegions = await fetchAdministrativeRegions(id);
        const twoFactor = await fetchTwoFactorStatus(id);
        if (!cancelled) {
          setItem(data.item);
          setJobsSnapshot(jobs);
          setRegionsSnapshot(regions);
          setAdministrativeRegionsSnapshot(administrativeRegions);
          setTwoFactorStatus(twoFactor);
          setError(null);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Failed to load user");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [fetchAdministrativeRegions, fetchJobs, fetchRegions, fetchTwoFactorStatus, fetchUser]);

  const runAction = React.useCallback(
    async (action: "disable" | "lock" | "revoke-sessions") => {
      const params = new URLSearchParams(window.location.search);
      const id = params.get("id");

      if (!id) {
        setError("Missing required user id");
        return;
      }

      setSubmitting(action);
      setError(null);

      try {
        const response = await apiFetch(`${API_BASE}/users/${action}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ userId: id }),
        });
        const data = await parseApiResponse<LifecycleResult>(response, `Failed to ${action} user`);
        setItem(data.item);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : `Failed to ${action} user`);
      } finally {
        setSubmitting(null);
      }
    },
    [],
  );

  const assignJob = React.useCallback(
    async (input: {
      userId: string;
      jobLevelId: string;
      jobTitleId: string;
      supervisorUserId: string;
      employmentStatus: string;
      startsAt: string;
      notes: string;
    }) => {
      setSubmitting("assign-job");
      setError(null);

      try {
        const response = await apiFetch(`${API_BASE}/users/jobs/assign`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            userId: input.userId,
            jobLevelId: input.jobLevelId,
            jobTitleId: input.jobTitleId,
            supervisorUserId: input.supervisorUserId,
            employmentStatus: input.employmentStatus,
            startsAt: input.startsAt,
            notes: input.notes,
            isPrimary: true,
          }),
        });
        const data = await parseApiResponse<UserJobsSnapshot>(response, "Failed to assign job");
        setJobsSnapshot(data);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to assign job");
      } finally {
        setSubmitting(null);
      }
    },
    [],
  );

  const assignRegion = React.useCallback(
    async (input: {
      userId: string;
      regionId: string;
      assignmentType: string;
      startsAt: string;
    }) => {
      setSubmitting("assign-region");
      setError(null);

      try {
        const response = await apiFetch(`${API_BASE}/users/regions/assign`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            userId: input.userId,
            regionId: input.regionId,
            assignmentType: input.assignmentType,
            startsAt: input.startsAt,
            isPrimary: true,
          }),
        });
        const data = await parseApiResponse<UserRegionsSnapshot>(response, "Failed to assign logical region");
        setRegionsSnapshot(data);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to assign logical region");
      } finally {
        setSubmitting(null);
      }
    },
    [],
  );

  const assignAdministrativeRegion = React.useCallback(
    async (input: {
      userId: string;
      administrativeRegionId: string;
      assignmentType: string;
      startsAt: string;
    }) => {
      setSubmitting("assign-administrative-region");
      setError(null);

      try {
        const response = await apiFetch(`${API_BASE}/users/administrative-regions/assign`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            userId: input.userId,
            administrativeRegionId: input.administrativeRegionId,
            assignmentType: input.assignmentType,
            startsAt: input.startsAt,
            isPrimary: true,
          }),
        });
        const data = await parseApiResponse<UserAdministrativeRegionsSnapshot>(response, "Failed to assign administrative region");
        setAdministrativeRegionsSnapshot(data);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to assign administrative region");
      } finally {
        setSubmitting(null);
      }
    },
    [],
  );

  const resetTwoFactor = React.useCallback(
    async (input: { userId: string; reason: string }) => {
      setSubmitting("reset-2fa");
      setError(null);

      try {
        const response = await apiFetch(`${API_BASE}/users/2fa/reset`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-session-strength": "step_up",
            "x-step-up-authenticated": "true",
          },
          body: JSON.stringify({ userId: input.userId, reason: input.reason }),
        });
        const data = await parseApiResponse<UserTwoFactorStatus>(response, "Failed to reset 2FA");
        setTwoFactorStatus(data);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to reset 2FA");
      } finally {
        setSubmitting(null);
      }
    },
    [],
  );

  return {
    item,
    jobsSnapshot,
    regionsSnapshot,
    administrativeRegionsSnapshot,
    twoFactorStatus,
    loading,
    error,
    submitting,
    runAction,
    assignJob,
    assignRegion,
    assignAdministrativeRegion,
    resetTwoFactor,
  };
}

function useSecuritySettings() {
  const [snapshot, setSnapshot] = React.useState<SecurityPolicySnapshot | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await apiFetch(`${API_BASE}/security/settings`);
        const data = await parseApiResponse<SecurityPolicySnapshot>(response, "Failed to load security settings");
        if (!cancelled) {
          setSnapshot(data);
          setError(null);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Failed to load security settings");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  const updatePolicy = React.useCallback(async (mandatoryTwoFactorRoleIds: string[]) => {
    setSaving(true);
    setError(null);

    try {
      const response = await apiFetch(`${API_BASE}/security/settings/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mandatoryTwoFactorRoleIds }),
      });
      const data = await parseApiResponse<{ policy: SecurityPolicySnapshot["policy"] }>(response, "Failed to update security settings");
      setSnapshot((current) => (current ? { ...current, policy: data.policy } : current));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to update security settings");
    } finally {
      setSaving(false);
    }
  }, []);

  return { snapshot, loading, error, saving, updatePolicy };
}

function UserJobsPanel({ userId, snapshot, submitting, onAssign }: {
  userId: string;
  snapshot: UserJobsSnapshot | null;
  submitting: string | null;
  onAssign: (input: {
    userId: string;
    jobLevelId: string;
    jobTitleId: string;
    supervisorUserId: string;
    employmentStatus: string;
    startsAt: string;
    notes: string;
  }) => Promise<void>;
}) {
  const [jobLevelId, setJobLevelId] = React.useState("");
  const [jobTitleId, setJobTitleId] = React.useState("");
  const [supervisorUserId, setSupervisorUserId] = React.useState("");
  const [employmentStatus, setEmploymentStatus] = React.useState("active");
  const [startsAt, setStartsAt] = React.useState("");
  const [notes, setNotes] = React.useState("");

  const filteredTitles = React.useMemo(
    () => (snapshot?.jobTitles ?? []).filter((title) => !jobLevelId || title.jobLevelId === jobLevelId),
    [jobLevelId, snapshot?.jobTitles],
  );

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    await onAssign({
      userId,
      jobLevelId,
      jobTitleId,
      supervisorUserId,
      employmentStatus,
      startsAt,
      notes,
    });
  }

  return (
    <div style={{ display: "grid", gap: 16, marginTop: 24 }}>
      <div style={{ padding: 16, border: "1px solid #e4e4e7", borderRadius: 16, background: "#fff" }}>
        <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>Assign Job</h2>
        <form onSubmit={handleSubmit} style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          <label style={{ display: "grid", gap: 6 }}>
            <span>Job level</span>
            <select value={jobLevelId} onChange={(event) => { setJobLevelId(event.target.value); setJobTitleId(""); }} required style={{ border: "1px solid #d4d4d8", borderRadius: 12, padding: "10px 12px" }}>
              <option value="">Select level</option>
              {(snapshot?.jobLevels ?? []).map((level) => (
                <option key={level.id} value={level.id}>{level.name} (rank {level.rankOrder})</option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <span>Job title</span>
            <select value={jobTitleId} onChange={(event) => setJobTitleId(event.target.value)} style={{ border: "1px solid #d4d4d8", borderRadius: 12, padding: "10px 12px" }}>
              <option value="">No title</option>
              {filteredTitles.map((title) => (
                <option key={title.id} value={title.id}>{title.name}</option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <span>Supervisor</span>
            <select value={supervisorUserId} onChange={(event) => setSupervisorUserId(event.target.value)} style={{ border: "1px solid #d4d4d8", borderRadius: 12, padding: "10px 12px" }}>
              <option value="">No supervisor</option>
              {(snapshot?.supervisorCandidates ?? []).map((candidate) => (
                <option key={candidate.id} value={candidate.id}>{candidate.displayName}</option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <span>Status</span>
            <select value={employmentStatus} onChange={(event) => setEmploymentStatus(event.target.value)} style={{ border: "1px solid #d4d4d8", borderRadius: 12, padding: "10px 12px" }}>
              <option value="active">Active</option>
              <option value="probation">Probation</option>
              <option value="temporary">Temporary</option>
            </select>
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <span>Starts at</span>
            <input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} style={{ border: "1px solid #d4d4d8", borderRadius: 12, padding: "10px 12px" }} />
          </label>
          <label style={{ display: "grid", gap: 6, gridColumn: "1 / -1" }}>
            <span>Notes</span>
            <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} style={{ border: "1px solid #d4d4d8", borderRadius: 12, padding: "10px 12px" }} />
          </label>
          <div style={{ display: "flex", alignItems: "end" }}>
            <button type="submit" disabled={submitting !== null || !jobLevelId} style={{ border: 0, borderRadius: 999, padding: "10px 16px", background: "#111827", color: "#fff", fontWeight: 600 }}>
              {submitting === "assign-job" ? "Assigning..." : "Assign primary job"}
            </button>
          </div>
        </form>
      </div>
      <div style={{ padding: 16, border: "1px solid #e4e4e7", borderRadius: 16, background: "#fff" }}>
        <h2 style={{ margin: "0 0 12px", fontSize: 18 }}>Job Assignments</h2>
        {!(snapshot?.assignments?.length) ? <div style={{ color: "#71717a" }}>No job assignments yet.</div> : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 920 }}>
              <thead>
                <tr style={{ textAlign: "left", background: "#fafafa" }}>
                  <th style={{ padding: 12 }}>Job</th>
                  <th style={{ padding: 12 }}>Supervisor</th>
                  <th style={{ padding: 12 }}>Status</th>
                  <th style={{ padding: 12 }}>Effective Dates</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.assignments.map((assignment) => (
                  <tr key={assignment.id} style={{ borderTop: "1px solid #e4e4e7" }}>
                    <td style={{ padding: 12, verticalAlign: "top" }}>
                      <div style={{ fontWeight: 700 }}>{assignment.jobTitleName || assignment.jobLevelName || "Unspecified job"}</div>
                      <div style={{ color: "#52525b", marginTop: 6 }}>
                        {assignment.jobLevelName || "Unknown level"} ({assignment.jobLevelRankOrder})
                      </div>
                      <div style={{ color: "#71717a", marginTop: 6, fontSize: 13 }}>
                        {assignment.isPrimary ? "Primary assignment" : "Secondary/history entry"}
                      </div>
                    </td>
                    <td style={{ padding: 12, verticalAlign: "top", color: "#52525b" }}>
                      {assignment.supervisorDisplayName || "No supervisor"}
                    </td>
                    <td style={{ padding: 12, verticalAlign: "top" }}>
                      <div style={{ fontWeight: 700 }}>{assignment.employmentStatus}</div>
                      <div style={{ color: "#71717a", marginTop: 6, fontSize: 13 }}>{assignment.endsAt ? "Historical" : "Active"}</div>
                    </td>
                    <td style={{ padding: 12, verticalAlign: "top", color: "#52525b" }}>
                      <div>Starts {formatDateTime(assignment.startsAt)}</div>
                      <div style={{ marginTop: 6 }}>{assignment.endsAt ? `Ends ${formatDateTime(assignment.endsAt)}` : "No end date"}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function UserRegionsPanel({ userId, snapshot, submitting, onAssign }: {
  userId: string;
  snapshot: UserRegionsSnapshot | null;
  submitting: string | null;
  onAssign: (input: {
    userId: string;
    regionId: string;
    assignmentType: string;
    startsAt: string;
  }) => Promise<void>;
}) {
  const [regionId, setRegionId] = React.useState("");
  const [assignmentType, setAssignmentType] = React.useState("member");
  const [startsAt, setStartsAt] = React.useState("");

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    await onAssign({
      userId,
      regionId,
      assignmentType,
      startsAt,
    });
  }

  return (
    <div style={{ display: "grid", gap: 16, marginTop: 24 }}>
      <div style={{ padding: 16, border: "1px solid #e4e4e7", borderRadius: 16, background: "#fff" }}>
        <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>Assign Logical Region</h2>
        <form onSubmit={handleSubmit} style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          <label style={{ display: "grid", gap: 6 }}>
            <span>Logical region</span>
            <select value={regionId} onChange={(event) => setRegionId(event.target.value)} required style={{ border: "1px solid #d4d4d8", borderRadius: 12, padding: "10px 12px" }}>
              <option value="">Select region</option>
              {(snapshot?.regions ?? []).map((region) => (
                <option key={region.id} value={region.id}>{`${"  ".repeat(Math.max(region.level - 1, 0))}${region.name}`}</option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <span>Assignment type</span>
            <select value={assignmentType} onChange={(event) => setAssignmentType(event.target.value)} style={{ border: "1px solid #d4d4d8", borderRadius: 12, padding: "10px 12px" }}>
              <option value="member">Member</option>
              <option value="manager">Manager</option>
              <option value="observer">Observer</option>
            </select>
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <span>Starts at</span>
            <input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} style={{ border: "1px solid #d4d4d8", borderRadius: 12, padding: "10px 12px" }} />
          </label>
          <div style={{ display: "flex", alignItems: "end" }}>
            <button type="submit" disabled={submitting !== null || !regionId} style={{ border: 0, borderRadius: 999, padding: "10px 16px", background: "#111827", color: "#fff", fontWeight: 600 }}>
              {submitting === "assign-region" ? "Assigning..." : "Assign primary region"}
            </button>
          </div>
        </form>
      </div>
      <div style={{ padding: 16, border: "1px solid #e4e4e7", borderRadius: 16, background: "#fff" }}>
        <h2 style={{ margin: "0 0 12px", fontSize: 18 }}>Logical Region Assignments</h2>
        {!(snapshot?.assignments?.length) ? <div style={{ color: "#71717a" }}>No logical region assignments yet.</div> : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 920 }}>
              <thead>
                <tr style={{ textAlign: "left", background: "#fafafa" }}>
                  <th style={{ padding: 12 }}>Region</th>
                  <th style={{ padding: 12 }}>Type</th>
                  <th style={{ padding: 12 }}>Depth</th>
                  <th style={{ padding: 12 }}>Effective Dates</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.assignments.map((assignment) => (
                  <tr key={assignment.id} style={{ borderTop: "1px solid #e4e4e7" }}>
                    <td style={{ padding: 12, verticalAlign: "top" }}>
                      <div style={{ fontWeight: 700 }}>{assignment.regionName || "Unknown region"}</div>
                      <div style={{ color: "#52525b", marginTop: 6 }}>{assignment.regionCode ? `/${assignment.regionCode}` : "No region code"}</div>
                      <div style={{ color: "#71717a", marginTop: 6, fontSize: 13 }}>{assignment.isPrimary ? "Primary assignment" : "Secondary/history entry"}</div>
                    </td>
                    <td style={{ padding: 12, verticalAlign: "top" }}>
                      <div style={{ fontWeight: 700 }}>{assignment.assignmentType}</div>
                      <div style={{ color: "#71717a", marginTop: 6, fontSize: 13 }}>{assignment.endsAt ? "Historical" : "Active"}</div>
                    </td>
                    <td style={{ padding: 12, verticalAlign: "top", color: "#52525b" }}>
                      <div>Level {assignment.regionLevel}</div>
                      <div style={{ marginTop: 6, fontSize: 13 }}>{assignment.regionPath || "No path"}</div>
                    </td>
                    <td style={{ padding: 12, verticalAlign: "top", color: "#52525b" }}>
                      <div>Starts {formatDateTime(assignment.startsAt)}</div>
                      <div style={{ marginTop: 6 }}>{assignment.endsAt ? `Ends ${formatDateTime(assignment.endsAt)}` : "No end date"}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function UserAdministrativeRegionsPanel({ userId, snapshot, submitting, onAssign }: {
  userId: string;
  snapshot: UserAdministrativeRegionsSnapshot | null;
  submitting: string | null;
  onAssign: (input: {
    userId: string;
    administrativeRegionId: string;
    assignmentType: string;
    startsAt: string;
  }) => Promise<void>;
}) {
  const [administrativeRegionId, setAdministrativeRegionId] = React.useState("");
  const [assignmentType, setAssignmentType] = React.useState("member");
  const [startsAt, setStartsAt] = React.useState("");

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    await onAssign({
      userId,
      administrativeRegionId,
      assignmentType,
      startsAt,
    });
  }

  return (
    <div style={{ display: "grid", gap: 16, marginTop: 24 }}>
      <div style={{ padding: 16, border: "1px solid #e4e4e7", borderRadius: 16, background: "#fff" }}>
        <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>Assign Administrative Region</h2>
        <form onSubmit={handleSubmit} style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          <label style={{ display: "grid", gap: 6 }}>
            <span>Administrative region</span>
            <select value={administrativeRegionId} onChange={(event) => setAdministrativeRegionId(event.target.value)} required style={{ border: "1px solid #d4d4d8", borderRadius: 12, padding: "10px 12px" }}>
              <option value="">Select region</option>
              {(snapshot?.regions ?? []).map((region) => (
                <option key={region.id} value={region.id}>{`${region.name} (${region.type})`}</option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <span>Assignment type</span>
            <select value={assignmentType} onChange={(event) => setAssignmentType(event.target.value)} style={{ border: "1px solid #d4d4d8", borderRadius: 12, padding: "10px 12px" }}>
              <option value="member">Member</option>
              <option value="manager">Manager</option>
              <option value="observer">Observer</option>
            </select>
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <span>Starts at</span>
            <input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} style={{ border: "1px solid #d4d4d8", borderRadius: 12, padding: "10px 12px" }} />
          </label>
          <div style={{ display: "flex", alignItems: "end" }}>
            <button type="submit" disabled={submitting !== null || !administrativeRegionId} style={{ border: 0, borderRadius: 999, padding: "10px 16px", background: "#111827", color: "#fff", fontWeight: 600 }}>
              {submitting === "assign-administrative-region" ? "Assigning..." : "Assign primary administrative region"}
            </button>
          </div>
        </form>
      </div>
      <div style={{ padding: 16, border: "1px solid #e4e4e7", borderRadius: 16, background: "#fff" }}>
        <h2 style={{ margin: "0 0 12px", fontSize: 18 }}>Administrative Region Assignments</h2>
        {!(snapshot?.assignments?.length) ? <div style={{ color: "#71717a" }}>No administrative region assignments yet.</div> : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 920 }}>
              <thead>
                <tr style={{ textAlign: "left", background: "#fafafa" }}>
                  <th style={{ padding: 12 }}>Region</th>
                  <th style={{ padding: 12 }}>Type</th>
                  <th style={{ padding: 12 }}>Lineage</th>
                  <th style={{ padding: 12 }}>Effective Dates</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.assignments.map((assignment) => (
                  <tr key={assignment.id} style={{ borderTop: "1px solid #e4e4e7" }}>
                    <td style={{ padding: 12, verticalAlign: "top" }}>
                      <div style={{ fontWeight: 700 }}>{assignment.administrativeRegionName || "Unknown region"}</div>
                      <div style={{ color: "#52525b", marginTop: 6 }}>{assignment.administrativeRegionCode ? `/${assignment.administrativeRegionCode}` : "No region code"}</div>
                      <div style={{ color: "#71717a", marginTop: 6, fontSize: 13 }}>{assignment.isPrimary ? "Primary assignment" : "Secondary/history entry"}</div>
                    </td>
                    <td style={{ padding: 12, verticalAlign: "top" }}>
                      <div style={{ fontWeight: 700 }}>{assignment.assignmentType}</div>
                      <div style={{ color: "#71717a", marginTop: 6, fontSize: 13 }}>{assignment.administrativeRegionType || "Unknown type"}</div>
                    </td>
                    <td style={{ padding: 12, verticalAlign: "top", color: "#52525b" }}>
                      <div>{assignment.administrativeRegionPath || "No path"}</div>
                      <div style={{ marginTop: 6, fontSize: 13 }}>{assignment.endsAt ? "Historical" : "Active"}</div>
                    </td>
                    <td style={{ padding: 12, verticalAlign: "top", color: "#52525b" }}>
                      <div>Starts {formatDateTime(assignment.startsAt)}</div>
                      <div style={{ marginTop: 6 }}>{assignment.endsAt ? `Ends ${formatDateTime(assignment.endsAt)}` : "No end date"}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function UserSecurityPanel({ userId, status, submitting, onReset }: {
  userId: string;
  status: UserTwoFactorStatus | null;
  submitting: string | null;
  onReset: (input: { userId: string; reason: string }) => Promise<void>;
}) {
  const [reason, setReason] = React.useState("Admin-initiated 2FA reset");

  return (
    <div style={{ display: "grid", gap: 16, marginTop: 24 }}>
      <div style={{ padding: 16, border: "1px solid #e4e4e7", borderRadius: 16, background: "#fff" }}>
        <h2 style={{ margin: "0 0 12px", fontSize: 18 }}>2FA Status</h2>
        <div style={{ display: "grid", gap: 8, color: "#475569" }}>
          <div>Enrolled: <strong>{status?.enrolled ? "Yes" : "No"}</strong></div>
          <div>Pending enrollment: <strong>{status?.pending ? "Yes" : "No"}</strong></div>
          <div>Verified at: <strong>{status?.verifiedAt ? formatDateTime(status.verifiedAt) : "Never"}</strong></div>
          <div>Last used at: <strong>{status?.lastUsedAt ? formatDateTime(status.lastUsedAt) : "Never"}</strong></div>
          <div>Active recovery codes: <strong>{status?.recoveryCodeCount ?? 0}</strong></div>
        </div>
      </div>
      <div style={{ padding: 16, border: "1px solid #e4e4e7", borderRadius: 16, background: "#fff" }}>
        <h2 style={{ margin: "0 0 12px", fontSize: 18 }}>Reset User 2FA</h2>
        <p style={{ margin: "0 0 12px", color: "#52525b" }}>This is a protected flow and requires elevated admin session state. The reset disables the active TOTP credential and invalidates the current recovery code set.</p>
        <label style={{ display: "grid", gap: 6 }}>
          <span>Reason</span>
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} style={{ border: "1px solid #d4d4d8", borderRadius: 12, padding: "10px 12px" }} />
        </label>
        <div style={{ marginTop: 12 }}>
          <button
            type="button"
            disabled={submitting !== null}
            onClick={() => void onReset({ userId, reason })}
            style={{ border: 0, borderRadius: 999, padding: "10px 16px", background: "#7f1d1d", color: "#fff", fontWeight: 600 }}
          >
            {submitting === "reset-2fa" ? "Resetting..." : "Reset 2FA"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SecuritySettingsPage() {
  const { snapshot, loading, error, saving, updatePolicy } = useSecuritySettings();
  const [selectedRoleIds, setSelectedRoleIds] = React.useState<string[]>([]);

  React.useEffect(() => {
    setSelectedRoleIds(snapshot?.policy.mandatoryTwoFactorRoleIds ?? []);
  }, [snapshot]);

  return (
    <PageFrame title="Security Settings">
      <div style={{ marginBottom: 16, color: "#52525b", maxWidth: 820 }}>
        Configure baseline security posture and inspect the roles that currently require mandatory two-factor authentication.
      </div>
      {loading ? <Message>Loading security settings...</Message> : null}
      {!loading && error ? <Message>{error}</Message> : null}
      {!loading && snapshot ? (
        <div style={{ padding: 16, border: "1px solid #e4e4e7", borderRadius: 16, background: "#fff" }}>
          <h2 style={{ margin: "0 0 12px", fontSize: 18 }}>Mandatory 2FA Roles</h2>
          <div style={{ display: "grid", gap: 10 }}>
            {snapshot.roles.map((role) => (
              <label key={role.id} style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={selectedRoleIds.includes(role.id)}
                  onChange={(event) => {
                    setSelectedRoleIds((current) =>
                      event.target.checked ? [...current, role.id].sort((a, b) => a.localeCompare(b)) : current.filter((value) => value !== role.id),
                    );
                  }}
                />
                <span>{role.name} ({role.slug})</span>
              </label>
            ))}
          </div>
          <div style={{ marginTop: 16 }}>
            <button
              type="button"
              disabled={saving}
              onClick={() => void updatePolicy(selectedRoleIds)}
              style={{ border: 0, borderRadius: 999, padding: "10px 16px", background: "#111827", color: "#fff", fontWeight: 600 }}
            >
              {saving ? "Saving..." : "Save security policy"}
            </button>
          </div>
        </div>
      ) : null}
    </PageFrame>
  );
}

function PageFrame({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div style={{ padding: 24, maxWidth: 1120 }}>
      <h1 style={{ fontSize: 28, margin: "0 0 16px", fontWeight: 700 }}>{title}</h1>
      {children}
    </div>
  );
}

function Message({ children }: { children?: React.ReactNode }) {
  return (
    <div
      style={{
        padding: 16,
        border: "1px solid #d4d4d8",
        borderRadius: 12,
        background: "#fafafa",
      }}
    >
      {children}
    </div>
  );
}

function UsersListPage() {
  const { items, loading, error, reload } = useUserList();

  return (
    <PageFrame title="Users">
      <InviteUserCard onCreated={reload} />
      {loading ? <Message>Loading users...</Message> : null}
      {!loading && error ? <Message>{error}</Message> : null}
      {!loading && !error ? (
        <div style={{ overflowX: "auto", border: "1px solid #e4e4e7", borderRadius: 16, background: "#fff" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
            <thead>
              <tr style={{ textAlign: "left", background: "#fafafa" }}>
                <th style={{ padding: 12 }}>User</th>
                <th style={{ padding: 12 }}>Status</th>
                <th style={{ padding: 12 }}>Profile</th>
                <th style={{ padding: 12 }}>Last Login</th>
                <th style={{ padding: 12 }}>Created</th>
                <th style={{ padding: 12 }}>Open</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item: UserListItem) => (
                <tr key={item.id} style={{ borderTop: "1px solid #e4e4e7" }}>
                  <td style={{ padding: 12, verticalAlign: "top" }}>
                    <div style={{ fontWeight: 600 }}>{item.displayName || item.email}</div>
                    <div style={{ color: "#52525b", marginTop: 4 }}>{item.email}</div>
                    <div style={{ color: "#71717a", marginTop: 4, fontSize: 13 }}>
                      {item.username ? `@${item.username}` : "No username"}
                    </div>
                  </td>
                  <td style={{ padding: 12, verticalAlign: "top" }}>
                    <span
                      style={{
                        display: "inline-block",
                        padding: "4px 8px",
                        borderRadius: 999,
                        background: "#f4f4f5",
                        color: statusTone(item.status),
                        fontWeight: 600,
                        textTransform: "capitalize",
                      }}
                    >
                      {item.status}
                    </span>
                    <div style={{ color: "#71717a", marginTop: 8, fontSize: 13 }}>
                      {item.mustResetPassword ? "Password reset required" : "Password state OK"}
                    </div>
                    <div style={{ color: "#71717a", marginTop: 4, fontSize: 13 }}>
                      {item.isProtected ? "Protected user" : "Standard user"}
                    </div>
                    <div style={{ color: "#71717a", marginTop: 4, fontSize: 13 }}>
                      {item.activeSessionCount} active sessions
                    </div>
                  </td>
                  <td style={{ padding: 12, verticalAlign: "top", color: "#52525b" }}>
                    <div>{item.profile.locale || "No locale"}</div>
                    <div style={{ marginTop: 4 }}>{item.profile.timezone || "No timezone"}</div>
                    <div style={{ marginTop: 4 }}>{item.profile.phone || "No phone"}</div>
                  </td>
                  <td style={{ padding: 12, verticalAlign: "top", color: "#52525b" }}>{formatDateTime(item.lastLoginAt)}</td>
                  <td style={{ padding: 12, verticalAlign: "top", color: "#52525b" }}>{formatDateTime(item.createdAt)}</td>
                  <td style={{ padding: 12, verticalAlign: "top" }}>
                    <a href={`/_emdash/admin/plugins/awcms-users-admin/user?id=${encodeURIComponent(item.id)}`}>View</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </PageFrame>
  );
}

function RolesListPage() {
  const { items, loading, error } = useRoleList();

  return (
    <PageFrame title="Roles">
      <div style={{ marginBottom: 16, color: "#52525b", maxWidth: 840 }}>
        Review the seeded role hierarchy, staff levels, and protected-role posture before enabling matrix edits.
      </div>
      {loading ? <Message>Loading roles...</Message> : null}
      {!loading && error ? <Message>{error}</Message> : null}
      {!loading && !error ? (
        <div style={{ overflowX: "auto", border: "1px solid #e4e4e7", borderRadius: 16, background: "#fff" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
            <thead>
              <tr style={{ textAlign: "left", background: "#fafafa" }}>
                <th style={{ padding: 12 }}>Role</th>
                <th style={{ padding: 12 }}>Level</th>
                <th style={{ padding: 12 }}>Protection</th>
                <th style={{ padding: 12 }}>Assignments</th>
                <th style={{ padding: 12 }}>Metadata</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const tone = roleTone(item);

                return (
                  <tr key={item.id} style={{ borderTop: "1px solid #e4e4e7" }}>
                    <td style={{ padding: 12, verticalAlign: "top" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <div style={{ fontWeight: 700 }}>{item.name}</div>
                        <span
                          style={{
                            display: "inline-block",
                            padding: "4px 8px",
                            borderRadius: 999,
                            fontSize: 12,
                            fontWeight: 700,
                            ...tone,
                          }}
                        >
                          {item.isProtected ? "Protected" : item.isAssignable ? "Assignable" : "Reserved"}
                        </span>
                      </div>
                      <div style={{ color: "#52525b", marginTop: 6 }}>/{item.slug}</div>
                      <div style={{ color: "#71717a", marginTop: 6, fontSize: 13 }}>{item.description || "No description"}</div>
                    </td>
                    <td style={{ padding: 12, verticalAlign: "top" }}>
                      <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1 }}>{item.staffLevel}</div>
                      <div style={{ marginTop: 6, color: "#71717a", fontSize: 13 }}>Higher numbers carry more authority.</div>
                    </td>
                    <td style={{ padding: 12, verticalAlign: "top", color: "#52525b" }}>
                      <div>{item.isProtected ? "Protected from routine changes" : "Standard governance rules"}</div>
                      <div style={{ marginTop: 6, fontSize: 13 }}>{item.isSystem ? "System role" : "Custom role"}</div>
                      <div style={{ marginTop: 6, fontSize: 13 }}>{item.isAssignable ? "Can be assigned" : "Not directly assignable"}</div>
                    </td>
                    <td style={{ padding: 12, verticalAlign: "top" }}>
                      <div style={{ fontWeight: 700 }}>{item.activeAssignmentCount}</div>
                      <div style={{ marginTop: 6, color: "#71717a", fontSize: 13 }}>Active user assignments</div>
                    </td>
                    <td style={{ padding: 12, verticalAlign: "top", color: "#52525b" }}>
                      <div>Created {formatDateTime(item.createdAt)}</div>
                      <div style={{ marginTop: 6 }}>Updated {formatDateTime(item.updatedAt)}</div>
                      <div style={{ marginTop: 6, fontSize: 13 }}>{item.deletedAt ? `Deleted ${formatDateTime(item.deletedAt)}` : "Active catalog entry"}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </PageFrame>
  );
}

function JobLevelsPage() {
  const { items, loading, error } = useJobLevelList();

  return (
    <PageFrame title="Job Levels">
      <div style={{ marginBottom: 16, color: "#52525b", maxWidth: 840 }}>
        Review the organizational seniority ladder that stays separate from roles and permissions.
      </div>
      {loading ? <Message>Loading job levels...</Message> : null}
      {!loading && error ? <Message>{error}</Message> : null}
      {!loading && !error ? (
        <div style={{ overflowX: "auto", border: "1px solid #e4e4e7", borderRadius: 16, background: "#fff" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
            <thead>
              <tr style={{ textAlign: "left", background: "#fafafa" }}>
                <th style={{ padding: 12 }}>Level</th>
                <th style={{ padding: 12 }}>Rank</th>
                <th style={{ padding: 12 }}>Mapped Titles</th>
                <th style={{ padding: 12 }}>Metadata</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const tone = jobLevelTone(item);

                return (
                  <tr key={item.id} style={{ borderTop: "1px solid #e4e4e7" }}>
                    <td style={{ padding: 12, verticalAlign: "top" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <div style={{ fontWeight: 700 }}>{item.name}</div>
                        <span style={{ display: "inline-block", padding: "4px 8px", borderRadius: 999, fontSize: 12, fontWeight: 700, ...tone }}>
                          {item.isSystem ? "System" : "Custom"}
                        </span>
                      </div>
                      <div style={{ color: "#52525b", marginTop: 6 }}>/{item.code}</div>
                      <div style={{ color: "#71717a", marginTop: 6, fontSize: 13 }}>{item.description || "No description"}</div>
                    </td>
                    <td style={{ padding: 12, verticalAlign: "top" }}>
                      <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1 }}>{item.rankOrder}</div>
                      <div style={{ marginTop: 6, color: "#71717a", fontSize: 13 }}>Higher rank means more senior organizational context.</div>
                    </td>
                    <td style={{ padding: 12, verticalAlign: "top" }}>
                      <div style={{ fontWeight: 700 }}>{item.activeTitleCount}</div>
                      <div style={{ marginTop: 6, color: "#71717a", fontSize: 13 }}>Active titles mapped to this level</div>
                    </td>
                    <td style={{ padding: 12, verticalAlign: "top", color: "#52525b" }}>
                      <div>Created {formatDateTime(item.createdAt)}</div>
                      <div style={{ marginTop: 6 }}>Updated {formatDateTime(item.updatedAt)}</div>
                      <div style={{ marginTop: 6, fontSize: 13 }}>{item.deletedAt ? `Deleted ${formatDateTime(item.deletedAt)}` : "Active catalog entry"}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </PageFrame>
  );
}

function JobTitlesPage() {
  const { items, loading, error } = useJobTitleList();

  return (
    <PageFrame title="Job Titles">
      <div style={{ marginBottom: 16, color: "#52525b", maxWidth: 840 }}>
        Review the concrete titles mapped to the job level ladder before assignment workflows are expanded.
      </div>
      {loading ? <Message>Loading job titles...</Message> : null}
      {!loading && error ? <Message>{error}</Message> : null}
      {!loading && !error ? (
        <div style={{ overflowX: "auto", border: "1px solid #e4e4e7", borderRadius: 16, background: "#fff" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 920 }}>
            <thead>
              <tr style={{ textAlign: "left", background: "#fafafa" }}>
                <th style={{ padding: 12 }}>Title</th>
                <th style={{ padding: 12 }}>Mapped Level</th>
                <th style={{ padding: 12 }}>Status</th>
                <th style={{ padding: 12 }}>Metadata</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} style={{ borderTop: "1px solid #e4e4e7" }}>
                  <td style={{ padding: 12, verticalAlign: "top" }}>
                    <div style={{ fontWeight: 700 }}>{item.name}</div>
                    <div style={{ color: "#52525b", marginTop: 6 }}>/{item.code}</div>
                    <div style={{ color: "#71717a", marginTop: 6, fontSize: 13 }}>{item.description || "No description"}</div>
                  </td>
                  <td style={{ padding: 12, verticalAlign: "top" }}>
                    <div style={{ fontWeight: 700 }}>{item.levelName || "Unknown level"}</div>
                    <div style={{ marginTop: 6, color: "#52525b" }}>{item.levelCode ? `/${item.levelCode}` : "No mapped code"}</div>
                    <div style={{ marginTop: 6, color: "#71717a", fontSize: 13 }}>Rank {item.levelRankOrder}</div>
                  </td>
                  <td style={{ padding: 12, verticalAlign: "top" }}>
                    <span
                      style={{
                        display: "inline-block",
                        padding: "4px 8px",
                        borderRadius: 999,
                        fontSize: 12,
                        fontWeight: 700,
                        background: item.isActive ? "#ecfdf5" : "#f5f5f4",
                        color: item.isActive ? "#166534" : "#57534e",
                        border: item.isActive ? "1px solid #bbf7d0" : "1px solid #e7e5e4",
                      }}
                    >
                      {item.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td style={{ padding: 12, verticalAlign: "top", color: "#52525b" }}>
                    <div>Created {formatDateTime(item.createdAt)}</div>
                    <div style={{ marginTop: 6 }}>Updated {formatDateTime(item.updatedAt)}</div>
                    <div style={{ marginTop: 6, fontSize: 13 }}>{item.deletedAt ? `Deleted ${formatDateTime(item.deletedAt)}` : "Active catalog entry"}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </PageFrame>
  );
}

function LogicalRegionsPage() {
  const { items, loading, error, submitting, createRegion, updateRegion, reparentRegion } = useLogicalRegions();
  const [createCode, setCreateCode] = React.useState("");
  const [createName, setCreateName] = React.useState("");
  const [createParentId, setCreateParentId] = React.useState("");
  const [createSortOrder, setCreateSortOrder] = React.useState("0");
  const [editCodeById, setEditCodeById] = React.useState<Record<string, string>>({});
  const [editNameById, setEditNameById] = React.useState<Record<string, string>>({});
  const [editSortOrderById, setEditSortOrderById] = React.useState<Record<string, string>>({});
  const [parentById, setParentById] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    setEditCodeById(Object.fromEntries(items.map((item) => [item.id, item.code])));
    setEditNameById(Object.fromEntries(items.map((item) => [item.id, item.name])));
    setEditSortOrderById(Object.fromEntries(items.map((item) => [item.id, String(item.sortOrder)])));
    setParentById(Object.fromEntries(items.map((item) => [item.id, item.parentId ?? ""])));
  }, [items]);

  return (
    <PageFrame title="Logical Regions">
      <div style={{ marginBottom: 16, color: "#52525b", maxWidth: 860 }}>
        Manage the operational region tree. Depth is shown explicitly so create, edit, and reparent changes stay visible before user-assignment flows are added.
      </div>
      <div style={{ padding: 16, border: "1px solid #e4e4e7", borderRadius: 16, background: "#fff", marginBottom: 16 }}>
        <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>Create Region</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void createRegion({ code: createCode, name: createName, parentId: createParentId, sortOrder: createSortOrder });
          }}
          style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}
        >
          <label style={{ display: "grid", gap: 6 }}><span>Code</span><input value={createCode} onChange={(event) => setCreateCode(event.target.value)} required style={{ border: "1px solid #d4d4d8", borderRadius: 12, padding: "10px 12px" }} /></label>
          <label style={{ display: "grid", gap: 6 }}><span>Name</span><input value={createName} onChange={(event) => setCreateName(event.target.value)} required style={{ border: "1px solid #d4d4d8", borderRadius: 12, padding: "10px 12px" }} /></label>
          <label style={{ display: "grid", gap: 6 }}>
            <span>Parent</span>
            <select value={createParentId} onChange={(event) => setCreateParentId(event.target.value)} style={{ border: "1px solid #d4d4d8", borderRadius: 12, padding: "10px 12px" }}>
              <option value="">Root region</option>
              {items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label style={{ display: "grid", gap: 6 }}><span>Sort Order</span><input value={createSortOrder} onChange={(event) => setCreateSortOrder(event.target.value)} inputMode="numeric" style={{ border: "1px solid #d4d4d8", borderRadius: 12, padding: "10px 12px" }} /></label>
          <div style={{ display: "flex", alignItems: "end" }}>
            <button type="submit" disabled={submitting !== null} style={{ border: 0, borderRadius: 999, padding: "10px 16px", background: "#111827", color: "#fff", fontWeight: 600 }}>
              {submitting === "create" ? "Creating..." : "Create region"}
            </button>
          </div>
        </form>
      </div>
      {loading ? <Message>Loading logical regions...</Message> : null}
      {!loading && error ? <Message>{error}</Message> : null}
      {!loading && !error ? (
        <div style={{ overflowX: "auto", border: "1px solid #e4e4e7", borderRadius: 16, background: "#fff" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1120 }}>
            <thead>
              <tr style={{ textAlign: "left", background: "#fafafa" }}>
                <th style={{ padding: 12 }}>Tree</th>
                <th style={{ padding: 12 }}>Code / Name</th>
                <th style={{ padding: 12 }}>Depth</th>
                <th style={{ padding: 12 }}>Reparent</th>
                <th style={{ padding: 12 }}>Metadata</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} style={{ borderTop: "1px solid #e4e4e7" }}>
                  <td style={{ padding: 12, verticalAlign: "top" }}>
                    <div style={{ paddingLeft: (item.level - 1) * 18, fontWeight: 700 }}>{item.name}</div>
                    <div style={{ paddingLeft: (item.level - 1) * 18, color: "#71717a", fontSize: 13, marginTop: 6 }}>{item.path}</div>
                  </td>
                  <td style={{ padding: 12, verticalAlign: "top" }}>
                    <div style={{ display: "grid", gap: 8 }}>
                      <input value={editCodeById[item.id] ?? item.code} onChange={(event) => setEditCodeById((current) => ({ ...current, [item.id]: event.target.value }))} style={{ border: "1px solid #d4d4d8", borderRadius: 12, padding: "10px 12px" }} />
                      <input value={editNameById[item.id] ?? item.name} onChange={(event) => setEditNameById((current) => ({ ...current, [item.id]: event.target.value }))} style={{ border: "1px solid #d4d4d8", borderRadius: 12, padding: "10px 12px" }} />
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <input value={editSortOrderById[item.id] ?? String(item.sortOrder)} onChange={(event) => setEditSortOrderById((current) => ({ ...current, [item.id]: event.target.value }))} inputMode="numeric" style={{ border: "1px solid #d4d4d8", borderRadius: 12, padding: "10px 12px", width: 120 }} />
                        <button
                          type="button"
                          disabled={submitting !== null}
                          onClick={() => void updateRegion({ regionId: item.id, code: editCodeById[item.id] ?? item.code, name: editNameById[item.id] ?? item.name, sortOrder: editSortOrderById[item.id] ?? String(item.sortOrder) })}
                          style={{ border: 0, borderRadius: 999, padding: "10px 16px", background: "#0f172a", color: "#fff", fontWeight: 600 }}
                        >
                          {submitting === `update:${item.id}` ? "Saving..." : "Save"}
                        </button>
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: 12, verticalAlign: "top" }}>
                    <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1 }}>{item.level}</div>
                    <div style={{ marginTop: 6, color: "#71717a", fontSize: 13 }}>{item.parentId ? `Child of ${item.parentId}` : "Root node"}</div>
                  </td>
                  <td style={{ padding: 12, verticalAlign: "top" }}>
                    <div style={{ display: "grid", gap: 8 }}>
                      <select value={parentById[item.id] ?? ""} onChange={(event) => setParentById((current) => ({ ...current, [item.id]: event.target.value }))} style={{ border: "1px solid #d4d4d8", borderRadius: 12, padding: "10px 12px" }}>
                        <option value="">Root region</option>
                        {items.filter((candidate) => candidate.id !== item.id).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
                      </select>
                      <button
                        type="button"
                        disabled={submitting !== null}
                        onClick={() => void reparentRegion({ regionId: item.id, parentId: parentById[item.id] ?? "" })}
                        style={{ border: "1px solid #d4d4d8", borderRadius: 999, padding: "10px 16px", background: "#fff", fontWeight: 600 }}
                      >
                        {submitting === `reparent:${item.id}` ? "Moving..." : "Reparent"}
                      </button>
                    </div>
                  </td>
                  <td style={{ padding: 12, verticalAlign: "top", color: "#52525b" }}>
                    <div>{item.isActive ? "Active" : "Inactive"}</div>
                    <div style={{ marginTop: 6 }}>Created {formatDateTime(item.createdAt)}</div>
                    <div style={{ marginTop: 6 }}>Updated {formatDateTime(item.updatedAt)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </PageFrame>
  );
}

function AdministrativeRegionsPage() {
  const { snapshot, loading, error } = useAdministrativeRegions();
  const items = snapshot?.items ?? [];

  return (
    <PageFrame title="Administrative Regions">
      <div style={{ marginBottom: 16, color: "#52525b", maxWidth: 900 }}>
        Inspect the legal Indonesian administrative hierarchy used for geographic governance scope. Lineage, region type, and normalized codes are shown directly from the imported dataset.
      </div>
      <div style={{ padding: 16, border: "1px solid #e4e4e7", borderRadius: 16, background: "#fff", marginBottom: 16, display: "grid", gap: 8 }}>
        <div style={{ fontWeight: 700 }}>Import Status</div>
        <div style={{ color: "#52525b" }}>Source data: <code>{snapshot?.importStatus.source ?? "Unknown"}</code></div>
        <div style={{ color: "#52525b" }}>Seed command: <code>{snapshot?.importStatus.command ?? "Unknown"}</code></div>
        <div style={{ color: "#52525b" }}>Latest sync metadata: {snapshot?.importStatus.latestUpdatedAt ? formatDateTime(snapshot.importStatus.latestUpdatedAt) : "No imported rows yet"}</div>
        <div style={{ color: "#52525b" }}>Loaded rows: {snapshot?.importStatus.total ?? 0}</div>
      </div>
      {loading ? <Message>Loading administrative regions...</Message> : null}
      {!loading && error ? <Message>{error}</Message> : null}
      {!loading && !error ? (
        <div style={{ overflowX: "auto", border: "1px solid #e4e4e7", borderRadius: 16, background: "#fff" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1180 }}>
            <thead>
              <tr style={{ textAlign: "left", background: "#fafafa" }}>
                <th style={{ padding: 12 }}>Lineage</th>
                <th style={{ padding: 12 }}>Type</th>
                <th style={{ padding: 12 }}>Codes</th>
                <th style={{ padding: 12 }}>Metadata</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} style={{ borderTop: "1px solid #e4e4e7" }}>
                  <td style={{ padding: 12, verticalAlign: "top" }}>
                    <div style={{ fontWeight: 700 }}>{item.name}</div>
                    <div style={{ color: "#52525b", marginTop: 6 }}>/{item.code}</div>
                    <div style={{ color: "#71717a", marginTop: 6, fontSize: 13 }}>{item.path}</div>
                    <div style={{ color: "#71717a", marginTop: 6, fontSize: 13 }}>{item.parentId ? `Child of ${item.parentId}` : "Root legal region"}</div>
                  </td>
                  <td style={{ padding: 12, verticalAlign: "top" }}>
                    <div style={{ display: "inline-block", padding: "4px 8px", borderRadius: 999, background: "#eff6ff", color: "#1d4ed8", fontSize: 12, fontWeight: 700, border: "1px solid #bfdbfe" }}>
                      {item.type}
                    </div>
                    <div style={{ marginTop: 8, color: "#71717a", fontSize: 13 }}>{item.isActive ? "Active hierarchy row" : "Inactive hierarchy row"}</div>
                  </td>
                  <td style={{ padding: 12, verticalAlign: "top", color: "#52525b" }}>
                    <div>Province: {item.provinceCode || "-"}</div>
                    <div style={{ marginTop: 6 }}>Regency/City: {item.regencyCode || "-"}</div>
                    <div style={{ marginTop: 6 }}>District: {item.districtCode || "-"}</div>
                    <div style={{ marginTop: 6 }}>Village: {item.villageCode || "-"}</div>
                  </td>
                  <td style={{ padding: 12, verticalAlign: "top", color: "#52525b" }}>
                    <div>Created {formatDateTime(item.createdAt)}</div>
                    <div style={{ marginTop: 6 }}>Updated {formatDateTime(item.updatedAt)}</div>
                    <div style={{ marginTop: 6, fontSize: 13 }}>{item.id}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </PageFrame>
  );
}

function PermissionMatrixPage() {
  const {
    snapshot,
    draftByRoleId,
    loading,
    error,
    saving,
    pendingChanges,
    protectedChanges,
    confirmProtectedChanges,
    setConfirmProtectedChanges,
    elevatedFlowConfirmed,
    setElevatedFlowConfirmed,
    toggleGrant,
    resetDraft,
    applyDraft,
  } = usePermissionMatrix();

  return (
    <PageFrame title="Permission Matrix">
      <div style={{ marginBottom: 16, color: "#52525b", maxWidth: 900 }}>
        Columns are roles and rows are explicit permissions. Edits stay staged locally until you apply them.
      </div>
      {loading ? <Message>Loading permission matrix...</Message> : null}
      {!loading && error ? <Message>{error}</Message> : null}
      {!loading && !error && snapshot ? (
        <>
          <div
            style={{
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
              alignItems: "center",
              marginBottom: 16,
              padding: 16,
              border: "1px solid #e4e4e7",
              borderRadius: 16,
              background: "#fff",
            }}
          >
            <div style={{ fontWeight: 700 }}>{pendingChanges} staged changes</div>
            <button
              type="button"
              disabled={saving || pendingChanges === 0}
              onClick={resetDraft}
              style={{ border: "1px solid #d4d4d8", borderRadius: 999, padding: "10px 16px", background: "#fff", fontWeight: 600 }}
            >
              Reset staged edits
            </button>
            <button
              type="button"
              disabled={saving || pendingChanges === 0 || (protectedChanges && (!confirmProtectedChanges || !elevatedFlowConfirmed))}
              onClick={() => void applyDraft()}
              style={{ border: 0, borderRadius: 999, padding: "10px 16px", background: "#111827", color: "#fff", fontWeight: 600 }}
            >
              {saving ? "Applying..." : "Apply staged changes"}
            </button>
            {protectedChanges ? (
              <label style={{ display: "flex", alignItems: "center", gap: 8, color: "#991b1b", fontWeight: 600 }}>
                <input
                  type="checkbox"
                  checked={confirmProtectedChanges}
                  onChange={(event) => setConfirmProtectedChanges(event.target.checked)}
                />
                Confirm protected permission changes
              </label>
            ) : null}
            {protectedChanges ? (
              <label style={{ display: "flex", alignItems: "center", gap: 8, color: "#7c2d12", fontWeight: 600 }}>
                <input
                  type="checkbox"
                  checked={elevatedFlowConfirmed}
                  onChange={(event) => setElevatedFlowConfirmed(event.target.checked)}
                />
                Elevated confirmation flow completed
              </label>
            ) : null}
          </div>
          <div style={{ overflowX: "auto", border: "1px solid #e4e4e7", borderRadius: 16, background: "#fff" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1180 }}>
              <thead>
                <tr style={{ textAlign: "left", background: "#fafafa" }}>
                  <th style={{ padding: 12, minWidth: 320 }}>Permission</th>
                  {snapshot.roles.map((role) => (
                    <th key={role.id} style={{ padding: 12, minWidth: 140, verticalAlign: "bottom" }}>
                      <div style={{ fontWeight: 700 }}>{role.name}</div>
                      <div style={{ color: "#71717a", marginTop: 4, fontSize: 13 }}>/ {role.slug}</div>
                      <div style={{ color: "#71717a", marginTop: 4, fontSize: 13 }}>Level {role.staffLevel}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {snapshot.rows.map((row) => {
                  const tone = permissionTone(row);

                  return (
                    <tr key={row.id} style={{ borderTop: "1px solid #e4e4e7" }}>
                      <td style={{ padding: 12, verticalAlign: "top" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                          <div style={{ fontWeight: 700 }}>{row.code}</div>
                          <span
                            style={{
                              display: "inline-block",
                              padding: "4px 8px",
                              borderRadius: 999,
                              fontSize: 12,
                              fontWeight: 700,
                              ...tone,
                            }}
                          >
                            {row.isProtected ? "Protected" : row.domain}
                          </span>
                        </div>
                        <div style={{ marginTop: 6, color: "#52525b" }}>{row.description || "No description"}</div>
                        <div style={{ marginTop: 6, color: "#71717a", fontSize: 13 }}>
                          {row.resource} / {row.action}
                        </div>
                      </td>
                      {snapshot.roles.map((role) => {
                        const checked = (draftByRoleId[role.id] ?? []).includes(row.id);

                        return (
                          <td key={`${row.id}:${role.id}`} style={{ padding: 12, textAlign: "center", verticalAlign: "middle" }}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleGrant(role.id, row.id)}
                              aria-label={`${role.name} ${row.code}`}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </PageFrame>
  );
}

function DetailField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ padding: 16, border: "1px solid #e4e4e7", borderRadius: 12, background: "#fff" }}>
      <div style={{ color: "#71717a", fontSize: 13, marginBottom: 6 }}>{label}</div>
      <div>{value}</div>
    </div>
  );
}

function UserDetailPage() {
  const {
    item,
    jobsSnapshot,
    regionsSnapshot,
    administrativeRegionsSnapshot,
    twoFactorStatus,
    loading,
    error,
    submitting,
    runAction,
    assignJob,
    assignRegion,
    assignAdministrativeRegion,
    resetTwoFactor,
  } = useUserDetail();

  return (
    <PageFrame title="User Detail">
      <div style={{ marginBottom: 16 }}>
        <a href="/_emdash/admin/plugins/awcms-users-admin/">Back to users</a>
      </div>
      {loading ? <Message>Loading user...</Message> : null}
      {!loading && error ? <Message>{error}</Message> : null}
      {!loading && !error && item ? (
        <>
          <div
            style={{
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
              marginBottom: 16,
              padding: 16,
              border: "1px solid #e4e4e7",
              borderRadius: 16,
              background: "#fff",
            }}
          >
            <button
              type="button"
              onClick={() => runAction("disable")}
              disabled={submitting !== null || item.status === "disabled"}
              style={{ border: 0, borderRadius: 999, padding: "10px 16px", background: "#7f1d1d", color: "#fff", fontWeight: 600 }}
            >
              {submitting === "disable" ? "Disabling..." : "Disable user"}
            </button>
            <button
              type="button"
              onClick={() => runAction("lock")}
              disabled={submitting !== null || item.status === "locked"}
              style={{ border: 0, borderRadius: 999, padding: "10px 16px", background: "#991b1b", color: "#fff", fontWeight: 600 }}
            >
              {submitting === "lock" ? "Locking..." : "Lock user"}
            </button>
            <button
              type="button"
              onClick={() => runAction("revoke-sessions")}
              disabled={submitting !== null || item.activeSessionCount === 0}
              style={{ border: 0, borderRadius: 999, padding: "10px 16px", background: "#0f172a", color: "#fff", fontWeight: 600 }}
            >
              {submitting === "revoke-sessions" ? "Revoking..." : `Revoke sessions (${item.activeSessionCount})`}
            </button>
          </div>
          <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
            <DetailField label="Email" value={item.email} />
            <DetailField label="Display Name" value={item.displayName || "Not set"} />
            <DetailField label="Username" value={item.username ? `@${item.username}` : "Not set"} />
            <DetailField label="Status" value={item.status} />
            <DetailField label="Active Sessions" value={String(item.activeSessionCount)} />
            <DetailField label="Last Login" value={formatDateTime(item.lastLoginAt)} />
            <DetailField label="Created" value={formatDateTime(item.createdAt)} />
            <DetailField label="Updated" value={formatDateTime(item.updatedAt)} />
            <DetailField label="Phone" value={item.profile.phone || "Not set"} />
            <DetailField label="Locale" value={item.profile.locale || "Not set"} />
            <DetailField label="Timezone" value={item.profile.timezone || "Not set"} />
            <DetailField label="Avatar Media" value={item.profile.avatarMediaId || "Not set"} />
            <DetailField label="Soft Deleted" value={item.deletedAt ? formatDateTime(item.deletedAt) : "No"} />
            <DetailField label="Password Reset Required" value={item.mustResetPassword ? "Yes" : "No"} />
            <DetailField label="Protected" value={item.isProtected ? "Yes" : "No"} />
            <DetailField label="Notes" value={item.profile.notes || "No notes"} />
          </div>
          <UserJobsPanel userId={item.id} snapshot={jobsSnapshot} submitting={submitting} onAssign={assignJob} />
          <UserRegionsPanel userId={item.id} snapshot={regionsSnapshot} submitting={submitting} onAssign={assignRegion} />
          <UserAdministrativeRegionsPanel
            userId={item.id}
            snapshot={administrativeRegionsSnapshot}
            submitting={submitting}
            onAssign={assignAdministrativeRegion}
          />
          <UserSecurityPanel userId={item.id} status={twoFactorStatus} submitting={submitting} onReset={resetTwoFactor} />
        </>
      ) : null}
    </PageFrame>
  );
}

export const pages = {
  "/": UsersListPage,
  "/administrative-regions": AdministrativeRegionsPage,
  "/jobs/levels": JobLevelsPage,
  "/jobs/titles": JobTitlesPage,
  "/permissions": PermissionMatrixPage,
  "/regions": LogicalRegionsPage,
  "/roles": RolesListPage,
  "/security": SecuritySettingsPage,
  "/user": UserDetailPage,
};
