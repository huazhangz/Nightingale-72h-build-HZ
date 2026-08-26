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
              unresolvedActions: glanceLoads > 1 ? [{ id: "a1", kind: "plan", text: "Plan: follow up" }] : [],
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
