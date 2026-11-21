import { SEEDED_NOTES } from "../../prisma/clinical-notes";
import type { EvalCase, NoteSpec } from "./types";

/**
 * Ten cases built on the demo seed notes. Each note mixes current findings with negated findings
 * ("denies chest pain") and safety-net advice ("call if chest pain recurs"), which is exactly where
 * a summariser — or the rule engine — goes wrong.
 *
 * Feedback rows are synthetic: the author labelled each engine highlight as a clinician would
 * (PIN/AGREE when it is a real current issue, DISAGREE when the engine misread negation or advice).
 * mustNotAssert lists phrases that never occur as a current finding in the note.
 */

function note(email: string, title: string, authorRole: NoteSpec["authorRole"], status: NoteSpec["status"], day: number, feedback: NoteSpec["feedback"]): NoteSpec {
  return {
    key: "main",
    title,
    authorRole,
    status,
    encounterAt: new Date(Date.UTC(2026, 10, day, 10, 0, 0)).toISOString(),
    body: SEEDED_NOTES[email]!,
    feedback,
  };
}

const NO_FOLLOWUP_EXPECTATION = { expected: "any" as const };

export const SEEDED_CASES: EvalCase[] = [
  {
    id: "seed-elena-bp",
    tags: ["seeded", "negation", "safety-net"],
    description: "Hypertension review: real exertional chest pain; shortness of breath only negated or in red-flag advice.",
    readerRole: "CLINICIAN",
    notes: [
      note("elena.rossi@nightingale.test", "Blood pressure follow-up", "STAFF", "SUBMITTED", 14, [
        { excerpt: "chest pain", verdict: "PIN" },
        { excerpt: "nausea", verdict: "AGREE" },
        { excerpt: "allergy", verdict: "AGREE" },
        { excerpt: "shortness of breath", verdict: "DISAGREE" },
        { excerpt: "fever", verdict: "DISAGREE" },
      ]),
    ],
    expect: {
      mustCover: [
        { id: "bp-control", noteKey: "main", anyOf: ["blood pressure", "hypertension", "systolic"], provenance: "author" },
        { id: "penicillin", noteKey: "main", anyOf: ["penicillin"], provenance: "author" },
      ],
      mustNotAssert: [
        { id: "sob", anyOf: ["shortness of breath"], reason: "negated" },
        { id: "hyperpyrexia", anyOf: ["hyperpyrexia"], reason: "negated" },
      ],
      forbiddenText: [],
      followups: NO_FOLLOWUP_EXPECTATION,
    },
  },
  {
    id: "seed-james-diabetes",
    tags: ["seeded", "negation"],
    description: "Diabetes review: chest pain denied and only in advice; mild exertional breathlessness is real.",
    readerRole: "CLINICIAN",
    notes: [
      note("james.okonkwo@nightingale.test", "Diabetes checkup", "CLINICIAN", "SUBMITTED", 15, [
        { excerpt: "shortness of breath", verdict: "AGREE" },
        { excerpt: "dizziness", verdict: "AGREE" },
        { excerpt: "nausea", verdict: "AGREE" },
        { excerpt: "chest pain", verdict: "DISAGREE" },
        { excerpt: "allergy", verdict: "DISAGREE" },
      ]),
    ],
    expect: {
      mustCover: [{ id: "metformin", noteKey: "main", anyOf: ["metformin"], provenance: "author" }],
      mustNotAssert: [
        { id: "chest-pain", anyOf: ["chest pain"], reason: "negated" },
        { id: "fever", anyOf: ["fever", "hyperpyrexia"], reason: "negated" },
        { id: "allergy", anyOf: ["allergy"], reason: "negated" },
      ],
      forbiddenText: [],
      followups: NO_FOLLOWUP_EXPECTATION,
    },
  },
  {
    id: "seed-sofia-postop",
    tags: ["seeded", "negation", "safety-net"],
    description: "Day-12 cholecystectomy: 'did not reach hyperpyrexia', no chest pain, embolus counselling only.",
    readerRole: "CLINICIAN",
    notes: [
      note("sofia.alvarez@nightingale.test", "Post-operative recovery", "CLINICIAN", "LOCKED", 16, [
        { excerpt: "nausea", verdict: "AGREE" },
        { excerpt: "hyperpyrexia", verdict: "DISAGREE" },
        { excerpt: "chest pain", verdict: "DISAGREE" },
        { excerpt: "shortness of breath", verdict: "DISAGREE" },
      ]),
    ],
    expect: {
      mustCover: [
        { id: "procedure", noteKey: "main", anyOf: ["cholecystectomy", "post-op", "postoperative", "post-operative", "surgery"], provenance: "author" },
      ],
      mustNotAssert: [
        { id: "hyperpyrexia", anyOf: ["hyperpyrexia"], reason: "negated" },
        { id: "chest-pain", anyOf: ["chest pain"], reason: "negated" },
        { id: "sob", anyOf: ["shortness of breath"], reason: "negated" },
        { id: "allergy", anyOf: ["allergy"], reason: "negated" },
      ],
      forbiddenText: [],
      followups: NO_FOLLOWUP_EXPECTATION,
    },
  },
  {
    id: "seed-lars-asthma",
    tags: ["seeded", "negation"],
    description: "Asthma exacerbation: breathlessness and birch allergy are real; ischaemic chest pain is denied.",
    readerRole: "CLINICIAN",
    notes: [
      note("lars.johansson@nightingale.test", "Asthma review", "STAFF", "DRAFT", 17, [
        { excerpt: "shortness of breath", verdict: "PIN" },
        { excerpt: "allergy", verdict: "AGREE" },
        { excerpt: "chest pain", verdict: "DISAGREE" },
        { excerpt: "nausea", verdict: "DISAGREE" },
      ]),
    ],
    expect: {
      mustCover: [
        { id: "asthma", noteKey: "main", anyOf: ["asthma"], provenance: "author" },
        { id: "steroid", noteKey: "main", anyOf: ["steroid"], provenance: "author" },
      ],
      mustNotAssert: [
        { id: "chest-pain", anyOf: ["chest pain"], reason: "negated" },
        { id: "fever", anyOf: ["fever", "hyperpyrexia"], reason: "negated" },
      ],
      forbiddenText: [],
      followups: NO_FOLLOWUP_EXPECTATION,
    },
  },
  {
    id: "seed-amara-antenatal",
    tags: ["seeded", "safety-net"],
    description: "28-week pregnancy: latex allergy matters; chest pain only negated or in advice.",
    readerRole: "CLINICIAN",
    notes: [
      note("amara.diallo@nightingale.test", "Antenatal checkup", "CLINICIAN", "SUBMITTED", 18, [
        { excerpt: "allergy", verdict: "PIN" },
        { excerpt: "nausea", verdict: "AGREE" },
        { excerpt: "shortness of breath", verdict: "DISAGREE" },
        { excerpt: "chest pain", verdict: "DISAGREE" },
      ]),
    ],
    expect: {
      mustCover: [
        { id: "latex", noteKey: "main", anyOf: ["latex"], provenance: "author" },
        { id: "gestation", noteKey: "main", anyOf: ["28 weeks", "pregnan", "antenatal", "gestation"], provenance: "author" },
      ],
      mustNotAssert: [
        { id: "chest-pain", anyOf: ["chest pain"], reason: "negated" },
        { id: "hyperpyrexia", anyOf: ["hyperpyrexia"], reason: "negated" },
      ],
      forbiddenText: [],
      followups: NO_FOLLOWUP_EXPECTATION,
    },
  },
  {
    id: "seed-noah-copd",
    tags: ["seeded", "negation"],
    description: "COPD: real pleuritic chest pain after coughing; stop self-bought codeine; fever denied.",
    readerRole: "CLINICIAN",
    notes: [
      note("noah.williams@nightingale.test", "COPD maintenance", "CLINICIAN", "SUBMITTED", 19, [
        { excerpt: "chest pain", verdict: "PIN" },
        { excerpt: "nausea", verdict: "AGREE" },
        { excerpt: "fever", verdict: "DISAGREE" },
        { excerpt: "allergy", verdict: "DISAGREE" },
      ]),
    ],
    expect: {
      mustCover: [
        { id: "codeine", noteKey: "main", anyOf: ["codeine"], provenance: "author" },
        { id: "copd", noteKey: "main", anyOf: ["copd"], provenance: "author" },
      ],
      mustNotAssert: [
        { id: "fever", anyOf: ["fever", "hyperpyrexia"], reason: "negated" },
        { id: "allergy", anyOf: ["allergy"], reason: "negated" },
      ],
      forbiddenText: [],
      followups: NO_FOLLOWUP_EXPECTATION,
    },
  },
  {
    id: "seed-pierre-mood",
    tags: ["seeded", "negation", "safety-net"],
    description: "Low mood: panic-linked breathlessness, no suicidal plan; chest pain and fever only screened for.",
    readerRole: "CLINICIAN",
    notes: [
      note("pierre.dubois@nightingale.test", "Mood follow-up", "STAFF", "SUBMITTED", 20, [
        { excerpt: "nausea", verdict: "AGREE" },
        { excerpt: "shortness of breath", verdict: "DISAGREE" },
        { excerpt: "chest pain", verdict: "DISAGREE" },
        { excerpt: "fever", verdict: "DISAGREE" },
        { excerpt: "allergy", verdict: "DISAGREE" },
      ]),
    ],
    expect: {
      mustCover: [
        { id: "suicidal", noteKey: "main", anyOf: ["suicid"], provenance: "author" },
        { id: "mood", noteKey: "main", anyOf: ["mood", "depress"], provenance: "author" },
      ],
      mustNotAssert: [
        { id: "chest-pain", anyOf: ["chest pain"], reason: "negated" },
        { id: "fever", anyOf: ["fever", "hyperpyrexia"], reason: "negated" },
      ],
      forbiddenText: [],
      followups: NO_FOLLOWUP_EXPECTATION,
    },
  },
  {
    id: "seed-aisha-gout",
    tags: ["seeded", "negation", "safety-net"],
    description: "Resolving gout: co-trimoxazole allergy; chest pain denied and only mentioned as a separate workup.",
    readerRole: "CLINICIAN",
    notes: [
      note("aisha.mensah@nightingale.test", "Gout flare review", "CLINICIAN", "SUBMITTED", 21, [
        { excerpt: "allergy", verdict: "PIN" },
        { excerpt: "nausea", verdict: "AGREE" },
        { excerpt: "chest pain", verdict: "DISAGREE" },
        { excerpt: "shortness of breath", verdict: "DISAGREE" },
      ]),
    ],
    expect: {
      mustCover: [
        { id: "gout", noteKey: "main", anyOf: ["gout"], provenance: "author" },
        { id: "cotrimoxazole", noteKey: "main", anyOf: ["trimoxazole"], provenance: "author" },
      ],
      mustNotAssert: [
        { id: "chest-pain", anyOf: ["chest pain"], reason: "negated" },
        { id: "sob", anyOf: ["shortness of breath"], reason: "negated" },
        { id: "hyperpyrexia", anyOf: ["hyperpyrexia"], reason: "negated" },
      ],
      forbiddenText: [],
      followups: NO_FOLLOWUP_EXPECTATION,
    },
  },
  {
    id: "seed-mateo-thyroid",
    tags: ["seeded", "safety-net"],
    description: "Thyroid review: 'we safety-netted chest pain, high fever, hyperpyrexia' is advice, not findings.",
    readerRole: "CLINICIAN",
    notes: [
      note("mateo.silva@nightingale.test", "Thyroid monitoring", "CLINICIAN", "LOCKED", 22, [
        { excerpt: "nausea", verdict: "AGREE" },
        { excerpt: "chest pain", verdict: "DISAGREE" },
        { excerpt: "shortness of breath", verdict: "DISAGREE" },
        { excerpt: "hyperpyrexia", verdict: "DISAGREE" },
        { excerpt: "fever", verdict: "DISAGREE" },
      ]),
    ],
    expect: {
      mustCover: [{ id: "levothyroxine", noteKey: "main", anyOf: ["levothyroxine"], provenance: "author" }],
      mustNotAssert: [
        { id: "chest-pain", anyOf: ["chest pain"], reason: "hypothetical" },
        { id: "sob", anyOf: ["shortness of breath"], reason: "negated" },
        { id: "fever", anyOf: ["fever", "hyperpyrexia"], reason: "negated" },
      ],
      forbiddenText: [],
      followups: NO_FOLLOWUP_EXPECTATION,
    },
  },
  {
    id: "seed-hannah-knee",
    tags: ["seeded", "safety-net"],
    description: "Knee OA: ibuprofen angioedema allergy is absolute; past hyperpyrexia episode resolved.",
    readerRole: "CLINICIAN",
    notes: [
      note("hannah.berg@nightingale.test", "Knee osteoarthritis", "STAFF", "SUBMITTED", 23, [
        { excerpt: "allergy", verdict: "PIN" },
        { excerpt: "hyperpyrexia", verdict: "AGREE" },
        { excerpt: "chest pain", verdict: "DISAGREE" },
        { excerpt: "shortness of breath", verdict: "DISAGREE" },
      ]),
    ],
    expect: {
      mustCover: [
        { id: "ibuprofen", noteKey: "main", anyOf: ["ibuprofen"], provenance: "author" },
        { id: "osteoarthritis", noteKey: "main", anyOf: ["osteoarthritis", "knee"], provenance: "author" },
      ],
      mustNotAssert: [
        { id: "chest-pain", anyOf: ["chest pain"], reason: "negated" },
        { id: "sob", anyOf: ["shortness of breath"], reason: "hypothetical" },
      ],
      forbiddenText: [],
      followups: NO_FOLLOWUP_EXPECTATION,
    },
  },
];
