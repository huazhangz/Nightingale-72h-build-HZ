"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiFetch, ApiError, UNAUTHORIZED_EVENT } from "../../lib/api/client";
import { careEvents } from "../../lib/events/bus";
import { useI18n } from "../../lib/i18n/I18nContext";
import type { MessageKey } from "../../lib/i18n/messages";
import { RiskBadge, type RiskLevelValue } from "../ui/RiskBadge";

/**
 * Authenticated application shell. Identity comes from the server (`/api/auth/me`, signed session
 * cookie); there is no client-side role switching. Clinical roles choose a patient from their
 * clinic's worklist; a patient always sees their own record.
 */

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  role: "PATIENT" | "STAFF" | "CLINICIAN" | "ADMIN";
  title: string | null;
  department: string | null;
  clinic: { id: string; name: string } | null;
};

type WorklistPatient = { patientId: string; name: string; level: RiskLevelValue | null; pending: boolean };

type CareState = {
  user: SessionUser;
  patientId: string;
  userId: string;
  role: string;
  clinicName: string;
  patients: WorklistPatient[];
  selectPatient: (patientId: string) => void;
  refreshPatients: () => Promise<void>;
};

const CareContext = createContext<CareState | null>(null);
const PATIENT_STORAGE_KEY = "nightingale.patient";

export function useCareContext(): CareState {
  const value = useContext(CareContext);
  if (!value) {
    throw new Error("useCareContext must be used within CareShell");
  }
  return value;
}

export function isClinicalRole(role: string): boolean {
  return role === "STAFF" || role === "CLINICIAN" || role === "ADMIN";
}

const NAV: Array<{ href: string; labelKey: MessageKey; roles: SessionUser["role"][] }> = [
  { href: "/patients", labelKey: "nav.patients", roles: ["STAFF", "CLINICIAN", "ADMIN"] },
  { href: "/glance", labelKey: "nav.glance", roles: ["PATIENT", "STAFF", "CLINICIAN", "ADMIN"] },
  { href: "/timeline", labelKey: "nav.timeline", roles: ["PATIENT", "STAFF", "CLINICIAN", "ADMIN"] },
  { href: "/note-editor", labelKey: "nav.noteEditor", roles: ["STAFF", "CLINICIAN"] },
  { href: "/search", labelKey: "nav.search", roles: ["PATIENT", "STAFF", "CLINICIAN", "ADMIN"] },
  { href: "/admin/users", labelKey: "nav.admin", roles: ["ADMIN"] },
];

