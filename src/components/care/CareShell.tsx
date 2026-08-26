"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { LoginModal, type LoginRole } from "../auth/LoginModal";
import { useI18n } from "../../lib/i18n/I18nContext";
import type { MessageKey } from "../../lib/i18n/messages";
import { apiFetch } from "../../lib/api/client";

type DemoUser = { id: string; name: string; email: string; role: string };
type DemoPatient = { id: string; name: string; email: string; phone: string | null };

type DemoState = {
  patientId: string;
  userId: string;
  role: string;
  users: DemoUser[];
  clinicName: string;
  setUserId: (id: string) => void;
};

const CareContext = createContext<DemoState | null>(null);

export function useCareContext(): DemoState {
  const value = useContext(CareContext);
  if (!value) {
    throw new Error("useCareContext must be used within CareShell");
  }
  return value;
}

const ROLE_ORDER = ["PATIENT", "STAFF", "CLINICIAN"] as const;

const NAV: Array<{ href: string; labelKey: MessageKey }> = [
  { href: "/timeline", labelKey: "nav.timeline" },
  { href: "/glance", labelKey: "nav.glance" },
  { href: "/note-editor", labelKey: "nav.noteEditor" },
  { href: "/search", labelKey: "nav.search" },
];

export function CareShell({ children }: { children: ReactNode }) {
  const { t, locale, setLocale, locales } = useI18n();
  const pathname = usePathname();
  const [users, setUsers] = useState<DemoUser[]>([]);
  const [patients, setPatients] = useState<DemoPatient[]>([]);
  const [featuredPatientId, setFeaturedPatientId] = useState<string>("");
  const [selectedPatientId, setSelectedPatientId] = useState<string>("");
  const [userId, setUserId] = useState<string>("");
  const [clinicName, setClinicName] = useState("Nightingale");
  const [error, setError] = useState<string | null>(null);
  const [pendingRole, setPendingRole] = useState<LoginRole | null>(null);

  useEffect(() => {
    void apiFetch<{
      clinic: { name: string };
      users: DemoUser[];
      patients?: DemoPatient[];
      patientId: string | null;
      featuredPatientId?: string | null;
      defaultUserId: string | null;
    }>("/api/demo", { userId: "bootstrap" })
      .then((demo) => {
        setUsers(demo.users);
        setClinicName(demo.clinic.name);
        if (demo.patients?.length) {
          setPatients(demo.patients);
        }
        const featured = demo.featuredPatientId ?? demo.patientId;
        if (featured) {
          setFeaturedPatientId(featured);
          setSelectedPatientId(featured);
        }
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : t("session.loadError"));
      });
  }, [t]);

  const actor = users.find((user) => user.id === userId);
  const canSwitchPatient = actor?.role === "STAFF" || actor?.role === "CLINICIAN" || actor?.role === "ADMIN";
  const patientId = actor?.role === "PATIENT" ? userId : selectedPatientId || featuredPatientId;
  const value = useMemo(
    () => ({
      patientId,
      userId,
      role: actor?.role ?? "",
      users,
      clinicName,
      setUserId,
    }),
    [patientId, userId, users, clinicName, actor?.role],
  );

  return (
    <CareContext.Provider value={value}>
      <div className="app-shell">
        <header className="topbar">
          <div>
            <p className="eyebrow">{clinicName}</p>
            <p className="brand">{t("brand")}</p>
          </div>
          <div className="header-controls">
          <fieldset className="role-selector">
            <legend>{t("language.legend")}</legend>
            <label className="sr-only" htmlFor="language-select">
              {t("language.aria")}
            </label>
            <select
              id="language-select"
              value={locale}
              onChange={(event) => setLocale(event.target.value as typeof locale)}
              aria-label={t("language.aria")}
            >
              {locales.map((code) => (
                <option key={code} value={code}>
                  {t(`language.${code}` as MessageKey)}
                </option>
              ))}
            </select>
          </fieldset>
          {canSwitchPatient && patients.length > 0 ? (
            <fieldset className="role-selector">
              <legend>{t("patient.legend")}</legend>
              <label className="sr-only" htmlFor="patient-select">
                {t("patient.aria")}
              </label>
              <select
                id="patient-select"
                value={patientId}
                onChange={(event) => setSelectedPatientId(event.target.value)}
                aria-label={t("patient.aria")}
              >
                {patients.map((patient) => (
                  <option key={patient.id} value={patient.id}>
                    {patient.phone ? `${patient.name} · ${patient.phone}` : patient.name}
                  </option>
                ))}
              </select>
            </fieldset>
          ) : null}
          <fieldset className="role-selector">
            <legend>{t("role.legend")}</legend>
            <div className="role-selector-row" role="radiogroup" aria-label={t("role.aria")}>
              {ROLE_ORDER.map((role) => {
                const match = users.find((user) => user.role === role);
                const selected = actor?.role === role;
                return (
                  <button
                    key={role}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={selected ? "role-btn active" : "role-btn"}
                    disabled={role === "PATIENT" ? false : !match}
                    onClick={() => {
                      if (role !== "PATIENT" && !match) {
                        return;
                      }
                      if (selected && userId) {
                        return;
                      }
                      setUserId("");
                      setPendingRole(role);
                    }}
                  >
                    {t(`role.${role}` as MessageKey)}
                  </button>
                );
              })}
            </div>
          </fieldset>
          </div>
        </header>
        <nav className="nav" aria-label={t("nav.aria")}>
          {NAV.filter(
            (item) =>
              item.href !== "/note-editor" || actor?.role === "STAFF" || actor?.role === "CLINICIAN",
          ).map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={pathname === item.href ? "nav-link active" : "nav-link"}
            >
              {t(item.labelKey)}
            </Link>
          ))}
        </nav>
        <main className="main">
          {error ? (
            <p className="status error" role="alert">
              {error}
            </p>
          ) : null}
          {children}
        </main>
        {pendingRole ? (
          <LoginModal
            role={pendingRole}
            onCancel={() => {
              setUserId("");
              setPendingRole(null);
            }}
            onVerified={(id) => {
              setUserId(id);
              setPendingRole(null);
            }}
          />
        ) : null}
      </div>
    </CareContext.Provider>
  );
}

export function CarePage({
  titleKey,
  children,
}: {
  titleKey: MessageKey;
  children: (session: { patientId: string; userId: string; role: string }) => ReactNode;
}) {
  const { t } = useI18n();
  const { patientId, userId, role } = useCareContext();
  if (!patientId || !userId) {
    return (
      <>
        <h1>{t(titleKey)}</h1>
        <p className="status">{t("session.preparing")}</p>
      </>
    );
  }
  return (
    <>
      <h1>{t(titleKey)}</h1>
      {children({ patientId, userId, role })}
    </>
  );
}
