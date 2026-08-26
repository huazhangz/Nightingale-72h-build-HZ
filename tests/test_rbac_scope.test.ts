import { describe, expect, it } from "vitest";
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
  canReadSection,
  type Actor,
} from "../src/lib/auth/rbac";
import { REDACTED, redactPhi } from "../src/lib/security/redact";

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
  });
});
