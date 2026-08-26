import { describe, expect, it } from "vitest";
import { prisma } from "../src/lib/db";
import { verifyPatientLogin, verifyStaffLogin } from "../src/lib/auth/login";

const FEATURED_EMAILS = [
  "zhang.wei@nightingale.test",
  "li.na@nightingale.test",
  "wang.fang@nightingale.test",
  "chen.hao@nightingale.test",
  "liu.min@nightingale.test",
  "zhao.lei@nightingale.test",
  "sun.mei@nightingale.test",
  "wu.jun@nightingale.test",
  "zhou.yan@nightingale.test",
  "huang.tao@nightingale.test",
  "lin.xia@nightingale.test",
  "gao.peng@nightingale.test",
  "xu.ting@nightingale.test",
  "ma.qiang@nightingale.test",
  "he.jing@nightingale.test",
];

describe("seeded virtual patients", () => {
  it("includes 15 patients with notes and audit logs, featuring Zhang Wei", async () => {
    const patients = await prisma.user.findMany({
      where: { email: { in: FEATURED_EMAILS } },
      include: { patientEntries: true },
    });
    expect(patients).toHaveLength(15);

    const featured = patients.find((user) => user.email === "zhang.wei@nightingale.test");
    expect(featured?.name).toBe("张伟 (Zhang Wei)");
    expect(featured?.phone).toBe("13812345678");
    expect(featured?.dateOfBirth).toBe("1985-06-15");
    expect(featured?.patientEntries.length).toBeGreaterThan(0);

    for (const patient of patients) {
      expect(patient.patientEntries.length).toBeGreaterThan(0);
      const logs = await prisma.auditLog.count({
        where: { entityId: { in: patient.patientEntries.map((entry) => entry.id) } },
      });
      expect(logs).toBeGreaterThan(0);
    }

    const login = await verifyPatientLogin({
      fullName: "Zhang Wei",
      phone: "138-1234-5678",
      dateOfBirth: "1985-06-15",
    });
    expect(login?.id).toBe(featured?.id);

    const staff = await verifyStaffLogin({
      role: "STAFF",
      employeeCode: "000001",
      verification: "demo",
    });
    const clinician = await verifyStaffLogin({
      role: "CLINICIAN",
      employeeCode: "000002",
      verification: "demo",
    });
    expect(staff?.role).toBe("STAFF");
    expect(clinician?.role).toBe("CLINICIAN");
  });
});
