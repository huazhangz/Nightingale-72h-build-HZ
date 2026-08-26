import { createElement, useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/timeline",
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: unknown;
    className?: string;
  }) => createElement("a", { href, ...props }, children as never),
}));

import { NoteEditor } from "../src/components/care/NoteEditor";
import { GlanceView } from "../src/components/care/GlanceView";
import { TimelineView } from "../src/components/care/TimelineView";
import { SearchView } from "../src/components/care/SearchView";
import { CarePage, CareShell } from "../src/components/care/CareShell";
import { I18nProvider } from "../src/lib/i18n/I18nContext";
import { careEvents, createEventBus } from "../src/lib/events/bus";
import { notifyEntryChanged, subscribePatientRefresh } from "../src/lib/events/patientRefresh";

function Workspace() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    return subscribePatientRefresh("patient-1", () => setTick((value) => value + 1));
  }, []);
  return createElement("div", null, [
    createElement("p", { key: "tick", "data-testid": "refresh-tick" }, String(tick)),
    createElement(GlanceView, {
      key: "glance",
      patientId: "patient-1",
      userId: "clinician-1",
      role: "CLINICIAN",
    }),
    createElement(TimelineView, {
      key: "timeline",
      patientId: "patient-1",
      userId: "clinician-1",
      role: "CLINICIAN",
    }),
    createElement(NoteEditor, {
      key: "editor",
      patientId: "patient-1",
      userId: "clinician-1",
      role: "CLINICIAN",
    }),
  ]);
}

describe("event bus", () => {
  it("notifies listeners and can unsubscribe", () => {
    const bus = createEventBus();
    const received: string[] = [];
    const stop = bus.on("entry:changed", (payload) => {
      received.push(payload.entryId);
    });
    bus.emit("entry:changed", { patientId: "p1", entryId: "e1", reason: "created" });
    stop();
    bus.emit("entry:changed", { patientId: "p1", entryId: "e2", reason: "created" });
    expect(received).toEqual(["e1"]);
  });
});

describe("UI refresh after note save", () => {
  beforeEach(() => {
    careEvents.clear();
    let glanceLoads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/glance")) {
          glanceLoads += 1;
          return new Response(
            JSON.stringify({
              patientId: "patient-1",
              highestRiskHighlights: [],
              unresolvedActions: glanceLoads > 1 ? [{ id: "e1:plan", kind: "plan", text: "Plan: follow up", careEntryId: "e1" }] : [],
              recencyScore: glanceLoads,
              generatedAt: new Date().toISOString(),
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/timeline")) {
          return new Response(
            JSON.stringify({
              entries: [
                {
                  id: "e1",
                  title: "Follow-up visit",
                  encounterAt: new Date().toISOString(),
                  version: 1,
                  status: "DRAFT",
                  authorRole: "CLINICIAN",
                  patientFacingSummary: "Plan: review symptoms",
                  body: "Plan: review symptoms",
                  comments: [],
                  highlights: [],
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.endsWith("/api/entries") && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              entry: { id: "entry-new", version: 1, patientId: "patient-1" },
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ error: `unmocked ${url}` }), { status: 404 });
      }),
    );
  });

  afterEach(() => {
    cleanup();
    careEvents.clear();
    vi.unstubAllGlobals();
  });

  it("refreshes glance and timeline when a note is saved", async () => {
    const otherPatient = vi.fn();
    const stop = subscribePatientRefresh("patient-other", otherPatient);
    render(createElement(I18nProvider, null, createElement(Workspace)));

    await screen.findByTestId("recency-score");
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() => {
      expect(screen.getByTestId("refresh-tick").textContent).toBe("1");
      expect(screen.getByText("Plan: follow up")).toBeTruthy();
    });
    expect(screen.getByText("Plan: follow up")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Plan: follow up/i }).getAttribute("href")).toContain(
      "highlightAction=true",
    );
    expect(otherPatient).not.toHaveBeenCalled();
    stop();
  });

  it("notifyEntryChanged only refreshes the matching patient", () => {
    const matched = vi.fn();
    const ignored = vi.fn();
    const stopMatch = subscribePatientRefresh("patient-1", matched);
    const stopIgnore = subscribePatientRefresh("patient-2", ignored);
    notifyEntryChanged({ patientId: "patient-1", entryId: "e9", reason: "updated" });
    expect(matched).toHaveBeenCalledOnce();
    expect(ignored).not.toHaveBeenCalled();
    stopMatch();
    stopIgnore();
  });
});

describe("search result navigation", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("makes each result card a link to the timeline entry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            results: [
              {
                id: "entry-42",
                title: "Chest pain review",
                encounterAt: new Date().toISOString(),
                patientFacingSummary: "Symptoms reviewed",
                body: "chest pain",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    render(
      createElement(
        I18nProvider,
        null,
        createElement(SearchView, {
          patientId: "patient-1",
          userId: "clinician-1",
          role: "CLINICIAN",
        }),
      ),
    );

    const link = await screen.findByRole("link", { name: /Chest pain review/i });
    expect(link.getAttribute("href")).toBe("/timeline?entryId=entry-42");
  });
});

