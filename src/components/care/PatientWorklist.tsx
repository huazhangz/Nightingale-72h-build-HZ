"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { apiFetch } from "../../lib/api/client";
import { notifyEntryChanged } from "../../lib/events/patientRefresh";
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
const LEVELS: RiskLevelValue[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
type LevelFilter = "ALL" | RiskLevelValue | "NONE";

/**
 * Clinic worklist ordered by risk triage (the server sorts by level, review window, recency).
 * Search, level filter and an "assessing only" toggle narrow the list on the client; the level
 * counts double as filter buttons. Polls while any assessment is still running.
 */
export function PatientWorklist() {
  const { t, formatDateTime } = useI18n();
  const router = useRouter();
  const { selectPatient, refreshPatients } = useCareContext();
  const [rows, setRows] = useState<WorklistRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<LevelFilter>("ALL");
  const [pendingOnly, setPendingOnly] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { patients } = await apiFetch<{ patients: WorklistRow[] }>("/api/patients");
      setRows(patients);
      setUpdatedAt(new Date());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("auth.genericError"));
    } finally {
      setLoading(false);
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

  const counts = useMemo(() => {
    const byLevel: Record<string, number> = {};
    for (const row of rows ?? []) {
      const key = row.level ?? "NONE";
      byLevel[key] = (byLevel[key] ?? 0) + 1;
    }
    return byLevel;
  }, [rows]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (rows ?? []).filter(
      (row) =>
        (!needle || row.name.toLowerCase().includes(needle)) &&
        (level === "ALL" || (level === "NONE" ? row.level === null : row.level === level)) &&
        (!pendingOnly || row.pending),
    );
  }, [rows, query, level, pendingOnly]);

  const filtered = query.trim() !== "" || level !== "ALL" || pendingOnly;

  function open(patientId: string) {
    selectPatient(patientId);
    router.push("/glance");
  }

  async function afterWrite() {
    await load();
    await refreshPatients();
  }

  return (
    <section aria-labelledby="worklist-title">
      <div className="section-head">
        <h2 id="worklist-title" className="sr-only">
          {t("pages.patients")}
        </h2>
        <div className="worklist-counts" role="group" aria-label={t("worklist.filterLevel")}>
          {LEVELS.map((value) => (
            <button
              key={value}
              type="button"
              className={level === value ? "count-chip active" : "count-chip"}
              aria-pressed={level === value}
              onClick={() => setLevel((current) => (current === value ? "ALL" : value))}
            >
              <RiskBadge level={value} />
              <span className="count">{counts[value] ?? 0}</span>
            </button>
          ))}
        </div>
        <button type="button" className="btn" onClick={() => setAdding((value) => !value)} aria-expanded={adding} aria-controls="add-record">
          {t("worklist.addRecord")}
        </button>
      </div>

      {adding ? <AddRecordPanel patients={rows ?? []} onSaved={afterWrite} /> : null}

      <div className="worklist-toolbar">
        <div className="field inline">
          <label htmlFor="worklist-search" className="sr-only">
            {t("worklist.search")}
          </label>
          <input id="worklist-search" type="search" placeholder={t("worklist.search")} value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <div className="field inline">
          <label htmlFor="worklist-level" className="sr-only">
            {t("worklist.filterLevel")}
          </label>
          <select id="worklist-level" value={level} onChange={(event) => setLevel(event.target.value as LevelFilter)}>
            <option value="ALL">{t("worklist.filterAll")}</option>
            {LEVELS.map((value) => (
              <option key={value} value={value}>
                {t(`risk.level.${value}` as MessageKey)}
              </option>
            ))}
            <option value="NONE">{t("worklist.unassessed")}</option>
          </select>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={pendingOnly} onChange={(event) => setPendingOnly(event.target.checked)} />
          {t("worklist.pendingOnly")}
        </label>
        {filtered ? (
          <button
            type="button"
            className="btn btn-secondary btn-small"
            onClick={() => {
              setQuery("");
              setLevel("ALL");
              setPendingOnly(false);
            }}
          >
            {t("worklist.clearFilters")}
          </button>
        ) : null}
        <span className="toolbar-spacer" />
        <span className="muted small" aria-live="polite">
          {rows ? t("worklist.countShown", { shown: String(visible.length), total: String(rows.length) }) : null}
          {updatedAt ? ` · ${t("worklist.updated", { time: formatDateTime(updatedAt.toISOString()) })}` : null}
        </span>
        <button type="button" className="btn btn-secondary btn-small" onClick={() => void load()} disabled={loading}>
          {t("worklist.refresh")}
        </button>
      </div>

      {error ? <Notice tone="error">{error}</Notice> : null}
      {rows === null ? (
        <p className="status">{t("shell.loading")}</p>
      ) : rows.length === 0 ? (
        <p className="muted">{t("worklist.empty")}</p>
      ) : visible.length === 0 ? (
        <p className="muted">{t("worklist.noMatch")}</p>
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
              {visible.map((row) => (
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

/** Local datetime-input value for "now" (the input has no time zone). */
function nowLocalInput(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

type NoteDraft = { title: string; body: string; encounterAt: string };
const emptyNote = (): NoteDraft => ({ title: "", body: "", encounterAt: nowLocalInput() });

/**
 * Manual data entry from the main screen: a new patient record (optionally with a first note), or
 * a note for an existing patient. Every write goes through the same APIs as the rest of the app,
 * so RBAC, PHI redaction, highlights, audit and the automatic risk assessment all apply.
 */
function AddRecordPanel({ patients, onSaved }: { patients: WorklistRow[]; onSaved: () => Promise<void> }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"patient" | "note">("patient");
  const [patient, setPatient] = useState({ name: "", dateOfBirth: "", email: "", phone: "" });
  const [note, setNote] = useState<NoteDraft>(emptyNote);
  const [notePatientId, setNotePatientId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  const setP = (key: keyof typeof patient) => (value: string) => setPatient((current) => ({ ...current, [key]: value }));
  const setN = (key: keyof NoteDraft) => (value: string) => setNote((current) => ({ ...current, [key]: value }));
  const noteFilled = note.title.trim() !== "" && note.body.trim() !== "";

  async function createNote(patientId: string) {
    await apiFetch("/api/entries", {
      method: "POST",
      body: { patientId, title: note.title.trim(), body: note.body, encounterAt: new Date(note.encounterAt).toISOString() },
    });
    notifyEntryChanged({ patientId, entryId: "new", reason: "created" });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    setLink(null);
    try {
      if (mode === "patient") {
        const result = await apiFetch<{ patient: { id: string }; activationUrl: string | null }>("/api/patients", { method: "POST", body: patient });
        if (noteFilled) {
          await createNote(result.patient.id);
        }
        setLink(result.activationUrl);
        setMessage(t(noteFilled ? "worklist.patientAndNoteSaved" : "worklist.created"));
        setPatient({ name: "", dateOfBirth: "", email: "", phone: "" });
      } else {
        await createNote(notePatientId);
        setMessage(t("worklist.noteSaved"));
      }
      setNote(emptyNote());
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("auth.genericError"));
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = mode === "patient" ? patient.name.trim() !== "" && patient.dateOfBirth !== "" : notePatientId !== "" && noteFilled;

  return (
    <section id="add-record" className="panel add-record" aria-labelledby="add-record-title">
      <h3 id="add-record-title" className="sr-only">
        {t("worklist.addRecord")}
      </h3>
      <div className="tabs" role="tablist" aria-label={t("worklist.addRecord")}>
        {(["patient", "note"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            className={mode === value ? "tab active" : "tab"}
            onClick={() => {
              setMode(value);
              setError(null);
              setMessage(null);
            }}
          >
            {t(value === "patient" ? "worklist.tabPatient" : "worklist.tabNote")}
          </button>
        ))}
      </div>
      <form className="form-grid" onSubmit={(event) => void submit(event)} noValidate>
        {mode === "patient" ? (
          <>
            <div className="field">
              <label htmlFor="new-patient-name">{t("auth.fullName")}</label>
              <input id="new-patient-name" required value={patient.name} onChange={(event) => setP("name")(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="new-patient-dob">{t("auth.dob")}</label>
              <input id="new-patient-dob" type="date" required value={patient.dateOfBirth} onChange={(event) => setP("dateOfBirth")(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="new-patient-email">{t("worklist.emailOptional")}</label>
              <input id="new-patient-email" type="email" value={patient.email} onChange={(event) => setP("email")(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="new-patient-phone">{t("worklist.phoneOptional")}</label>
              <input id="new-patient-phone" type="tel" value={patient.phone} onChange={(event) => setP("phone")(event.target.value)} />
            </div>
            <p className="field-span muted small">
              <strong>{t("worklist.firstNote")}</strong> · {t("worklist.firstNoteHint")}
            </p>
          </>
        ) : (
          <div className="field">
            <label htmlFor="note-patient">{t("worklist.notePatient")}</label>
            <select id="note-patient" required value={notePatientId} onChange={(event) => setNotePatientId(event.target.value)}>
              <option value="">{t("worklist.choosePatient")}</option>
              {patients.map((row) => (
                <option key={row.patientId} value={row.patientId}>
                  {row.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="note-title">{t("worklist.noteTitle")}</label>
          <input id="note-title" value={note.title} maxLength={200} onChange={(event) => setN("title")(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="note-encounter">{t("worklist.encounterAt")}</label>
          <input id="note-encounter" type="datetime-local" value={note.encounterAt} onChange={(event) => setN("encounterAt")(event.target.value)} />
        </div>
        <div className="field field-span">
          <label htmlFor="note-body">{t("worklist.noteBody")}</label>
          <textarea id="note-body" rows={5} value={note.body} onChange={(event) => setN("body")(event.target.value)} />
          {mode === "note" ? <span className="hint">{t("worklist.firstNoteHint")}</span> : null}
        </div>
        <div className="form-actions">
          <button type="submit" className="btn" disabled={busy || !canSubmit}>
            {t(mode === "patient" ? "worklist.addSubmit" : "worklist.noteSubmit")}
          </button>
        </div>
      </form>
      <div aria-live="polite">
        {error ? <Notice tone="error">{error}</Notice> : null}
        {message ? <Notice tone="success">{message}</Notice> : null}
      </div>
      {link ? <ActivationLink url={link} /> : null}
    </section>
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
