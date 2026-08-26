import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ForbiddenError,
  NoteSection,
  assertCanEditNote,
  assertCanReadAiScribedNote,
  assertCanReadInternalComments,
  assertCanReadRawNote,
  assertCanReadSection,
  assertCanWriteNote,
  assertClinicScope,
  assertPatientIsolation,
  canReadSection,
  type Actor,
} from "../src/lib/auth/rbac";
import { REDACTED, redactPhi } from "../src/lib/security/redact";
import { getGlanceCard } from "../src/lib/care-note/glance";
import { getPatientTimeline } from "../src/lib/care-note/timeline";
import { clearGlanceCache } from "../src/lib/cache/glanceCache";
import { prisma } from "../src/lib/db";
import { createNoteFixture, deleteNoteFixture } from "./helpers/fixtures";

const CLINIC_A = "clinic-a";
const CLINIC_B = "clinic-b";

const patient: Actor = { id: "u-patient", role: "PATIENT", clinicId: CLINIC_A };
const staff: Actor = { id: "u-staff", role: "STAFF", clinicId: CLINIC_A };
const clinician: Actor = { id: "u-clinician", role: "CLINICIAN", clinicId: CLINIC_A };
const staffOtherClinic: Actor = { id: "u-staff-b", role: "STAFF", clinicId: CLINIC_B };
const clinicianOtherClinic: Actor = {
  id: "u-clinician-b",
  role: "CLINICIAN",
  clinicId: CLINIC_B,
};

describe("PHI redaction", () => {
  it("redacts Singapore NRIC, phone numbers, and emails", () => {
    const input =
      "NRIC S1234567A FIN T1234567B phone +65 91234567 or 81234567 email jane.doe@clinic.sg";
    const output = redactPhi(input);

    expect(output).not.toMatch(/S1234567A/i);
    expect(output).not.toMatch(/T1234567B/i);
    expect(output).not.toMatch(/\+65\s*91234567/);
    expect(output).not.toMatch(/\b81234567\b/);
    expect(output).not.toMatch(/jane\.doe@clinic\.sg/i);
    expect(output).toContain(REDACTED);
  });

  it("is deterministic and redacts person names", () => {
    const input = "Mr John Tan NRIC S1234567A contacted via +65 91234567";
    expect(redactPhi(input)).toBe(redactPhi(input));
    expect(redactPhi(input)).not.toMatch(/John Tan/);
    expect(redactPhi("plain clinical observation without identifiers")).toBe(
      "plain clinical observation without identifiers",
    );
  });
});

describe("clinic-level boundary", () => {
  it("blocks staff and clinicians from other clinics", () => {
    expect(() => assertClinicScope(staffOtherClinic, CLINIC_A)).toThrow(ForbiddenError);
    expect(() => assertClinicScope(clinicianOtherClinic, CLINIC_A)).toThrow(ForbiddenError);
    expect(() => assertCanWriteNote(staffOtherClinic, "STAFF", CLINIC_A)).toThrow(
      ForbiddenError,
    );
    expect(() => assertCanWriteNote(clinicianOtherClinic, "CLINICIAN", CLINIC_A)).toThrow(
      ForbiddenError,
    );
  });

  it("allows in-clinic actors", () => {
    expect(() => assertClinicScope(staff, CLINIC_A)).not.toThrow();
    expect(() => assertClinicScope(clinician, CLINIC_A)).not.toThrow();
    expect(() => assertClinicScope(patient, CLINIC_A)).not.toThrow();
  });

  it("blocks a patient from another patient's record id", () => {
    expect(() => assertPatientIsolation(patient, patient.id)).not.toThrow();
    expect(() => assertPatientIsolation(patient, "other-patient")).toThrow(ForbiddenError);
    expect(() => assertPatientIsolation(staff, "any-patient")).not.toThrow();
  });
});

describe("staff and clinician write/edit isolation", () => {
  it("blocks staff from writing or editing clinician notes", () => {
    expect(() => assertCanWriteNote(staff, "CLINICIAN", CLINIC_A)).toThrow(ForbiddenError);
    expect(() =>
      assertCanEditNote(staff, { authorRole: "CLINICIAN", clinicId: CLINIC_A }),
    ).toThrow(ForbiddenError);
    expect(() =>
      assertCanEditNote(
        staff,
        { authorRole: "CLINICIAN", clinicId: CLINIC_A },
        { hasVersionSnapshot: true },
      ),
    ).toThrow(ForbiddenError);
  });

  it("blocks clinicians from writing staff notes or overwriting them without a snapshot", () => {
    expect(() => assertCanWriteNote(clinician, "STAFF", CLINIC_A)).toThrow(ForbiddenError);
    expect(() =>
      assertCanEditNote(clinician, { authorRole: "STAFF", clinicId: CLINIC_A }),
    ).toThrow(ForbiddenError);
    expect(() =>
      assertCanEditNote(clinician, { authorRole: "STAFF", clinicId: CLINIC_A }, {}),
    ).toThrow(/version snapshot/);
  });

  it("allows same-role writes and clinician edit of staff notes only with a version snapshot", () => {
    expect(() => assertCanWriteNote(staff, "STAFF", CLINIC_A)).not.toThrow();
    expect(() => assertCanWriteNote(clinician, "CLINICIAN", CLINIC_A)).not.toThrow();
    expect(() =>
      assertCanEditNote(staff, { authorRole: "STAFF", clinicId: CLINIC_A }),
    ).not.toThrow();
    expect(() =>
      assertCanEditNote(
        clinician,
        { authorRole: "STAFF", clinicId: CLINIC_A },
        { hasVersionSnapshot: true },
      ),
    ).not.toThrow();
  });
});

