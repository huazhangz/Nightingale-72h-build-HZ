import { prisma } from "../db";
import { CONSULTATION_STAGES, stageIndex } from "./transparency-utils";

export type AssignedClinician = {
  name: string;
  title: string;
  department: string;
};

export { CONSULTATION_STAGES, stageIndex };

export async function resolveAssignedClinician(clinicId: string): Promise<AssignedClinician> {
  const clinician = await prisma.user.findFirst({
    where: { clinicId, role: "CLINICIAN" },
    orderBy: { employeeCode: "asc" },
  });
  return {
    name: clinician?.name ?? "Attending clinician",
    title: clinician?.title ?? "Attending Physician",
    department: clinician?.department ?? "Internal Medicine",
  };
}