function readStoredPatient(): string {
  try {
    return window.localStorage.getItem(PATIENT_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function CareShell({ children }: { children: ReactNode }) {
  const { t, locale, setLocale, locales } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [patients, setPatients] = useState<WorklistPatient[]>([]);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState<string | null>(null);

  const goToLogin = useCallback(() => {
    const next = `${pathname}${searchParams?.toString() ? `?${searchParams.toString()}` : ""}`;
    router.replace(`/login?next=${encodeURIComponent(next)}`);
  }, [pathname, router, searchParams]);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ user: SessionUser }>("/api/auth/me")
      .then(({ user: me }) => {
        if (!cancelled) setUser(me);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        if (caught instanceof ApiError && caught.status === 401) goToLogin();
        else setError(caught instanceof Error ? caught.message : t("auth.genericError"));
      });
    const onUnauthorized = () => goToLogin();
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => {
      cancelled = true;
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    };
    // Identity is loaded once per mount; navigation keeps the shell mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshPatients = useCallback(async () => {
    const { patients: rows } = await apiFetch<{ patients: WorklistPatient[] }>("/api/patients");
    setPatients(rows);
  }, []);

  useEffect(() => {
    if (user && isClinicalRole(user.role)) {
      void refreshPatients().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : t("auth.genericError")));
    }
  }, [user, refreshPatients, t]);

  // Notes, reassessments and overrides change levels: keep the header picker in step.
  useEffect(() => {
    if (!user || !isClinicalRole(user.role)) return;
    return careEvents.on("entry:changed", () => {
      void refreshPatients().catch(() => undefined);
    });
  }, [user, refreshPatients]);

  const fromUrl = searchParams?.get("patient") ?? "";
  // A ?patient= link selects that patient once, when the link changes; the picker can override it.
  useEffect(() => {
    if (fromUrl && patients.some((patient) => patient.patientId === fromUrl)) {
      setSelected(fromUrl);
    }
  }, [fromUrl, patients]);
  // Default selection: last choice on this device, else the most urgent patient on the worklist.
  useEffect(() => {
    if (!user || !isClinicalRole(user.role) || patients.length === 0) return;
    const known = (id: string) => patients.some((patient) => patient.patientId === id);
    if (selected && known(selected)) return;
    const stored = readStoredPatient();
    setSelected(stored && known(stored) ? stored : patients[0]!.patientId);
  }, [user, patients, selected]);

  const selectPatient = useCallback((patientId: string) => {
    setSelected(patientId);
    try {
      window.localStorage.setItem(PATIENT_STORAGE_KEY, patientId);
    } catch {
      // Storage unavailable (private mode): selection still works for this session.
    }
  }, []);

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
    router.replace("/login");
  }

  const value = useMemo<CareState | null>(() => {
    if (!user) return null;
    const patientId = user.role === "PATIENT" ? user.id : selected;
    return {
      user,
      patientId,
      userId: user.id,
      role: user.role,
      clinicName: user.clinic?.name ?? "Nightingale",
      patients,
      selectPatient,
      refreshPatients,
    };
  }, [user, selected, patients, selectPatient, refreshPatients]);

  if (!value) {
    return (
      <div className="app-shell">
        <main className="main" id="main">
          {error ? <p className="status error" role="alert">{error}</p> : <p className="status">{t("shell.loading")}</p>}
        </main>
      </div>
    );
  }

  const clinical = isClinicalRole(value.role);
  const current = patients.find((patient) => patient.patientId === value.patientId);

  return (
    <CareContext.Provider value={value}>
      <div className="app-shell">
        <a className="skip-link" href="#main">
          {t("shell.skip")}
        </a>
        <header className="topbar">
          <div>
            <p className="eyebrow">{value.clinicName}</p>
            <p className="brand">{t("brand")}</p>
          </div>
          <div className="header-controls">
            {clinical && patients.length > 0 ? (
              <div className="role-selector patient-picker">
                <label htmlFor="patient-select">{t("patient.legend")}</label>
                <div className="patient-picker-row">
                  <select id="patient-select" value={value.patientId} onChange={(event) => selectPatient(event.target.value)}>
                    {patients.map((patient) => (
                      <option key={patient.patientId} value={patient.patientId}>
                        {patient.name}
                      </option>
                    ))}
                  </select>
                  {current ? <RiskBadge level={current.level} pending={current.pending} /> : null}
                </div>
              </div>
            ) : null}
            <div className="role-selector language-selector">
              <label htmlFor="language-select">{t("language.legend")}</label>
              <select id="language-select" value={locale} onChange={(event) => setLocale(event.target.value as typeof locale)}>
                {locales.map((code) => (
                  <option key={code} value={code}>
                    {t(`language.${code}` as MessageKey)}
                  </option>
                ))}
              </select>
            </div>
            <div className="user-menu" aria-label={value.user.name}>
              <div className="user-menu-identity">
                <span className="user-name">{value.user.name}</span>
                <span className="user-role">{t(`role.${value.role}` as MessageKey)}</span>
              </div>
              <Link className="btn btn-secondary btn-small" href="/account">
                {t("shell.account")}
              </Link>
              <button type="button" className="btn btn-secondary btn-small" onClick={() => void signOut()}>
                {t("shell.signOut")}
              </button>
            </div>
          </div>
        </header>
        <nav className="nav" aria-label={t("nav.aria")}>
          {NAV.filter((item) => item.roles.includes(value.user.role)).map((item) => (
            <Link key={item.href} href={item.href} className={pathname === item.href ? "nav-link active" : "nav-link"} aria-current={pathname === item.href ? "page" : undefined}>
              {t(item.labelKey)}
            </Link>
          ))}
        </nav>
        <main className="main" id="main">
          {error ? (
            <p className="status error" role="alert">
              {error}
            </p>
          ) : null}
          {children}
        </main>
      </div>
    </CareContext.Provider>
  );
}

/** Page frame for patient-scoped views: waits for identity and a selected patient. */
export function CarePage({
  titleKey,
  children,
}: {
  titleKey: MessageKey;
  children: (session: { patientId: string; userId: string; role: string }) => ReactNode;
}) {
  const { t } = useI18n();
  const { patientId, userId, role } = useCareContext();
  return (
    <>
      <h1>{t(titleKey)}</h1>
      {patientId ? children({ patientId, userId, role }) : <p className="status">{t("shell.noPatient")}</p>}
    </>
  );
}
