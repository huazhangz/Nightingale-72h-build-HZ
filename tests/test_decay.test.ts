import { describe, expect, it } from "vitest";
import { archiveFlagsForEntry } from "../src/lib/care-note/decay";

describe("data decay", () => {
  const now = Date.parse("2026-08-27T00:00:00.000Z");

  it("archives notes older than 30 days that are low-risk without open actions", () => {
    const flags = archiveFlagsForEntry({
      encounterAt: new Date("2026-07-01T00:00:00.000Z"),
      body: "Routine wellness visit. No acute complaints.",
      highlights: [{ excerpt: "fatigue", label: "LOW" }],
      nowMs: now,
    });
    expect(flags.archived).toBe(true);
    expect(flags.decayed).toBe(true);
  });

  it("keeps recent, high-risk, or unresolved notes active", () => {
    expect(
      archiveFlagsForEntry({
        encounterAt: new Date("2026-08-20T00:00:00.000Z"),
        body: "Routine wellness visit.",
        nowMs: now,
      }).archived,
    ).toBe(false);
    expect(
      archiveFlagsForEntry({
        encounterAt: new Date("2026-07-01T00:00:00.000Z"),
        body: "Chest pain review.",
        highlights: [{ excerpt: "chest pain", label: "CRITICAL" }],
        nowMs: now,
      }).archived,
    ).toBe(false);
    expect(
      archiveFlagsForEntry({
        encounterAt: new Date("2026-07-01T00:00:00.000Z"),
        body: "Plan: follow up next week.",
        nowMs: now,
      }).archived,
    ).toBe(false);
  });
});
