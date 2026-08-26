"use client";

import { useState } from "react";
import { apiFetch } from "../../lib/api/client";
import { useI18n } from "../../lib/i18n/I18nContext";

export type LoginRole = "PATIENT" | "STAFF" | "CLINICIAN";

export function LoginModal({
  role,
  onCancel,
  onVerified,
}: {
  role: LoginRole;
  onCancel: () => void;
  onVerified: (userId: string) => void;
}) {
  const { t } = useI18n();
  const [fullName, setFullName] = useState(role === "PATIENT" ? "Zhang Wei" : "");
  const [phone, setPhone] = useState(role === "PATIENT" ? "13812345678" : "");
  const [dateOfBirth, setDateOfBirth] = useState(role === "PATIENT" ? "1985-06-15" : "");
  const [employeeCode, setEmployeeCode] = useState(
    role === "STAFF" ? "000001" : role === "CLINICIAN" ? "000002" : "",
  );
  const [verification, setVerification] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const result = await apiFetch<{ userId: string }>(
        "/api/auth/login",
        role === "PATIENT"
          ? {
              userId: "bootstrap",
              method: "POST",
              body: { role, fullName, phone, dateOfBirth },
            }
          : {
              userId: "bootstrap",
              method: "POST",
              body: { role, employeeCode, verification },
            },
      );
      onVerified(result.userId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("login.failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-title"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2 id="login-title">{t(role === "PATIENT" ? "login.patientTitle" : "login.staffTitle")}</h2>
        {role === "PATIENT" ? (
          <>
            <div className="field">
              <label htmlFor="login-name">{t("login.fullName")}</label>
              <input
                id="login-name"
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="login-phone">{t("login.phone")}</label>
              <input
                id="login-phone"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="login-dob">{t("login.dob")}</label>
              <input
                id="login-dob"
                type="date"
                value={dateOfBirth}
                onChange={(event) => setDateOfBirth(event.target.value)}
                required
              />
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label htmlFor="login-code">{t("login.employeeCode")}</label>
              <input
                id="login-code"
                value={employeeCode}
                onChange={(event) => setEmployeeCode(event.target.value)}
                inputMode="numeric"
                maxLength={6}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="login-verify">{t("login.verification")}</label>
              <input
                id="login-verify"
                value={verification}
                onChange={(event) => setVerification(event.target.value)}
                required
              />
            </div>
          </>
        )}
        {error ? (
          <p className="status error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="btn secondary" onClick={onCancel}>
            {t("login.cancel")}
          </button>
          <button type="submit" className="btn" disabled={saving}>
            {saving ? t("login.verifying") : t("login.submit")}
          </button>
        </div>
      </form>
    </div>
  );
}
