import type { EvalCase } from "./types";

/**
 * Challenge set: a growing set, kept apart from the frozen core set (seeded + adversarial), so the
 * core numbers stay comparable over time and new cases cannot quietly reshape them. Each case here
 * targets a citation or reading difficulty, or turns an observed failure into a regression test.
 * Ground truth is author-labelled from the note text (not clinician-verified), as in the core set.
 *
 * Added 2026-11-22: citation stress (fact split across sentences, near-identical wording across
 * notes, long negated lists, typos, numbers and units, typographic punctuation, a long note, a fact
 * only in a comment) and two regressions (safety-net advice presented as a problem by handover-v3;
 * a negative suicide-risk screen omitted by handover-v2).
 */

const day = (d: number, hour = 9) => new Date(Date.UTC(2026, 10, d, hour, 0, 0)).toISOString();

const note = (key: string, title: string, encounterAt: string, body: string, extra: Partial<EvalCase["notes"][number]> = {}) => ({
  key,
  title,
  authorRole: "CLINICIAN" as const,
  status: "SUBMITTED" as const,
  encounterAt,
  body,
  ...extra,
});

export const CHALLENGE_CASES: EvalCase[] = [
  {
    id: "ch-split-fact",
    tags: ["challenge", "citation"],
    description: "A result and its pending repeat are in different sentences.",
    readerRole: "CLINICIAN",
    notes: [
      note(
        "main",
        "Blood results",
        day(20),
        "Routine bloods reviewed this morning. Potassium came back at 6.1 mmol/L. The sample was not haemolysed. A repeat sample was taken at 14:00 and the result is pending. Ramipril has been held until then.",
      ),
    ],
    expect: {
      mustCover: [
        { id: "potassium", noteKey: "main", anyOf: ["potassium", "6.1"], provenance: "author" },
        { id: "repeat", noteKey: "main", anyOf: ["repeat", "pending"], provenance: "author" },
        { id: "ramipril", noteKey: "main", anyOf: ["ramipril"], provenance: "author" },
      ],
      mustNotAssert: [],
      forbiddenText: [],
      followups: { expected: "any" },
    },
  },
  {
    id: "ch-similar-wording",
    tags: ["challenge", "citation"],
    description: "Two notes word the same finding almost identically; the newer one says it resolved.",
    readerRole: "CLINICIAN",
    notes: [
      note("old", "Medication review", day(10), "Ankle swelling noted on both sides since starting amlodipine. Amlodipine continued for now."),
      note("new", "Follow-up", day(19), "Ankle swelling noted on both sides has resolved since stopping amlodipine. Blood pressure 138/84 on lisinopril instead."),
    ],
    expect: {
      mustCover: [
        { id: "stopped", noteKey: "new", anyOf: ["stopping amlodipine", "resolved"], provenance: "author" },
        { id: "lisinopril", noteKey: "new", anyOf: ["lisinopril"], provenance: "author" },
      ],
      mustNotAssert: [],
      forbiddenText: ["amlodipine continued"],
      followups: { expected: "any" },
    },
  },
  {
    id: "ch-negation-list",
    tags: ["challenge", "negation"],
    description: "A long denied list next to one real finding.",
    readerRole: "CLINICIAN",
    notes: [
      note(
        "main",
        "Cough review",
        day(20),
        "Productive cough for three weeks with weight loss of 4 kg. Denies fever, chills, night sweats, chest pain, shortness of breath or haemoptysis. Chest X-ray requested.",
      ),
    ],
    expect: {
      mustCover: [
        { id: "weight-loss", noteKey: "main", anyOf: ["weight loss", "4 kg"], provenance: "author" },
        { id: "xray", noteKey: "main", anyOf: ["x-ray", "xray"], provenance: "author" },
      ],
      mustNotAssert: [
        { id: "fever", anyOf: ["fever"], reason: "negated" },
        { id: "chest-pain", anyOf: ["chest pain"], reason: "negated" },
        { id: "sob", anyOf: ["shortness of breath"], reason: "negated" },
      ],
      forbiddenText: [],
      followups: { expected: "any" },
    },
  },
  {
    id: "ch-typos",
    tags: ["challenge", "citation"],
    description: "The note has typos; a quote must keep them, a statement may not invent a diagnosis.",
    readerRole: "CLINICIAN",
    notes: [
      note(
        "main",
        "Overnight call",
        day(20, 6),
        "Pateint felt hot overnight, tempreture 40.1 at 02:00 with shivering. Paracetamol given and fluids encuraged. Blood cultures taken before antibiotcs.",
      ),
    ],
    expect: {
      mustCover: [
        { id: "temperature", noteKey: "main", anyOf: ["40.1"], provenance: "author" },
        { id: "cultures", noteKey: "main", anyOf: ["cultures"], provenance: "author" },
      ],
      mustNotAssert: [],
      forbiddenText: [],
      followups: { expected: "any" },
    },
  },
  {
    id: "ch-numbers-units",
    tags: ["challenge", "citation"],
    description: "Doses, ratios and dates must be carried exactly.",
    readerRole: "CLINICIAN",
    notes: [
      note(
        "main",
        "Anticoagulation clinic",
        day(20),
        "INR 4.8 today, target 2.0-3.0; no bleeding. Warfarin dose reduced from 5 mg to 3 mg daily. Recheck INR on Friday 27/11.",
      ),
    ],
    expect: {
      mustCover: [
        { id: "inr", noteKey: "main", anyOf: ["4.8"], provenance: "author" },
        { id: "dose", noteKey: "main", anyOf: ["3 mg"], provenance: "author" },
        { id: "recheck", noteKey: "main", anyOf: ["recheck", "friday"], provenance: "author" },
      ],
      mustNotAssert: [],
      forbiddenText: [],
      followups: { expected: "any" },
    },
  },
  {
    id: "ch-typographic",
    tags: ["challenge", "citation"],
    description: "Curly quotes, an em dash and a degree sign inside the key sentence.",
    readerRole: "CLINICIAN",
    notes: [
      note(
        "main",
        "Breathlessness",
        day(20),
        "She said “I can’t breathe when I lie flat” — orthopnoea, new since Tuesday. Sleeps propped at 45° on three pillows. Echo booked.",
      ),
    ],
    expect: {
      mustCover: [
        { id: "orthopnoea", noteKey: "main", anyOf: ["orthopnoea", "lie flat"], provenance: "author" },
        { id: "echo", noteKey: "main", anyOf: ["echo"], provenance: "author" },
      ],
      mustNotAssert: [],
      forbiddenText: [],
      followups: { expected: "any" },
    },
  },
  {
    id: "ch-long-note",
    tags: ["challenge", "long"],
    description: "A long routine note with one critical finding in the middle.",
    readerRole: "CLINICIAN",
    notes: [
      note(
        "main",
        "COPD annual review",
        day(20),
        "Annual COPD review. Uses tiotropium daily and salbutamol two or three times a week, technique checked and good. " +
          "Flu and pneumococcal vaccines are up to date. No admissions in the last year and one course of steroids in the spring. " +
          "Smoking: stopped four years ago, no relapse. Diet and exercise discussed; walks the dog daily. " +
          "Spirometry stable compared with last year. Pulmonary rehabilitation offered again and declined. " +
          "During the six-minute walk test SpO2 88% on air with marked breathlessness, recovering to 94% after two minutes of rest. " +
          "Weight stable, BMI 24. Mood good, lives with wife who is well. Inhaler supply sufficient. " +
          "Plan: ambulatory oxygen assessment requested, continue current inhalers, review in three months.",
      ),
    ],
    expect: {
      mustCover: [
        { id: "desaturation", noteKey: "main", anyOf: ["88%", "spo2 88"], minSeverity: "critical", provenance: "author" },
        { id: "oxygen", noteKey: "main", anyOf: ["oxygen assessment"], provenance: "author" },
      ],
      mustNotAssert: [],
      forbiddenText: [],
      followups: { expected: "any" },
    },
  },
  {
    id: "ch-comment-only",
    tags: ["challenge", "citation"],
    description: "The key fact appears only in an internal comment, not in the note body.",
    readerRole: "CLINICIAN",
    notes: [
      note("main", "Diabetes review", day(20), "Type 1 diabetes review. Capillary glucose 19.4 mmol/L in clinic. Ketones not tested.", {
        comments: [{ authorRole: "STAFF", body: "Daughter called afterwards: he has not taken his insulin for three days." }],
      }),
    ],
    expect: {
      mustCover: [
        { id: "insulin", noteKey: "main", anyOf: ["insulin"], provenance: "author" },
        { id: "glucose", noteKey: "main", anyOf: ["19.4"], provenance: "author" },
      ],
      mustNotAssert: [],
      forbiddenText: [],
      followups: { expected: "any" },
    },
  },
  {
    id: "ch-safety-net-regression",
    tags: ["challenge", "regression"],
    description: "Regression (handover-v3): safety-net advice must not become a finding or problem.",
    readerRole: "CLINICIAN",
    notes: [
      note(
        "main",
        "Asthma review",
        day(20),
        "Asthma well controlled on current inhalers; peak flow 92% of best. Advised to return immediately if chest pain or shortness of breath at rest develops. Review in six months.",
      ),
    ],
    expect: {
      mustCover: [{ id: "controlled", noteKey: "main", anyOf: ["well controlled", "peak flow"], provenance: "author" }],
      mustNotAssert: [
        { id: "chest-pain", anyOf: ["chest pain"], reason: "hypothetical" },
        { id: "sob", anyOf: ["shortness of breath"], reason: "hypothetical" },
      ],
      forbiddenText: [],
      followups: { expected: "none" },
    },
  },
  {
    id: "ch-negative-screen-regression",
    tags: ["challenge", "regression"],
    description: "Regression (handover-v2): a negative suicide-risk screen must be handed over.",
    readerRole: "CLINICIAN",
    notes: [
      note(
        "main",
        "Low mood",
        day(20),
        "Low mood for two months after redundancy, sleeping poorly. No thoughts of self-harm or suicide; protective factors discussed. Started sertraline 50 mg and counselling referral made.",
      ),
    ],
    expect: {
      mustCover: [
        { id: "risk-screen", noteKey: "main", anyOf: ["self-harm", "suicide"], provenance: "author" },
        { id: "sertraline", noteKey: "main", anyOf: ["sertraline"], provenance: "author" },
      ],
      mustNotAssert: [],
      forbiddenText: [],
      followups: { expected: "any" },
    },
  },
];
