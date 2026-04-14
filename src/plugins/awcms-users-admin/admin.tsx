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
        const response = await apiFetch(`${API_BASE}/users/detail?id=${encodeURIComponent(id)}`);
        const data = await parseApiResponse<{ item: UserListItem }>(response, "Failed to load user");
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
  }, []);

  return { item, loading, error };
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

function DetailField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ padding: 16, border: "1px solid #e4e4e7", borderRadius: 12, background: "#fff" }}>
      <div style={{ color: "#71717a", fontSize: 13, marginBottom: 6 }}>{label}</div>
      <div>{value}</div>
    </div>
  );
}

function UserDetailPage() {
  const { item, loading, error } = useUserDetail();

  return (
    <PageFrame title="User Detail">
      <div style={{ marginBottom: 16 }}>
        <a href="/_emdash/admin/plugins/awcms-users-admin/">Back to users</a>
      </div>
      {loading ? <Message>Loading user...</Message> : null}
      {!loading && error ? <Message>{error}</Message> : null}
      {!loading && !error && item ? (
        <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          <DetailField label="Email" value={item.email} />
          <DetailField label="Display Name" value={item.displayName || "Not set"} />
          <DetailField label="Username" value={item.username ? `@${item.username}` : "Not set"} />
          <DetailField label="Status" value={item.status} />
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
      ) : null}
    </PageFrame>
  );
}

export const pages = {
  "/": UsersListPage,
  "/user": UserDetailPage,
};
