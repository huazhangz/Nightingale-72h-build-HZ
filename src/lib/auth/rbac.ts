import type { Role } from "@prisma/client";

export class ForbiddenError extends Error {
  readonly code = "FORBIDDEN" as const;

  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

export type Actor = {
  id: string;
  role: Role;
  clinicId: string | null;
};

export const NoteSection = {
  AI_DOCTOR_CONSULT_SUMMARY: "AI_DOCTOR_CONSULT_SUMMARY",
  AI_NURSE_CONSULT_SUMMARY: "AI_NURSE_CONSULT_SUMMARY",
  RAW_NOTE: "RAW_NOTE",
  INTERNAL_COMMENT: "INTERNAL_COMMENT",
  PATIENT_FACING_SUMMARY: "PATIENT_FACING_SUMMARY",
  CLINICIAN_NOTE: "CLINICIAN_NOTE",
  STAFF_NOTE: "STAFF_NOTE",
} as const;

export type NoteSection = (typeof NoteSection)[keyof typeof NoteSection];

export const AI_SCRIBED_SECTIONS = [
  NoteSection.AI_DOCTOR_CONSULT_SUMMARY,
  NoteSection.AI_NURSE_CONSULT_SUMMARY,
] as const;

export type AiScribedSection = (typeof AI_SCRIBED_SECTIONS)[number];

export type NoteAuthorRole = Extract<Role, "STAFF" | "CLINICIAN">;

const PATIENT_READABLE_SECTIONS = new Set<NoteSection>([NoteSection.PATIENT_FACING_SUMMARY]);

const CLINICAL_SECTIONS = new Set<NoteSection>([
  NoteSection.AI_DOCTOR_CONSULT_SUMMARY,
  NoteSection.AI_NURSE_CONSULT_SUMMARY,
  NoteSection.RAW_NOTE,
  NoteSection.INTERNAL_COMMENT,
  NoteSection.PATIENT_FACING_SUMMARY,
  NoteSection.CLINICIAN_NOTE,
  NoteSection.STAFF_NOTE,
]);

export function assertClinicScope(actor: Actor, resourceClinicId: string): void {
  if (!resourceClinicId) {
    throw new ForbiddenError("Resource is missing clinic scope");
  }
  if (!actor.clinicId || actor.clinicId !== resourceClinicId) {
    throw new ForbiddenError("Clinic boundary violation");
  }
}

export function canReadSection(actor: Actor, section: NoteSection): boolean {
  if (actor.role === "PATIENT") {
    return PATIENT_READABLE_SECTIONS.has(section);
  }
  if (actor.role === "STAFF" || actor.role === "CLINICIAN" || actor.role === "ADMIN") {
    return CLINICAL_SECTIONS.has(section);
  }
  return false;
}

export function assertCanReadSection(
  actor: Actor,
  section: NoteSection,
  resourceClinicId: string,
): void {
  assertClinicScope(actor, resourceClinicId);
  if (!canReadSection(actor, section)) {
    throw new ForbiddenError(`Role ${actor.role} cannot read section ${section}`);
  }
}

export function assertCanReadInternalComments(actor: Actor, resourceClinicId: string): void {
  assertCanReadSection(actor, NoteSection.INTERNAL_COMMENT, resourceClinicId);
}

export function assertCanReadAiScribedNote(
  actor: Actor,
  section: AiScribedSection,
  resourceClinicId: string,
): void {
  assertCanReadSection(actor, section, resourceClinicId);
}

export function assertCanReadRawNote(actor: Actor, resourceClinicId: string): void {
  assertCanReadSection(actor, NoteSection.RAW_NOTE, resourceClinicId);
}

export function assertCanWriteNote(
  actor: Actor,
  targetNoteRole: NoteAuthorRole,
  resourceClinicId: string,
): void {
  assertClinicScope(actor, resourceClinicId);

  if (actor.role === "PATIENT") {
    throw new ForbiddenError("Patients cannot write clinical notes");
  }

  if (actor.role === "STAFF" && targetNoteRole === "CLINICIAN") {
    throw new ForbiddenError("Staff cannot write or edit clinician notes");
  }

  if (actor.role === "CLINICIAN" && targetNoteRole === "STAFF") {
    throw new ForbiddenError("Clinicians cannot write staff notes");
  }

  if (actor.role !== "STAFF" && actor.role !== "CLINICIAN" && actor.role !== "ADMIN") {
    throw new ForbiddenError(`Role ${actor.role} cannot write notes`);
  }

  if (actor.role === "STAFF" && targetNoteRole !== "STAFF") {
    throw new ForbiddenError("Staff can only write staff notes");
  }

  if (actor.role === "CLINICIAN" && targetNoteRole !== "CLINICIAN") {
    throw new ForbiddenError("Clinicians can only write clinician notes");
  }
}

/**
 * Clinicians may edit staff notes only after a version snapshot is taken.
 * Staff may never edit clinician notes.
 */
export function assertCanEditNote(
  actor: Actor,
  note: { authorRole: NoteAuthorRole; clinicId: string },
  options: { hasVersionSnapshot?: boolean } = {},
): void {
  assertClinicScope(actor, note.clinicId);

  if (actor.role === "PATIENT") {
    throw new ForbiddenError("Patients cannot edit notes");
  }

  if (actor.role === "STAFF" && note.authorRole === "CLINICIAN") {
    throw new ForbiddenError("Staff cannot write or edit clinician notes");
  }

  if (actor.role === "CLINICIAN" && note.authorRole === "STAFF") {
    if (!options.hasVersionSnapshot) {
      throw new ForbiddenError(
        "Clinicians cannot overwrite staff notes without a version snapshot",
      );
    }
    return;
  }

  if (actor.role === "STAFF" && note.authorRole === "STAFF") {
    return;
  }

  if (actor.role === "CLINICIAN" && note.authorRole === "CLINICIAN") {
    return;
  }

  if (actor.role === "ADMIN") {
    if (note.authorRole === "STAFF" && !options.hasVersionSnapshot) {
      throw new ForbiddenError("Cannot overwrite staff notes without a version snapshot");
    }
    return;
  }

  throw new ForbiddenError(`Role ${actor.role} cannot edit ${note.authorRole} notes`);
}
