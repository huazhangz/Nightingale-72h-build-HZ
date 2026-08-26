import { describe, expect, it } from "vitest";
import { riskBadgeClass, riskTone } from "../src/lib/care-note/risk-tone";

describe("risk tone mapping", () => {
  it("maps critical, medium, and low labels onto distinct badge classes", () => {
    expect(riskTone("CRITICAL")).toBe("critical");
    expect(riskTone("HIGH")).toBe("critical");
    expect(riskTone("MEDIUM")).toBe("medium");
    expect(riskTone("WARNING")).toBe("medium");
    expect(riskTone("LOW")).toBe("low");
    expect(riskTone("INFO")).toBe("low");
    expect(riskTone("UNRESOLVED_ACTION")).toBe("action");
    expect(riskTone("PATIENT_INSIGHT")).toBe("insight");
    expect(riskBadgeClass("HIGH")).toBe("risk-badge risk-critical");
    expect(riskBadgeClass("WARNING")).toBe("risk-badge risk-medium");
    expect(riskBadgeClass("INFO")).toBe("risk-badge risk-low");
    expect(riskBadgeClass("UNRESOLVED_ACTION")).toBe("risk-badge risk-action");
    expect(riskBadgeClass("PATIENT_INSIGHT")).toBe("risk-badge risk-insight");
  });
});
