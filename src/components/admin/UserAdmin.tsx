"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiFetch } from "../../lib/api/client";
import { useI18n } from "../../lib/i18n/I18nContext";
import type { MessageKey } from "../../lib/i18n/messages";
import { ActivationLink } from "../care/PatientWorklist";
import { Notice } from "../ui/RiskBadge";

type AdminUser = {
  id: string;
  name: string;
  email: string;
  role: "STAFF" | "CLINICIAN" | "ADMIN";
  status: "ACTIVE" | "INVITED" | "DISABLED";
  title: string | null;
  department: string | null;
  lastLoginAt: string | null;
  locked: boolean;
};

const STATUS_KEY: Record<AdminUser["status"], MessageKey> = {
  ACTIVE: "admin.statusActive",
  INVITED: "admin.statusInvited",
  DISABLED: "admin.statusDisabled",
};

export function UserAdmin({ currentUserId }: { currentUserId: string }) {
  const { t, formatDateTime } = useI18n();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [form, setForm] = useState({ email: "", name: "", role: "CLINICIAN", title: "", department: "" });
  const set = (key: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [key]: value }));

  const load = useCallback(async () => {
    try {
      setUsers((await apiFetch<{ users: AdminUser[] }>("/api/admin/users")).users);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("auth.genericError"));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function invite(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setLink(null);
    setBusyId("invite");
    try {
      const result = await apiFetch<{ activationUrl: string }>("/api/admin/users", { method: "POST", body: form });
      setLink(result.activationUrl);
      setForm({ email: "", name: "", role: "CLINICIAN", title: "", department: "" });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("auth.genericError"));
    } finally {
      setBusyId(null);
    }
  }

  async function act(user: AdminUser, action: "toggle" | "link") {
    setError(null);
    setLink(null);
    setBusyId(user.id);
    try {
      if (action === "link") {
        setLink((await apiFetch<{ activationUrl: string }>(`/api/admin/users/${user.id}/invitation`, { method: "POST", body: {} })).activationUrl);
      } else {
        await apiFetch(`/api/admin/users/${user.id}`, { method: "PATCH", body: { status: user.status === "DISABLED" ? "ACTIVE" : "DISABLED" } });
      }
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("auth.genericError"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <section className="panel" aria-labelledby="invite-title">
        <h2 id="invite-title">{t("admin.invite")}</h2>
        <form className="form-grid" onSubmit={(event) => void invite(event)} noValidate>
          <div className="field">
            <label htmlFor="invite-name">{t("auth.fullName")}</label>
            <input id="invite-name" required value={form.name} onChange={(event) => set("name")(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="invite-email">{t("auth.email")}</label>
            <input id="invite-email" type="email" required value={form.email} onChange={(event) => set("email")(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="invite-role">{t("account.role")}</label>
            <select id="invite-role" value={form.role} onChange={(event) => set("role")(event.target.value)}>
              {(["CLINICIAN", "STAFF", "ADMIN"] as const).map((role) => (
                <option key={role} value={role}>
                  {t(`role.${role}` as MessageKey)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="invite-title">{t("admin.title")}</label>
            <input id="invite-title" value={form.title} onChange={(event) => set("title")(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="invite-department">{t("admin.department")}</label>
            <input id="invite-department" value={form.department} onChange={(event) => set("department")(event.target.value)} />
          </div>
          <div className="form-actions">
            <button type="submit" className="btn" disabled={busyId === "invite" || !form.name || !form.email}>
              {t("admin.inviteSubmit")}
            </button>
          </div>
        </form>
        {link ? <ActivationLink url={link} /> : null}
      </section>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {users === null ? (
        <p className="status">{t("shell.loading")}</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t("auth.fullName")}</th>
                <th scope="col">{t("account.role")}</th>
                <th scope="col">{t("admin.status")}</th>
                <th scope="col">{t("admin.lastLogin")}</th>
                <th scope="col">
                  <span className="sr-only">{t("admin.status")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>
                    <span className="user-name">{user.name}</span>
                    <span className="muted small block">{user.email}</span>
                  </td>
                  <td>{t(`role.${user.role}` as MessageKey)}</td>
                  <td>
                    <span className={`chip chip-status-${user.status.toLowerCase()}`}>{t(STATUS_KEY[user.status])}</span>
                    {user.locked ? <span className="chip handover-chip-safety">{t("admin.locked")}</span> : null}
                  </td>
                  <td>{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : t("admin.never")}</td>
                  <td className="row-actions">
                    {user.status === "INVITED" ? (
                      <button type="button" className="btn btn-secondary btn-small" disabled={busyId === user.id} onClick={() => void act(user, "link")}>
                        {t("admin.newLink")}
                      </button>
                    ) : user.id !== currentUserId ? (
                      <button type="button" className="btn btn-secondary btn-small" disabled={busyId === user.id} onClick={() => void act(user, "toggle")}>
                        {user.status === "DISABLED" ? t("admin.enable") : t("admin.disable")}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
