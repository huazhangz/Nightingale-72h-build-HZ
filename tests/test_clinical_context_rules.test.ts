import { describe, expect, it } from "vitest";
import {
  classifyMentionContext,
  findLocalRiskPhrases,
  findTermMentions,
} from "../src/lib/care-note/keyword-highlights";
import { SEEDED_NOTES } from "../prisma/clinical-notes";

function labelsOf(body: string): Record<string, string> {
  return Object.fromEntries(findLocalRiskPhrases(body).map((hit) => [hit.excerpt.toLowerCase(), hit.label]));
}

function contextOf(body: string, phrase: string): string {
  const mention = findTermMentions(body).find((item) => item.excerpt.toLowerCase() === phrase);
  if (!mention) {
    throw new Error(`no mention of ${phrase}`);
  }
  return mention.context;
}

describe("spec §2 negation (NegEx)", () => {
  it.each([
    ["Patient denies chest pain.", "chest pain"],
    ["No chest pain on exertion.", "chest pain"],
    ["Negative for shortness of breath today.", "shortness of breath"],
    ["Walked the corridor without shortness of breath.", "shortness of breath"],
    ["ACS ruled out chest pain was musculoskeletal.", "chest pain"],
    ["She denied fever overnight.", "fever"],
  ])("negates %j", (body, phrase) => {
    expect(contextOf(body, phrase)).toBe("NEGATED");
    expect(labelsOf(body)[phrase]).toBeUndefined();
  });

  it("negates every item of a coordinated list after one trigger", () => {
    const body = "He denies chest pain, hyperpyrexia, or new allergy.";
    expect(contextOf(body, "chest pain")).toBe("NEGATED");
    expect(contextOf(body, "hyperpyrexia")).toBe("NEGATED");
    expect(contextOf(body, "allergy")).toBe("NEGATED");
    expect(findLocalRiskPhrases(body)).toEqual([]);
  });

  it("only looks back five counted words", () => {
    const body = "No complaints on arrival to the ward overnight, chest pain began at dawn.";
    expect(contextOf(body, "chest pain")).toBe("AFFIRMED");
  });

  it("ends negation at a comma followed by 'and' but continues through ', or'", () => {
    const body = "She describes residual ache, one night of fever without hyperpyrexia, and nausea after tablets.";
    expect(contextOf(body, "hyperpyrexia")).toBe("NEGATED");
    expect(contextOf(body, "nausea")).toBe("AFFIRMED");
    expect(contextOf("He denies chest pain, hyperpyrexia, or new allergy.", "allergy")).toBe("NEGATED");
    expect(contextOf("No fever and no cough.", "fever")).toBe("NEGATED");
  });

  it("stops at scope terminators and sentence boundaries", () => {
    expect(contextOf("No fever but chest pain since morning.", "chest pain")).toBe("AFFIRMED");
    expect(contextOf("No fever. Chest pain since morning.", "chest pain")).toBe("AFFIRMED");
  });

  it("does not treat a decimal point as a sentence boundary", () => {
    expect(contextOf("Temp 38.5 without fever symptoms.", "fever")).toBe("NEGATED");
  });

  it("highlights the first affirmed mention when the first mention is negated", () => {
    const body = "Denies chest pain at rest. Later reports chest pain on stairs.";
    const [hit] = findLocalRiskPhrases(body);
    expect(hit?.label).toBe("CRITICAL");
    expect(body.slice(hit!.startOffset)).toMatch(/^chest pain on stairs/);
  });
});

describe("spec §2 historical demotion", () => {
  it.each([
    ["History of chest pain in 2019.", "chest pain"],
    ["Family history of anaphylaxis to nuts.", "anaphylaxis"],
    ["Past history includes fever of unknown origin.", "fever"],
  ])("demotes %j to INFO", (body, phrase) => {
    expect(contextOf(body, phrase)).toBe("HISTORICAL");
    expect(labelsOf(body)[phrase]).toBe("INFO");
  });

  it("lets negation dominate: 'no history of' is negated", () => {
    expect(contextOf("No history of chest pain.", "chest pain")).toBe("NEGATED");
  });

  it("prefers an affirmed mention over an earlier historical one", () => {
    const body = "History of chest pain. Today: crushing chest pain radiating to the arm.";
    const [hit] = findLocalRiskPhrases(body);
    expect(hit?.label).toBe("CRITICAL");
    expect(hit?.context).toBe("AFFIRMED");
  });
});

describe("v1.1 hypothetical / safety-net demotion", () => {
  it.each([
    ["If chest pain recurs she will call emergency services.", "chest pain"],
    ["Red flags discussed: recurrent chest pain at rest.", "chest pain"],
    ["Return sooner if fever returns.", "fever"],
  ])("demotes %j to INFO", (body, phrase) => {
    expect(contextOf(body, phrase)).toBe("HYPOTHETICAL");
    expect(labelsOf(body)[phrase]).toBe("INFO");
  });
});

describe("spec §1 critical terms and severe vitals", () => {
  it("flags anaphylaxis and severe respiratory distress as CRITICAL", () => {
    const labels = labelsOf("Developed anaphylaxis with severe respiratory distress.");
    expect(labels.anaphylaxis).toBe("CRITICAL");
    expect(labels["severe respiratory distress"]).toBe("CRITICAL");
  });

  it("flags SpO2 below 90% but not 90% or above", () => {
    const low = findLocalRiskPhrases("SpO2 86% on room air.");
    expect(low).toHaveLength(1);
    expect(low[0]).toMatchObject({ label: "CRITICAL", termKey: "vital:spo2<90" });
    expect(findLocalRiskPhrases("Saturations 93% on air.")).toEqual([]);
    expect(findLocalRiskPhrases("SpO2 90% after nebuliser.")).toEqual([]);
  });

  it("flags blood pressure above 180/110 but not 138/84", () => {
    expect(findLocalRiskPhrases("BP 192/104 in triage.")[0]?.termKey).toBe("vital:bp>180/110");
    expect(findLocalRiskPhrases("Blood pressure 170/118.")[0]?.label).toBe("CRITICAL");
    expect(findLocalRiskPhrases("Blood pressure 138/84.")).toEqual([]);
  });
});

describe("classifier API", () => {
  it("classifies an arbitrary span without lexicon context", () => {
    const body = "Patient denies palpitations.";
    expect(classifyMentionContext(body, body.indexOf("palpitations"))).toBe("NEGATED");
  });
});

describe("seeded clinical notes (regression)", () => {
  it("no longer flags negated red-flag phrases in the Elena Rossi note", () => {
    const body = SEEDED_NOTES["elena.rossi@nightingale.test"]!;
    const hits = findLocalRiskPhrases(body);
    const hyperpyrexia = hits.find((hit) => hit.excerpt.toLowerCase() === "hyperpyrexia");
    // "She denies hyperpyrexia" is negated; the only other mention is conditional advice, so the
    // phrase survives only as a demoted INFO span and never reaches the CRITICAL floor.
    expect(hyperpyrexia?.label).toBe("INFO");
    expect(hyperpyrexia?.context).toBe("HYPOTHETICAL");
    const chestPain = hits.find((hit) => hit.excerpt.toLowerCase() === "chest pain");
    expect(chestPain?.label).toBe("CRITICAL");
    expect(body.slice(chestPain!.startOffset - 20, chestPain!.endOffset)).toMatch(/episode of chest pain/);
  });

  it("produces deterministic output for every seeded note", () => {
    for (const body of Object.values(SEEDED_NOTES)) {
      expect(findLocalRiskPhrases(body)).toEqual(findLocalRiskPhrases(body));
    }
  });
});
