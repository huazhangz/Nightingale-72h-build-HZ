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
  // Added 2026-11-23 (coverage breadth toward the 50-case target): medication changes across
  // encounters, allergies with reactions, pending results and incidental findings (follow-ups),
  // safeguarding, comment-only carer concerns, shorthand, family history, trends, discharge
  // instructions, dose changes, end-of-life wishes, communication, falls, diet, home oxygen.
  {
    id: "ch-latest-encounter",
    tags: ["challenge", "coverage"],
    description: "Two encounters: the newer one changes the antibiotic.",
    readerRole: "CLINICIAN",
    notes: [
      note("old", "Ear infection", day(15), "Otitis media in the right ear. Started amoxicillin for five days."),
      note("new", "Rash review", day(19), "Itchy rash on day three of amoxicillin. Switched to clarithromycin and amoxicillin allergy recorded."),
    ],
    expect: {
      mustCover: [
        { id: "clarithromycin", noteKey: "new", anyOf: ["clarithromycin"], provenance: "author" },
        { id: "rash", noteKey: "new", anyOf: ["rash"], provenance: "author" },
      ],
      mustNotAssert: [],
      forbiddenText: [],
      followups: { expected: "any" },
    },
  },
  {
    id: "ch-allergy-reaction",
    tags: ["challenge", "coverage"],
    description: "An allergy must be handed over with its reaction.",
    readerRole: "CLINICIAN",
    notes: [
      note("main", "Medication review", day(20), "Allergic to penicillin: anaphylaxis in 2012 requiring adrenaline. Currently well. Repeat prescriptions issued."),
    ],
    expect: {
      mustCover: [
        { id: "penicillin", noteKey: "main", anyOf: ["penicillin"], provenance: "author" },
      ],
      mustNotAssert: [],
      forbiddenText: [],
      followups: { expected: "any" },
    },
  },
  {
    id: "ch-pending-biopsy",
    tags: ["challenge", "coverage"],
    description: "A result is outstanding and should become a follow-up.",
    readerRole: "CLINICIAN",
    notes: [
      note("main", "Skin lesion", day(20), "Irregular pigmented lesion on the left shoulder. Punch biopsy taken today and histology is pending."),
    ],
    expect: {
      mustCover: [
        { id: "biopsy", noteKey: "main", anyOf: ["biopsy", "histology"], provenance: "author" },
      ],
      mustNotAssert: [],
      forbiddenText: [],
      followups: { expected: "some", anyOf: ["histology", "biopsy"] },
    },
  },
  {
    id: "ch-safeguarding",
    tags: ["challenge", "coverage"],
    description: "A safeguarding concern must not be lost.",
    readerRole: "CLINICIAN",
    notes: [
      note("main", "Child injury", day(20), "Child attended with bruises on both upper arms that do not fit the history given. Safeguarding referral made to the local team."),
    ],
    expect: {
      mustCover: [
        { id: "safeguarding", noteKey: "main", anyOf: ["safeguarding"], provenance: "author" },
      ],
      mustNotAssert: [],
      forbiddenText: [],
      followups: { expected: "any" },
    },
  },
  {
    id: "ch-medication-stopped",
    tags: ["challenge", "coverage"],
    description: "A stopped medicine and its replacement.",
    readerRole: "CLINICIAN",
    notes: [
      note("main", "Indigestion", day(20), "Stopped naproxen because of indigestion after meals. Started paracetamol regularly and omeprazole for four weeks."),
    ],
    expect: {
      mustCover: [
        { id: "naproxen", noteKey: "main", anyOf: ["naproxen"], provenance: "author" },
        { id: "omeprazole", noteKey: "main", anyOf: ["omeprazole"], provenance: "author" },
      ],
      mustNotAssert: [],
      forbiddenText: [],
      followups: { expected: "any" },
    },
  },
  {
    id: "ch-carer-comment",
    tags: ["challenge", "coverage"],
    description: "A carer's concern recorded only in a comment.",
    readerRole: "CLINICIAN",
    notes: [
      note("main", "Anticoagulation review", day(20), "INR 2.6 today, within range. Continue warfarin 4 mg daily.", { comments: [{ authorRole: "STAFF" as const, body: "Carer called afterwards: he has been forgetting doses of his warfarin this week." }] }),
    ],
    expect: {
      mustCover: [
        { id: "forgetting", noteKey: "main", anyOf: ["forgetting", "missed", "adherence"], provenance: "author" },
      ],
      mustNotAssert: [],
      forbiddenText: [],
      followups: { expected: "any" },
    },
  },
  {
    id: "ch-normal-vitals-negated",
    tags: ["challenge", "coverage"],
    description: "Normal observations with denied red flags.",
    readerRole: "CLINICIAN",
    notes: [
      note("main", "Check-up", day(20), "Denies chest pain or shortness of breath. BP 124/78, heart rate 72, SpO2 98% on air. Continue current treatment."),
    ],
    expect: {
      mustCover: [
        { id: "bp", noteKey: "main", anyOf: ["124/78"], provenance: "author" },
      ],
      mustNotAssert: [
        { id: "chest-pain", anyOf: ["chest pain"], reason: "negated" },
        { id: "sob", anyOf: ["shortness of breath"], reason: "negated" },
      ],
      forbiddenText: [],
      followups: { expected: "any" },
    },
  },
  {
    id: "ch-conditional-plan",
    tags: ["challenge", "coverage"],
    description: "A plan that depends on a pending result.",
    readerRole: "CLINICIAN",
    notes: [
      note("main", "Chest pain review", day(20), "Troponin sent at 10:00 and the result is pending. If the troponin is raised, admit under cardiology."),
    ],
    expect: {
      mustCover: [
        { id: "troponin", noteKey: "main", anyOf: ["troponin"], provenance: "author" },
      ],
      mustNotAssert: [],
      forbiddenText: [],
      followups: { expected: "any" },
    },
  },
  {
    id: "ch-two-problems",
    tags: ["challenge", "coverage"],
    description: "Two unrelated problems in one note.",
    readerRole: "CLINICIAN",
    notes: [
      note("main", "Review", day(20), "Gout flare in the left knee, colchicine started. Separately, a new mole on the back was referred for dermatology review."),
    ],
    expect: {
      mustCover: [
        { id: "gout", noteKey: "main", anyOf: ["gout"], provenance: "author" },
        { id: "mole", noteKey: "main", anyOf: ["mole", "dermatology"], provenance: "author" },
      ],
      mustNotAssert: [],
      forbiddenText: [],
      followups: { expected: "any" },
    },
  },
  {
    id: "ch-abbreviations",
    tags: ["challenge", "coverage"],
    description: "Abbreviated clinical shorthand.",
    readerRole: "CLINICIAN",
    notes: [
      note("main", "Breathlessness", day(20), "SOB on exertion x 3/7, CXR clear today. Rx salbutamol inhaler and review if no better."),
    ],
    expect: {
      mustCover: [
        { id: "cxr", noteKey: "main", anyOf: ["cxr"], provenance: "author" },
        { id: "salbutamol", noteKey: "main", anyOf: ["salbutamol"], provenance: "author" },
      ],
      mustNotAssert: [],
      forbiddenText: [],
      followups: { expected: "any" },
    },
  },
  {
    id: "ch-family-history",
    tags: ["challenge", "coverage"],
    description: "Family history drives a referral.",
    readerRole: "CLINICIAN",
    notes: [
      note("main", "Bowel symptoms", day(20), "Family history of bowel cancer in her father at age 52. Colonoscopy referral discussed and agreed."),
    ],
    expect: {
      mustCover: [
        { id: "colonoscopy", noteKey: "main", anyOf: ["colonoscopy"], provenance: "author" },
      ],
      mustNotAssert: [],
      forbiddenText: [],
      followups: { expected: "any" },
    },
  },
  {
    id: "ch-weight-trend",
    tags: ["challenge", "coverage"],
    description: "An unintentional weight loss trend.",
    readerRole: "CLINICIAN",
    notes: [
      note("main", "Weight review", day(20), "Weight 64 kg today, down from 71 kg three months ago without trying. Bloods and a chest X-ray requested."),
    ],
    expect: {
      mustCover: [
        { id: "weight", noteKey: "main", anyOf: ["64 kg", "71 kg"], provenance: "author" },
      ],
      mustNotAssert: [],
      forbiddenText: [],
      followups: { expected: "any" },
    },
  },
  {
    id: "ch-discharge-instructions",
    tags: ["challenge", "coverage"],
    description: "Discharge instructions with a dated review.",
    readerRole: "CLINICIAN",
    notes: [
      note("main", "Discharge summary", day(19), "Discharged after three days of intravenous antibiotics for leg cellulitis. Complete five more days of flucloxacillin. GP nurse to review the wound on Monday."),
    ],
    expect: {
      mustCover: [
        { id: "flucloxacillin", noteKey: "main", anyOf: ["flucloxacillin"], provenance: "author" },
        { id: "wound", noteKey: "main", anyOf: ["wound"], provenance: "author" },
      ],
      mustNotAssert: [],
      forbiddenText: [],
      followups: { expected: "any" },
    },
  },
  {
    id: "ch-dose-change",
    tags: ["challenge", "coverage"],
    description: "Two notes give different doses; the newer one is current.",
    readerRole: "CLINICIAN",
    notes: [
      note("old", "Heart failure clinic", day(10), "Bisoprolol 2.5 mg daily, tolerating well."),
      note("new", "Heart failure review", day(19), "Bisoprolol increased to 5 mg daily; heart rate 78."),
    ],
    expect: {
      mustCover: [
        { id: "dose", noteKey: "new", anyOf: ["5 mg"], provenance: "author" },
      ],
      mustNotAssert: [],
      forbiddenText: [],
      followups: { expected: "any" },
    },
  },
  {
    id: "ch-incidental-finding",
    tags: ["challenge", "coverage"],
    description: "An incidental finding needs surveillance.",
    readerRole: "CLINICIAN",
    notes: [
      note("main", "CT result", day(20), "CT chest shows an incidental 8 mm lung nodule. Repeat CT in six months has been requested."),
    ],
    expect: {
      mustCover: [
        { id: "nodule", noteKey: "main", anyOf: ["nodule"], provenance: "author" },
      ],
      mustNotAssert: [],
      forbiddenText: [],
      followups: { expected: "some", anyOf: ["ct", "nodule"] },
    },
  },
  {
    id: "ch-dnacpr",
    tags: ["challenge", "coverage"],
    description: "End-of-life wishes must be handed over.",
    readerRole: "CLINICIAN",
    notes: [
      note("main", "Palliative care visit", day(20), "Patient wishes to be cared for at home. DNACPR form completed and the original is kept in the house."),
    ],
    expect: {
      mustCover: [
        { id: "dnacpr", noteKey: "main", anyOf: ["dnacpr"], provenance: "author" },
      ],
      mustNotAssert: [],
      forbiddenText: [],
      followups: { expected: "any" },
    },
  },
  {
    id: "ch-interpreter",
    tags: ["challenge", "coverage"],
    description: "Communication needs.",
    readerRole: "CLINICIAN",
    notes: [
      note("main", "New patient", day(20), "Needs a Polish interpreter for every consultation; her daughter should not interpret. Booked for next visit."),
    ],
    expect: {
      mustCover: [
        { id: "interpreter", noteKey: "main", anyOf: ["interpreter"], provenance: "author" },
      ],
      mustNotAssert: [],
      forbiddenText: [],
      followups: { expected: "any" },
    },
  },
  {
    id: "ch-falls",
    tags: ["challenge", "coverage"],
    description: "Falls risk.",
    readerRole: "CLINICIAN",
    notes: [
      note("main", "Home visit", day(20), "Two falls at home in the last month, no injuries. Walking frame provided and occupational therapy referral made."),
    ],
    expect: {
      mustCover: [
        { id: "falls", noteKey: "main", anyOf: ["falls"], provenance: "author" },
      ],
      mustNotAssert: [],
      forbiddenText: [],
      followups: { expected: "any" },
    },
  },
  {
    id: "ch-diet",
    tags: ["challenge", "coverage"],
    description: "A strict dietary requirement.",
    readerRole: "CLINICIAN",
    notes: [
      note("main", "Coeliac review", day(20), "Coeliac disease, strict gluten-free diet, symptoms well controlled. Dietitian review booked for March."),
    ],
    expect: {
      mustCover: [
        { id: "gluten", noteKey: "main", anyOf: ["gluten"], provenance: "author" },
      ],
      mustNotAssert: [],
      forbiddenText: [],
      followups: { expected: "any" },
    },
  },
  {
    id: "ch-oxygen-home",
    tags: ["challenge", "coverage"],
    description: "Home oxygen and its safety rule.",
    readerRole: "CLINICIAN",
    notes: [
      note("main", "Respiratory review", day(20), "Home oxygen at 2 litres per minute for 16 hours a day. Smoking near the oxygen was discussed again; family confirms no one smokes indoors."),
    ],
    expect: {
      mustCover: [
        { id: "oxygen", noteKey: "main", anyOf: ["oxygen", "2 litres"], provenance: "author" },
      ],
      mustNotAssert: [],
      forbiddenText: [],
      followups: { expected: "any" },
    },
  },
];
