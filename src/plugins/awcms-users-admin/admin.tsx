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

function usePermissionMatrix() {
  const [snapshot, setSnapshot] = React.useState<PermissionMatrixSnapshot | null>(null);
  const [draftByRoleId, setDraftByRoleId] = React.useState<Record<string, string[]>>({});
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [confirmProtectedChanges, setConfirmProtectedChanges] = React.useState(false);

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
        }),
      });
      const data = await parseApiResponse<{ snapshot: PermissionMatrixSnapshot }>(response, "Failed to apply permission matrix");
      setSnapshot(data.snapshot);
      setDraftByRoleId(buildDraftByRoleId(data.snapshot));
      setConfirmProtectedChanges(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to apply permission matrix");
    } finally {
      setSaving(false);
    }
  }, [confirmProtectedChanges, draftByRoleId, snapshot]);

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
    toggleGrant,
    resetDraft,
    applyDraft,
  };
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
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState<string | null>(null);

  const fetchUser = React.useCallback(async (userId: string) => {
    const response = await apiFetch(`${API_BASE}/users/detail?id=${encodeURIComponent(userId)}`);
    return parseApiResponse<{ item: UserListItem }>(response, "Failed to load user");
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
        if (!cancelled) {
          setItem(data.item);
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
  }, [fetchUser]);

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

  return { item, loading, error, submitting, runAction };
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
              disabled={saving || pendingChanges === 0 || (protectedChanges && !confirmProtectedChanges)}
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
  const { item, loading, error, submitting, runAction } = useUserDetail();

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
        </>
      ) : null}
    </PageFrame>
  );
}

export const pages = {
  "/": UsersListPage,
  "/permissions": PermissionMatrixPage,
  "/roles": RolesListPage,
  "/user": UserDetailPage,
};
