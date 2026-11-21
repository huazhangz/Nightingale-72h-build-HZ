"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiFetch } from "../../lib/api/client";
import { useI18n } from "../../lib/i18n/I18nContext";
import type { MessageKey } from "../../lib/i18n/messages";
import { useCareContext } from "../care/CareShell";
import { Notice } from "../ui/RiskBadge";

export function AccountView() {
  const { t } = useI18n();
  const router = useRouter();
  const { user } = useCareContext();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    if (next !== confirm) {
      setError(t("auth.passwordMismatch"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/auth/password", { method: "POST", body: { currentPassword: current, newPassword: next } });
      setSaved(true);
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("auth.genericError"));
    } finally {
      setBusy(false);
    }
  }

  async function signOutEverywhere() {
    setBusy(true);
    await apiFetch("/api/auth/sessions/revoke", { method: "POST", body: {} }).catch(() => undefined);
    router.replace("/login");
  }

  return (
    <div className="account-grid">
      <section className="panel" aria-labelledby="profile-title">
        <h2 id="profile-title">{t("account.profile")}</h2>
        <dl className="detail-list">
          <dt>{t("auth.fullName")}</dt>
          <dd>{user.name}</dd>
          <dt>{t("auth.email")}</dt>
          <dd>{user.email}</dd>
          <dt>{t("account.role")}</dt>
          <dd>{t(`role.${user.role}` as MessageKey)}</dd>
          {user.clinic ? (
            <>
              <dt>{t("account.clinic")}</dt>
              <dd>{user.clinic.name}</dd>
            </>
          ) : null}
        </dl>
      </section>
      <section className="panel" aria-labelledby="password-title">
        <h2 id="password-title">{t("account.changePassword")}</h2>
        <form className="form-stack" onSubmit={(event) => void changePassword(event)} noValidate>
          <div className="field">
            <label htmlFor="current-password">{t("account.currentPassword")}</label>
            <input id="current-password" type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="new-password">{t("account.newPassword")}</label>
            <input id="new-password" type="password" autoComplete="new-password" aria-describedby="new-password-hint" value={next} onChange={(event) => setNext(event.target.value)} />
            <p className="field-hint" id="new-password-hint">
              {t("auth.passwordHint")}
            </p>
          </div>
          <div className="field">
            <label htmlFor="confirm-password">{t("auth.confirmPassword")}</label>
            <input id="confirm-password" type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
          </div>
          {error ? <Notice tone="error">{error}</Notice> : null}
          {saved ? <Notice tone="success">{t("account.saved")}</Notice> : null}
          <button type="submit" className="btn" disabled={busy || !current || !next}>
            {t("account.save")}
          </button>
        </form>
      </section>
      <section className="panel" aria-labelledby="sessions-title">
        <h2 id="sessions-title">{t("account.signOutEverywhere")}</h2>
        <p className="muted">{t("account.signOutEverywhereHint")}</p>
        <button type="button" className="btn btn-secondary" onClick={() => void signOutEverywhere()} disabled={busy}>
          {t("account.signOutEverywhere")}
        </button>
      </section>
    </div>
  );
}
