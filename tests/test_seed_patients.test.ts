import { describe, expect, it } from "vitest";
import { prisma } from "../src/lib/db";
import { verifyPatientLogin, verifyStaffLogin } from "../src/lib/auth/login";
import { getPatientTimeline } from "../src/lib/care-note/timeline";

const FEATURED_EMAILS = [
  "elena.rossi@nightingale.test",
  "james.okonkwo@nightingale.test",
  "sofia.alvarez@nightingale.test",
  "lars.johansson@nightingale.test",
  "amara.diallo@nightingale.test",
  "noah.williams@nightingale.test",
  "pierre.dubois@nightingale.test",
  "aisha.mensah@nightingale.test",
  "mateo.silva@nightingale.test",
  "hannah.berg@nightingale.test",
];

describe("seeded virtual patients", () => {
  it("includes 10 diverse patients plus Museil Kamil and Joe Zhou", async () => {
    const patients = await prisma.user.findMany({
      where: { email: { in: FEATURED_EMAILS } },
      include: { patientEntries: true },
    });
    expect(patients).toHaveLength(10);

    const featured = patients.find((user) => user.email === "elena.rossi@nightingale.test");
    expect(featured?.name).toBe("Elena Rossi");
    expect(featured?.phone).toBe("5550101001");
    expect(featured?.dateOfBirth).toBe("1984-03-12");
    expect(featured?.patientEntries.length).toBeGreaterThan(0);

    for (const patient of patients) {
      expect(patient.patientEntries.length).toBeGreaterThan(0);
      const logs = await prisma.auditLog.count({
        where: { entityId: { in: patient.patientEntries.map((entry) => entry.id) } },
      });
      expect(logs).toBeGreaterThan(0);
    }

    const login = await verifyPatientLogin({
      fullName: "Elena Rossi",
      phone: "555-010-1001",
      dateOfBirth: "1984-03-12",
    });
    expect(login?.id).toBe(featured?.id);

    const staff = await verifyStaffLogin({
      role: "STAFF",
      employeeCode: "00001",
      verification: "00001",
    });
    const clinician = await verifyStaffLogin({
      role: "CLINICIAN",
      employeeCode: "00002",
      verification: "00002",
    });
    expect(staff?.role).toBe("STAFF");
    expect(clinician?.role).toBe("CLINICIAN");

    const staffUser = await prisma.user.findUniqueOrThrow({
      where: { email: "staff@nightingale.test" },
    });
    const clinicianUser = await prisma.user.findUniqueOrThrow({
      where: { email: "clinician@nightingale.test" },
    });
    expect(staffUser.name).toBe("Museil Kamil");
    expect(clinicianUser.name).toBe("Joe Zhou");

    const timeline = await getPatientTimeline(featured!.id, {
      id: featured!.id,
      role: "PATIENT",
      clinicId: featured!.clinicId,
    });
    const patientEntry = timeline.find((entry) =>
      entry.patientFacingSummary.includes("blood pressure review"),
    );
    expect(patientEntry?.body).toBeUndefined();
    expect(patientEntry?.comments).toBeUndefined();
    expect(patientEntry?.patientFacingSummary).toBe("Your blood pressure review is underway.");
    expect(JSON.stringify(patientEntry)).not.toMatch(/Nursing staff/);
    expect(JSON.stringify(patientEntry)).not.toMatch(/systolic remains above target/);

    for (const patient of patients) {
      for (const entry of patient.patientEntries) {
        expect(entry.body.trim().split(/\s+/).length).toBeGreaterThanOrEqual(200);
      }
    }
    const keywords = ["chest pain", "shortness of breath", "fever", "nausea", "hyperpyrexia", "allergy"];
    const corpus = patients.flatMap((patient) => patient.patientEntries.map((entry) => entry.body)).join("\n");
    for (const keyword of keywords) {
      expect(corpus.toLowerCase()).toContain(keyword);
    }
  });
});
