// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: unknown; className?: string }) =>
    createElement("a", { href, ...props }, children as never),
}));

import { HandoverPanel } from "../src/components/care/HandoverPanel";
import { I18nProvider } from "../src/lib/i18n/I18nContext";
import type { PublicRun } from "../src/lib/agent/handover/repository";

const RUN: PublicRun = {
  id: "run-1",
  status: "SUCCEEDED",
  outcome: "SUBMITTED",
  degraded: false,
  model: "claude-opus-5-5",
  servedModel: "claude-opus-5-5",
  fallbackUsed: false,
  promptVersion: "handover-v2",
  steps: 4,
  durationMs: 12_400,
  usage: { inputTokens: 9_000, outputTokens: 1_200, cacheReadTokens: 4_000, cacheWriteTokens: 0 },
  startedAt: "2026-11-21T10:00:00.000Z",
  finishedAt: "2026-11-21T10:00:12.400Z",
  errorKind: null,
  summary: {
    generatedAt: "2026-11-21T10:00:12.400Z",
    items: [
      {
        id: "S1",
        category: "active_problem",
        severity: "critical",
        modelSeverity: "warning",
        statement: "Exertional chest pain since Monday.",
        citations: [
          { noteId: "note-aaaaaa111111", quote: "reports chest pain on exertion", title: "Chest pain review", encounterAt: "2026-11-20T09:00:00.000Z" },
        ],
        origin: "model",
        flags: ["SEVERITY_UPGRADED"],
      },
      {
        id: "G1",
        category: "critical_finding",
        severity: "critical",
        statement: 'Flagged by the clinical safety rules: "SpO2 86%" (CRITICAL). Review this note.',
        citations: [{ noteId: "note-bbbbbb222222", quote: "SpO2 86%", title: "Night review", encounterAt: "2026-11-20T23:00:00.000Z" }],
        origin: "guardrail",
        flags: [],
      },
    ],
  },
  guardrail: {
    modelItemCount: 2,
    acceptedCount: 1,
    rejected: [{ index: 1, statement: "Troponin was elevated.", reason: "UNGROUNDED_QUOTE" }],
    droppedCitations: [],
    severityUpgrades: [{ itemId: "S1", from: "warning", findingId: "h1" }],
    injectedCritical: [{ itemId: "G1", findingId: "h2", noteId: "note-bbbbbb222222", excerpt: "SpO2 86%" }],
    requiredCriticalCount: 2,
    phiRedactions: 0,
  },
  proposals: [
    {
      id: "prop-1",
      ref: "P1",
      text: "Chase troponin and ECG results",
      kind: "lab_order",
      sourceNoteId: "note-aaaaaa111111",
      rationale: "Ordered today",
      status: "PROPOSED",
    },
  ],
};

function mockFetch(options: { available: boolean; latest?: PublicRun | null }) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
      if (url === "/api/agent/status") {
        return json({ available: options.available, client: "anthropic", model: "claude-opus-5-5", promptVersion: "handover-v2" });
      }
      if (url.endsWith("/handover") && method === "GET") {
        return json({ run: options.latest ?? null });
      }
      if (url.endsWith("/handover") && method === "POST") {
        return json({ run: RUN });
      }
      if (url === "/api/agent/proposals/prop-1") {
        return json({ proposal: { id: "prop-1", status: "ACCEPTED", careActionId: "act-1" } });
      }
      return json({ error: `unmocked ${url}` }, 404);
    }),
  );
  return calls;
}

function renderPanel() {
  return render(
    createElement(I18nProvider, null, createElement(HandoverPanel, { patientId: "patient-1", userId: "clinician-1" })),
  );
}

describe("HandoverPanel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("explains when the agent is not configured and offers no run button", async () => {
    mockFetch({ available: false });
    renderPanel();
    expect(await screen.findByText(/not configured/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /generate/i })).toBeNull();
  });

  it("generates a summary and makes every guardrail intervention visible", async () => {
    const calls = mockFetch({ available: true });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /generate handover summary/i }));

    expect(await screen.findByText("Exertional chest pain since Monday.")).toBeTruthy();
    expect(screen.getByText(/Raised from Warning/)).toBeTruthy();
    expect(screen.getByText("Added by safety rule")).toBeTruthy();
    expect(screen.getByText(/1 critical finding\(s\) added by safety rules/)).toBeTruthy();

    const source = screen.getAllByRole("link", { name: /Note #111111/ })[0] as HTMLAnchorElement;
    expect(source.getAttribute("href")).toBe("/timeline?entryId=note-aaaaaa111111");

    fireEvent.click(screen.getByRole("button", { name: /1 statement\(s\) removed/ }));
    expect(screen.getByText("Troponin was elevated.")).toBeTruthy();
    expect(screen.getByText(/quote not found in the note/)).toBeTruthy();

    expect(screen.getByTestId("handover-meta").textContent).toMatch(/claude-opus-5-5 · handover-v2 · 4 steps/);
    expect(calls.some((call) => call.url === "/api/patients/patient-1/handover" && call.method === "POST")).toBe(true);
  });

  it("creates an action only when a clinician accepts a proposal", async () => {
    const calls = mockFetch({ available: true, latest: RUN });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Add to actions" }));
    await waitFor(() => expect(screen.getByText("Added")).toBeTruthy());
    const decision = calls.find((call) => call.url === "/api/agent/proposals/prop-1");
    expect(decision?.body).toEqual({ decision: "accept" });
  });
});
