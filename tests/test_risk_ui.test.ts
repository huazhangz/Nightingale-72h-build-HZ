// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const routerMock = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams("next=/timeline"),
  usePathname: () => "/login",
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: unknown }) => createElement("a", { href, ...props }, children as never),
}));

import { RiskPanel } from "../src/components/care/RiskPanel";
import { LoginForm, safeNext } from "../src/components/auth/AuthForms";
import { I18nProvider } from "../src/lib/i18n/I18nContext";
import type { PatientRiskView } from "../src/lib/agent/risk/repository";

const VIEW: PatientRiskView = {
  pending: false,
  stale: false,
  lastError: null,
  assessment: {
    id: "ra-1",
    method: "agent",
    level: "HIGH",
    assessedLevel: "HIGH",
    modelLevel: "MEDIUM",
    floorLevel: "HIGH",
    review: "WITHIN_4H",
    confidence: "medium",
    summary: "Exertional chest pain awaiting troponin.",
    drivers: [
      {
        factor: "Exertional chest pain",
        direction: "raises",
        citations: [{ noteId: "note-aaaaaa111111", quote: "reports chest pain on exertion", title: "Chest pain review", encounterAt: "2026-11-20T09:00:00.000Z" }],
      },
    ],
    floorReasons: [
      { rule: "term:chest pain", label: "Chest pain", level: "HIGH", noteId: "note-aaaaaa111111", title: "Chest pain review", encounterAt: "2026-11-20T09:00:00.000Z", excerpt: "chest pain", source: "rule-engine" },
    ],
    hiddenEvidence: 1,
    report: { modelLevel: "MEDIUM", floorLevel: "HIGH", floorApplied: true, reviewTightened: true, rejectedDrivers: [], unsupportedLevel: false, summaryRejected: false },
    trigger: "NOTE_CREATED",
    assessedAt: "2026-11-21T10:00:00.000Z",
    override: null,
  },
};

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const result = handler(url, init);
      return new Response(JSON.stringify(result ?? { error: "unmocked" }), { status: result ? 200 : 404 });
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  routerMock.replace.mockReset();
});

describe("RiskPanel", () => {
  it("shows level, review window, cited drivers and the safety-rule raise", async () => {
    mockFetch(() => VIEW);
    render(createElement(I18nProvider, null, createElement(RiskPanel, { patientId: "p1", role: "STAFF" })));
    expect(await screen.findByText("Exertional chest pain awaiting troponin.")).toBeTruthy();
    expect(screen.getAllByText("High").length).toBeGreaterThan(0);
    expect(screen.getByText("Review within 4 h")).toBeTruthy();
    expect(screen.getByText("Raised from Medium by safety rules")).toBeTruthy();
    expect(screen.getByText(/1 item\(s\) of evidence come from notes your role cannot open/)).toBeTruthy();
    const source = screen.getAllByRole("link", { name: /Note #111111/ })[0] as HTMLAnchorElement;
    expect(source.getAttribute("href")).toBe("/timeline?entryId=note-aaaaaa111111");
    // Nurses see the level but cannot override it.
    expect(screen.queryByRole("button", { name: "Override level" })).toBeNull();
  });

  it("lets clinicians reassess and override with a reason", async () => {
    const calls = mockFetch((url, init) => {
      if (url.endsWith("/risk/override")) {
        return { ...VIEW, assessment: { ...VIEW.assessment!, level: "CRITICAL", override: { level: "CRITICAL", reason: "Pain at rest on arrival", by: "Joe Zhou", at: "2026-11-21T10:05:00.000Z" } } };
      }
      return init?.method === "POST" ? { ...VIEW, assessment: { ...VIEW.assessment!, trigger: "MANUAL" } } : VIEW;
    });
    render(createElement(I18nProvider, null, createElement(RiskPanel, { patientId: "p1", role: "CLINICIAN" })));
    fireEvent.click(await screen.findByRole("button", { name: "Reassess" }));
    await waitFor(() => expect(calls.some((call) => call.url === "/api/patients/p1/risk" && call.method === "POST")).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Override level" }));
    fireEvent.change(screen.getByLabelText("Override level"), { target: { value: "CRITICAL" } });
    fireEvent.change(screen.getByLabelText("Reason (required)"), { target: { value: "Pain at rest on arrival" } });
    fireEvent.click(screen.getByRole("button", { name: "Save override" }));
    expect(await screen.findByText(/Set to Critical by Joe Zhou: Pain at rest on arrival/)).toBeTruthy();
    expect(calls.find((call) => call.url.endsWith("/risk/override"))?.body).toEqual({ level: "CRITICAL", reason: "Pain at rest on arrival" });
  });
});

describe("LoginForm", () => {
  it("only follows same-site relative redirects after sign-in", () => {
    expect(safeNext("/timeline")).toBe("/timeline");
    expect(safeNext("//evil.example/x")).toBe("/patients");
    expect(safeNext("https://evil.example")).toBe("/patients");
    expect(safeNext(null, "PATIENT")).toBe("/glance");
  });

  it("signs in with email and password and offers demo shortcuts only when served", async () => {
    const calls = mockFetch((url) => {
      if (url === "/api/auth/demo-accounts") {
        return { accounts: [{ email: "clinician@nightingale.test", name: "Joe Zhou", role: "CLINICIAN", password: "Nightingale-Demo-2026" }] };
      }
      if (url === "/api/auth/login") {
        return { user: { id: "u1", role: "CLINICIAN", name: "Joe Zhou" } };
      }
      return null;
    });
    render(createElement(I18nProvider, null, createElement(LoginForm)));
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "clinician@nightingale.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "Nightingale-Demo-2026" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/timeline"));
    expect(calls.find((call) => call.url === "/api/auth/login")?.body).toEqual({ email: "clinician@nightingale.test", password: "Nightingale-Demo-2026" });
    expect(await screen.findByRole("button", { name: /Joe Zhou/ })).toBeTruthy();
  });
});