describe("patient cannot read internal or raw AI notes", () => {
  it("blocks patients from internal comments and raw AI-scribed notes", () => {
    expect(() => assertCanReadInternalComments(patient, CLINIC_A)).toThrow(ForbiddenError);
    expect(() =>
      assertCanReadAiScribedNote(patient, NoteSection.AI_DOCTOR_CONSULT_SUMMARY, CLINIC_A),
    ).toThrow(ForbiddenError);
    expect(() =>
      assertCanReadAiScribedNote(patient, NoteSection.AI_NURSE_CONSULT_SUMMARY, CLINIC_A),
    ).toThrow(ForbiddenError);
    expect(() => assertCanReadRawNote(patient, CLINIC_A)).toThrow(ForbiddenError);
    expect(canReadSection(patient, NoteSection.INTERNAL_COMMENT)).toBe(false);
    expect(canReadSection(patient, NoteSection.AI_DOCTOR_CONSULT_SUMMARY)).toBe(false);
    expect(canReadSection(patient, NoteSection.AI_NURSE_CONSULT_SUMMARY)).toBe(false);
    expect(canReadSection(patient, NoteSection.RAW_NOTE)).toBe(false);
  });

  it("allows patients to read only patient-facing summaries in clinic", () => {
    expect(() =>
      assertCanReadSection(patient, NoteSection.PATIENT_FACING_SUMMARY, CLINIC_A),
    ).not.toThrow();
    expect(canReadSection(patient, NoteSection.PATIENT_FACING_SUMMARY)).toBe(true);
    expect(() =>
      assertCanReadSection(patient, NoteSection.PATIENT_FACING_SUMMARY, CLINIC_B),
    ).toThrow(ForbiddenError);
  });

  it("allows clinicians to read AI-scribed notes and comments in clinic", () => {
    expect(() =>
      assertCanReadAiScribedNote(clinician, NoteSection.AI_DOCTOR_CONSULT_SUMMARY, CLINIC_A),
    ).not.toThrow();
    expect(() => assertCanReadInternalComments(clinician, CLINIC_A)).not.toThrow();
    expect(canReadSection(staff, NoteSection.AI_DOCTOR_CONSULT_SUMMARY)).toBe(false);
    expect(canReadSection(staff, NoteSection.AI_NURSE_CONSULT_SUMMARY)).toBe(true);
    expect(canReadSection(staff, NoteSection.INTERNAL_COMMENT)).toBe(true);
    expect(() =>
      assertCanReadAiScribedNote(staff, NoteSection.AI_DOCTOR_CONSULT_SUMMARY, CLINIC_A),
    ).toThrow(ForbiddenError);
  });
});

describe("patient payloads strip internal and AI-scribed content server-side", () => {
  let fixture: Awaited<ReturnType<typeof createNoteFixture>> & { staff?: { id: string } };

  beforeEach(async () => {
    clearGlanceCache();
    fixture = await createNoteFixture("rbac-patient-strip");
    fixture.staff = await prisma.user.create({
      data: {
        email: `staff-${fixture.clinic.slug}@nightingale.test`,
        name: "Sam Staff",
        role: "STAFF",
        passwordHash: "dev-only-not-a-real-hash",
        clinicId: fixture.clinic.id,
      },
    });
    await prisma.comment.create({
      data: {
        careEntryId: fixture.entry.id,
        authorId: fixture.staff.id,
        body: "Internal staff comment: follow-up CRP.",
      },
    });
    const excerpt = "cough and fever";
    const start = fixture.entry.body.indexOf(excerpt);
    await prisma.highlight.create({
      data: {
        careEntryId: fixture.entry.id,
        createdById: fixture.clinician.id,
        startOffset: start >= 0 ? start : 0,
        endOffset: start >= 0 ? start + excerpt.length : 5,
        excerpt,
        label: "risk",
        source: "MODEL",
        confidence: 0.92,
      },
    });
  });

  afterEach(async () => {
    clearGlanceCache();
    if (!fixture) {
      return;
    }
    await deleteNoteFixture({
      clinicId: fixture.clinic.id,
      userIds: [fixture.patient.id, fixture.clinician.id, fixture.staff!.id],
      entryId: fixture.entry.id,
    });
  });

  it("returns only a patient-facing summary field and omits comments, raw body, and MODEL highlights", async () => {
    const patientActor: Actor = {
      id: fixture.patient.id,
      role: "PATIENT",
      clinicId: fixture.clinic.id,
    };
    const [entry] = await getPatientTimeline(fixture.patient.id, patientActor);
    expect(entry.patientFacingSummary).toBeDefined();
    expect(entry.body).toBeUndefined();
    expect(entry.comments).toBeUndefined();
    expect(entry.highlights).toBeUndefined();
    expect(JSON.stringify(entry)).not.toMatch(/Internal staff comment/);
    expect(JSON.stringify(entry)).not.toMatch(/follow-up CRP/);
    expect(JSON.stringify(entry)).not.toMatch(/cough and fever/);

    const glance = await getGlanceCard(fixture.patient.id, patientActor);
    expect(glance.card.highestRiskHighlights).toEqual([]);
    expect(glance.card.unresolvedActions).toEqual([]);
    expect(JSON.stringify(glance.card)).not.toMatch(/Internal staff comment/);
  });
});
