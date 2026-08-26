import { describe, expect, it } from "vitest";
import { recencyScore, RECENCY_FORMULA } from "../src/lib/care-note/recency";

describe("recency score", () => {
  it("uses exp(-ageDays / 14) scaled to 0–100", () => {
    const now = Date.parse("2026-08-27T00:00:00.000Z");
    expect(recencyScore(new Date("2026-08-27T00:00:00.000Z"), now)).toBe(100);
    expect(recencyScore(new Date("2026-08-13T00:00:00.000Z"), now)).toBe(37);
    expect(RECENCY_FORMULA).toBe("Score = exp(-ageDays / 14)");
  });
});