describe("timeline detail modal and inline risk highlighting", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("highlights risk phrases, color-codes badges, and opens revision history", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            entries: [
              {
                id: "e1",
                title: "ED triage",
                encounterAt: new Date().toISOString(),
                version: 3,
                status: "FINAL",
                authorRole: "CLINICIAN",
                authorName: "Casey Clinician",
                patientFacingSummary: "chest pain and cough",
                body: "chest pain and cough",
                comments: [{ id: "c1", authorRole: "STAFF", body: "Nurse handoff", createdAt: new Date().toISOString() }],
                highlights: [
                  { id: "h1", excerpt: "chest pain", label: "CRITICAL", provenancePointer: null, startOffset: 0, endOffset: 10 },
                  { id: "h2", excerpt: "cough", label: "LOW", provenancePointer: null, startOffset: 15, endOffset: 20 },
                ],
                revisions: [
                  { version: 1, createdAt: new Date().toISOString(), editorRole: "CLINICIAN", summary: null, body: "v1 body", isCurrent: false },
                  { version: 2, createdAt: new Date().toISOString(), editorRole: "CLINICIAN", summary: null, body: "v2 body", isCurrent: false },
                  { version: 3, createdAt: new Date().toISOString(), editorRole: "CLINICIAN", summary: "current", body: "chest pain and cough", isCurrent: true },
                ],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    render(
      createElement(
        I18nProvider,
        null,
        createElement(TimelineView, {
          patientId: "patient-1",
          userId: "clinician-1",
          role: "CLINICIAN",
        }),
      ),
    );

    const critical = await screen.findByRole("button", { name: /CRITICAL: chest pain/i });
    expect(critical.className).toMatch(/risk-critical/);
    expect(screen.getByRole("button", { name: /LOW: cough/i }).className).toMatch(/risk-low/);
    expect(document.querySelector(".inline-risk-critical")?.textContent).toBe("chest pain");
    expect(screen.getByText("Clinician note")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "View revision history" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("v1 body")).toBeTruthy();
    expect(screen.getByText("v2 body")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Timestamp" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Internal comments" })).toBeNull();
    expect(screen.getAllByText("Nurse handoff")).toHaveLength(1);
  });

  it("distinguishes nursing notes from clinician notes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            entries: [
              {
                id: "staff-note",
                title: "Night shift",
                encounterAt: new Date().toISOString(),
                version: 1,
                status: "FINAL",
                authorRole: "STAFF",
                authorName: "Sam Staff",
                patientFacingSummary: "vitals stable",
                body: "vitals stable",
                comments: [],
                highlights: [],
                revisions: [{ version: 1, createdAt: new Date().toISOString(), editorRole: "STAFF", summary: "current", body: "vitals stable", isCurrent: true }],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    render(
      createElement(
        I18nProvider,
        null,
        createElement(TimelineView, {
          patientId: "patient-1",
          userId: "staff-1",
          role: "STAFF",
        }),
      ),
    );

    expect(await screen.findByText("Nursing note")).toBeTruthy();
    expect(document.querySelector(".timeline-item-staff")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Edit existing note" })).toBeTruthy();
  });
});

describe("role-switch login gate", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("clears the session and opens login instead of keeping the previous user", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/demo")) {
          return new Response(
            JSON.stringify({
              clinic: { name: "Nightingale" },
              users: [
                { id: "staff-1", name: "Museil Kamil", email: "staff@nightingale.test", role: "STAFF" },
                { id: "clin-1", name: "Joe Zhou", email: "clinician@nightingale.test", role: "CLINICIAN" },
              ],
              patients: [
                { id: "p1", name: "Elena Rossi", email: "elena.rossi@nightingale.test", phone: "5550101001" },
              ],
              patientId: "p1",
              featuredPatientId: "p1",
              defaultUserId: null,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ error: `unmocked ${url}` }), { status: 404 });
      }),
    );

    render(
      createElement(
        I18nProvider,
        null,
        createElement(
          CareShell,
          null,
          createElement(CarePage, {
            titleKey: "pages.timeline",
            children: ({ userId }: { userId: string }) =>
              createElement("p", { "data-testid": "session-user" }, userId),
          }),
        ),
      ),
    );

    const staffRole = await screen.findByRole("radio", { name: "STAFF" });
    expect(screen.getByText("Preparing clinic session…")).toBeTruthy();
    expect(screen.queryByTestId("session-user")).toBeNull();

    fireEvent.click(staffRole);
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByLabelText("Employee code")).toBeTruthy();
    expect(screen.getByText("Preparing clinic session…")).toBeTruthy();
    expect(screen.queryByTestId("session-user")).toBeNull();
    expect(screen.queryByRole("link", { name: "Note editor" })).toBeNull();
  });
});
