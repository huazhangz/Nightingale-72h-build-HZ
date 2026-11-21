// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const care = vi.hoisted(() => ({ selectPatient: vi.fn(), refreshPatients: vi.fn(async () => undefined) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("../src/components/care/CareShell", () => ({
  useCareContext: () => ({ ...care, role: "CLINICIAN", patientId: "", userId: "u1", clinicName: "Demo", patients: [], user: {} }),
}));

import { PatientWorklist, type WorklistRow } from "../src/components/care/PatientWorklist";
import { I18nProvider } from "../src/lib/i18n/I18nContext";

const row = (patientId: string, name: string, level: WorklistRow["level"], pending = false): WorklistRow => ({
  patientId,
  name,
  level,
  review: level === "CRITICAL" ? "IMMEDIATE" : level ? "ROUTINE" : null,
  method: level ? "agent" : null,
  overridden: false,
  assessedAt: null,
  pending,
  lastEncounterAt: "2026-11-20T09:00:00.000Z",
  noteCount: 1,
  openActions: 0,
});

const ROWS = [row("p1", "Ada Critical", "CRITICAL"), row("p2", "Ben Low", "LOW"), row("p3", "Cy Pending", "LOW", true), row("p4", "Di New", null)];

function mockApi() {
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === "/api/patients" && method === "GET") return new Response(JSON.stringify({ patients: ROWS }), { status: 200 });
      if (url === "/api/patients" && method === "POST") return new Response(JSON.stringify({ patient: { id: "p9" }, activationUrl: null }), { status: 201 });
      if (url === "/api/entries" && method === "POST") return new Response(JSON.stringify({ entry: { id: "e1" } }), { status: 201 });
      return new Response(JSON.stringify({ error: "unmocked" }), { status: 404 });
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderWorklist = () => render(createElement(I18nProvider, null, createElement(PatientWorklist)));
const names = () => screen.getAllByRole("button", { name: /^Open / }).map((button) => button.textContent);

describe("PatientWorklist", () => {
  it("filters by search, level count, unassessed and assessing-only", async () => {
    mockApi();
    renderWorklist();
    await screen.findByText("Ada Critical");
    expect(screen.getByText("4 of 4 patients", { exact: false })).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("Search patients"), { target: { value: "ben" } });
    expect(names()).toEqual(["Ben Low"]);

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    const counts = screen.getByRole("group", { name: "Risk level" });
    fireEvent.click(within(counts).getAllByRole("button")[0]!); // CRITICAL
    expect(names()).toEqual(["Ada Critical"]);
    fireEvent.click(within(counts).getAllByRole("button")[0]!); // toggles back off
    expect(names()).toHaveLength(4);

    fireEvent.change(screen.getByLabelText("Risk level", { selector: "select" }), { target: { value: "NONE" } });
    expect(names()).toEqual(["Di New"]);
    fireEvent.change(screen.getByLabelText("Risk level", { selector: "select" }), { target: { value: "ALL" } });
    fireEvent.click(screen.getByLabelText("Assessing only"));
    expect(names()).toEqual(["Cy Pending"]);
  });

  it("adds a patient with a first note, then a note for an existing patient", async () => {
    const calls = mockApi();
    renderWorklist();
    await screen.findByText("Ada Critical");
    fireEvent.click(screen.getByRole("button", { name: "Add to database" }));

    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Eve New" } });
    fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "1990-01-02" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "First visit" } });
    fireEvent.change(screen.getByLabelText("Note text"), { target: { value: "Chest pain at rest for 40 minutes." } });
    fireEvent.click(screen.getByRole("button", { name: "Create patient record" }));
    expect(await screen.findByText("Patient and first note saved. A risk assessment is running.")).toBeTruthy();
    const entry = calls.find((call) => call.url === "/api/entries");
    expect(entry?.body).toMatchObject({ patientId: "p9", title: "First visit", body: "Chest pain at rest for 40 minutes." });
    expect(typeof entry?.body?.encounterAt).toBe("string");
    expect(care.refreshPatients).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: "New note" }));
    const save = screen.getByRole("button", { name: "Save note" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Patient"), { target: { value: "p2" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Review" } });
    fireEvent.change(screen.getByLabelText("Note text"), { target: { value: "Stable." } });
    fireEvent.click(save);
    expect(await screen.findByText("Note saved. A risk assessment is running.")).toBeTruthy();
    await waitFor(() => expect(calls.filter((call) => call.url === "/api/entries").at(-1)?.body).toMatchObject({ patientId: "p2", title: "Review" }));
  });
});
