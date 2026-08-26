"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiFetch } from "../../lib/api/client";

type DemoUser = { id: string; name: string; email: string; role: string };

type DemoState = {
  patientId: string;
  userId: string;
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

const NAV = [
  { href: "/timeline", label: "Timeline" },
  { href: "/glance", label: "Glance" },
  { href: "/note-editor", label: "Note editor" },
  { href: "/search", label: "Search" },
];

export function CareShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [users, setUsers] = useState<DemoUser[]>([]);
  const [patientId, setPatientId] = useState<string>("");
  const [userId, setUserId] = useState<string>("");
  const [clinicName, setClinicName] = useState("Nightingale");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void apiFetch<{
      clinic: { name: string };
      users: DemoUser[];
      patientId: string | null;
      defaultUserId: string | null;
    }>("/api/demo", { userId: "bootstrap" })
      .then((demo) => {
        setUsers(demo.users);
        setClinicName(demo.clinic.name);
        if (demo.patientId) {
          setPatientId(demo.patientId);
        }
        if (demo.defaultUserId) {
          setUserId(demo.defaultUserId);
        }
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : "Unable to load demo session");
      });
  }, []);

  const value = useMemo(
    () => ({ patientId, userId, users, clinicName, setUserId }),
    [patientId, userId, users, clinicName],
  );

  return (
    <CareContext.Provider value={value}>
      <div className="app-shell">
        <header className="topbar">
          <div>
            <p className="eyebrow">{clinicName}</p>
            <p className="brand">Nightingale care notes</p>
          </div>
          <div className="field compact">
            <label htmlFor="actor">Acting as</label>
            <select
              id="actor"
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              disabled={!users.length}
            >
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name} ({user.role})
                </option>
              ))}
            </select>
          </div>
        </header>
        <nav className="nav" aria-label="Primary">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={pathname === item.href ? "nav-link active" : "nav-link"}
            >
              {item.label}
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
      </div>
    </CareContext.Provider>
  );
}

export function CarePage({
  title,
  children,
}: {
  title: string;
  children: (session: { patientId: string; userId: string }) => ReactNode;
}) {
  const { patientId, userId } = useCareContext();
  if (!patientId || !userId) {
    return (
      <>
        <h1>{title}</h1>
        <p className="status">Preparing clinic session…</p>
      </>
    );
  }
  return (
    <>
      <h1>{title}</h1>
      {children({ patientId, userId })}
    </>
  );
}
