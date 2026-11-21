"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiFetch } from "../../lib/api/client";
import { useI18n } from "../../lib/i18n/I18nContext";
import type { MessageKey } from "../../lib/i18n/messages";
import { Notice, RiskBadge, type RiskLevelValue } from "../ui/RiskBadge";
import { useCareContext } from "./CareShell";

export type WorklistRow = {
  patientId: string;
  name: string;
  level: RiskLevelValue | null;
  review: string | null;
  method: "agent" | "rules" | null;
  overridden: boolean;
  assessedAt: string | null;
  pending: boolean;
  lastEncounterAt: string | null;
  noteCount: number;
  openActions: number;
};

const POLL_MS = 8_000;

/** Clinic worklist ordered by risk triage. Polls while any assessment is still running. */
export function PatientWorklist() {
  const { t, formatDateTime } = useI18n();
  const router = useRouter();
  const { selectPatient, refreshPatients } = useCareContext();
  const [rows, setRows] = useState<WorklistRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const { patients } = await apiFetch<{ patients: WorklistRow[] }>("/api/patients");
      setRows(patients);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("auth.genericError"));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const anyPending = rows?.some((row) => row.pending) ?? false;
  useEffect(() => {
    if (!anyPending) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [anyPending, load]);

  function open(patientId: string) {
    selectPatient(patientId);
    router.push("/glance");
  }

  return (
    <section aria-labelledby="worklist-title">
      <div className="section-head">
        <h2 id="worklist-title" className="sr-only">
          {t("pages.patients")}
        </h2>
        <button type="button" className="btn" onClick={() => setAdding((value) => !value)} aria-expanded={adding}>
          {t("worklist.addPatient")}
        </button>
      </div>
      {adding ? (
        <AddPatientForm
          onCreated={() => {
            void load();
            void refreshPatients();
          }}
        />
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {rows === null ? (
        <p className="status">{t("shell.loading")}</p>
      ) : rows.length === 0 ? (
        <p className="muted">{t("worklist.empty")}</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table worklist-table">
            <thead>
              <tr>
                <th scope="col">{t("worklist.risk")}</th>
                <th scope="col">{t("worklist.patient")}</th>
                <th scope="col">{t("worklist.review")}</th>
                <th scope="col">{t("worklist.lastEncounter")}</th>
                <th scope="col" className="num">
                  {t("worklist.notes")}
                </th>
                <th scope="col" className="num">
                  {t("worklist.openActions")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.patientId} data-level={row.level ?? "NONE"}>
                  <td>
                    <div className="worklist-risk">
                      <RiskBadge level={row.level} pending={row.pending} />
                      {row.method ? (
                        <span className="chip chip-quiet">{t(row.method === "agent" ? "worklist.methodAgent" : "worklist.methodRules")}</span>
                      ) : null}
                      {row.overridden ? <span className="chip chip-quiet">{t("worklist.overridden")}</span> : null}
                      {row.pending && row.level ? <span className="muted small">{t("worklist.assessing")}</span> : null}
                    </div>
                  </td>
                  <td>
                    <button type="button" className="link-button" onClick={() => open(row.patientId)} aria-label={t("worklist.select", { name: row.name })}>
                      {row.name}
                    </button>
                  </td>
                  <td>{row.review ? t(`risk.review.${row.review}` as MessageKey) : "–"}</td>
                  <td>{row.lastEncounterAt ? formatDateTime(row.lastEncounterAt) : "–"}</td>
                  <td className="num">{row.noteCount}</td>
                  <td className="num">{row.openActions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AddPatientForm({ onCreated }: { onCreated: () => void }) {
  const { t } = useI18n();
  const [form, setForm] = useState({ name: "", dateOfBirth: "", email: "", phone: "" });
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [key]: value }));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ activationUrl: string | null }>("/api/patients", { method: "POST", body: form });
      setLink(result.activationUrl);
      setDone(true);
      setForm({ name: "", dateOfBirth: "", email: "", phone: "" });
      onCreated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("auth.genericError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel form-grid" onSubmit={(event) => void onSubmit(event)} noValidate>
      <div className="field">
        <label htmlFor="new-patient-name">{t("auth.fullName")}</label>
        <input id="new-patient-name" required value={form.name} onChange={(event) => set("name")(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="new-patient-dob">{t("auth.dob")}</label>
        <input id="new-patient-dob" type="date" required value={form.dateOfBirth} onChange={(event) => set("dateOfBirth")(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="new-patient-email">{t("worklist.emailOptional")}</label>
        <input id="new-patient-email" type="email" value={form.email} onChange={(event) => set("email")(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="new-patient-phone">{t("worklist.phoneOptional")}</label>
        <input id="new-patient-phone" type="tel" value={form.phone} onChange={(event) => set("phone")(event.target.value)} />
      </div>
      <div className="form-actions">
        <button type="submit" className="btn" disabled={busy || !form.name || !form.dateOfBirth}>
          {t("worklist.addSubmit")}
        </button>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {done ? <Notice tone="success">{t("worklist.created")}</Notice> : null}
      {link ? <ActivationLink url={link} /> : null}
    </form>
  );
}

export function ActivationLink({ url }: { url: string }) {
  const { t } = useI18n();
  return (
    <div className="activation-link">
      <p className="muted small">{t("admin.linkCreated")}</p>
      <input readOnly value={url} aria-label={t("admin.newLink")} onFocus={(event) => event.currentTarget.select()} />
    </div>
  );
}
