import type { Role } from "@prisma/client";
import { requireActor, errorResponse } from "../auth/session";
import { assertPatientIsolation } from "../auth/rbac";
import { verifyPatientLogin, verifyStaffLogin } from "../auth/login";
import { getGlanceCard } from "../care-note/glance";
import { searchPatientEntries } from "../care-note/search";
import { getPatientTimeline } from "../care-note/timeline";
import { createCareEntry, patchCareEntry, revertEntry } from "../care-note/entries";
import { prisma } from "../db";

const FEATURED_PATIENT_EMAIL = "zhang.wei@nightingale.test";

const DEMO_STAFF: Array<{
  email: string;
  name: string;
  role: Role;
  employeeCode: string;
  title: string;
  department: string;
}> = [
  {
    email: "staff@nightingale.test",
    name: "Sam Staff",
    role: "STAFF",
    employeeCode: "000001",
    title: "Registered Nurse",
    department: "Outpatient Nursing",
  },
  {
    email: "clinician@nightingale.test",
    name: "Casey Clinician",
    role: "CLINICIAN",
    employeeCode: "000002",
    title: "Attending Physician",
    department: "Internal Medicine",
  },
  {
    email: "admin@nightingale.test",
    name: "Avery Admin",
    role: "ADMIN",
    employeeCode: "000003",
    title: "Clinic Administrator",
    department: "Operations",
  },
];

export async function handleDemoBootstrap(): Promise<Response> {
  try {
    const clinic = await prisma.clinic.upsert({
      where: { slug: "nightingale-demo" },
      update: { name: "Nightingale Demo Clinic" },
      create: { name: "Nightingale Demo Clinic", slug: "nightingale-demo" },
    });

    const users = [];
    for (const user of DEMO_STAFF) {
      users.push(
        await prisma.user.upsert({
          where: { email: user.email },
          update: {
            name: user.name,
            role: user.role,
            clinic: { connect: { id: clinic.id } },
            employeeCode: user.employeeCode,
            title: user.title,
            department: user.department,
          },
          create: {
            email: user.email,
            name: user.name,
            role: user.role,
            clinic: { connect: { id: clinic.id } },
            employeeCode: user.employeeCode,
            title: user.title,
            department: user.department,
            passwordHash: "dev-only-not-a-real-hash",
          },
        }),
      );
    }

    const featured = await prisma.user.upsert({
      where: { email: FEATURED_PATIENT_EMAIL },
      update: {
        name: "张伟 (Zhang Wei)",
        role: "PATIENT",
        clinic: { connect: { id: clinic.id } },
        phone: "13812345678",
        dateOfBirth: "1985-06-15",
      },
      create: {
        email: FEATURED_PATIENT_EMAIL,
        name: "张伟 (Zhang Wei)",
        role: "PATIENT",
        clinic: { connect: { id: clinic.id } },
        phone: "13812345678",
        dateOfBirth: "1985-06-15",
        passwordHash: "dev-only-not-a-real-hash",
      },
    });

    const patients = await prisma.user.findMany({
      where: { clinicId: clinic.id, role: "PATIENT" },
      select: { id: true, name: true, email: true, phone: true },
      orderBy: { name: "asc" },
    });
    patients.sort((left, right) => {
      if (left.email === FEATURED_PATIENT_EMAIL) {
        return -1;
      }
      if (right.email === FEATURED_PATIENT_EMAIL) {
        return 1;
      }
      return left.name.localeCompare(right.name);
    });

    const clinician = users.find((user) => user.role === "CLINICIAN");
    return Response.json({
      clinic: { id: clinic.id, name: clinic.name },
      users: [...users, featured].map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      })),
      patients,
      patientId: featured.id,
      featuredPatientId: featured.id,
      defaultUserId: clinician?.id ?? users[0]?.id ?? null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handlePatientTimeline(request: Request, patientId: string): Promise<Response> {
  try {
    const actor = await requireActor(request);
    assertPatientIsolation(actor, patientId);
    const entries = await getPatientTimeline(patientId, actor);
    return Response.json({ entries });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handlePatientGlance(request: Request, patientId: string): Promise<Response> {
  try {
    const actor = await requireActor(request);
    assertPatientIsolation(actor, patientId);
    const started = Date.now();
    const { card, cacheHit } = await getGlanceCard(patientId, actor);
    return Response.json(
      { ...card, cacheHit, durationMs: Date.now() - started },
      {
        headers: {
          "x-cache": cacheHit ? "HIT" : "MISS",
        },
      },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handlePatientSearch(request: Request, patientId: string): Promise<Response> {
  try {
    const actor = await requireActor(request);
    assertPatientIsolation(actor, patientId);
    const url = new URL(request.url);
    const query = url.searchParams.get("q") ?? "";
    const results = await searchPatientEntries(patientId, actor, query);
    return Response.json({ results });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleCreateEntry(request: Request): Promise<Response> {
  try {
    const actor = await requireActor(request);
    const payload = (await request.json()) as {
      patientId?: string;
      title?: string;
      body?: string;
      encounterAt?: string;
    };
    if (!payload.patientId || !payload.title || payload.body === undefined) {
      return Response.json({ error: "patientId, title, and body are required" }, { status: 400 });
    }
    const entry = await createCareEntry(actor, {
      patientId: payload.patientId,
      title: payload.title,
      body: payload.body,
      encounterAt: payload.encounterAt,
    });
    return Response.json({ entry }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handlePatchEntry(request: Request, entryId: string): Promise<Response> {
  try {
    const actor = await requireActor(request);
    const payload = (await request.json()) as {
      body?: string;
      newContent?: string;
      baseVersion?: number;
      expectedVersion?: number;
      title?: string;
    };
    const body = payload.body ?? payload.newContent;
    const baseVersion = payload.baseVersion ?? payload.expectedVersion;
    if (body === undefined || baseVersion === undefined) {
      return Response.json({ error: "body and baseVersion are required" }, { status: 400 });
    }
    const result = await patchCareEntry(actor, entryId, {
      body,
      baseVersion,
      title: payload.title,
    });
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleRevertEntry(request: Request, entryId: string): Promise<Response> {
  try {
    const actor = await requireActor(request);
    const payload = (await request.json()) as { targetVersion?: number };
    if (payload.targetVersion === undefined) {
      return Response.json({ error: "targetVersion is required" }, { status: 400 });
    }
    const entry = await revertEntry(actor, entryId, payload.targetVersion);
    return Response.json({ entry });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleLogin(request: Request): Promise<Response> {
  try {
    const payload = (await request.json()) as {
      role?: Role;
      fullName?: string;
      phone?: string;
      dateOfBirth?: string;
      employeeCode?: string;
      verification?: string;
    };
    if (payload.role === "PATIENT") {
      const user = await verifyPatientLogin({
        fullName: payload.fullName ?? "",
        phone: payload.phone ?? "",
        dateOfBirth: payload.dateOfBirth ?? "",
      });
      if (!user) {
        return Response.json({ error: "Patient verification failed" }, { status: 401 });
      }
      return Response.json({ userId: user.id, role: user.role });
    }
    if (payload.role === "STAFF" || payload.role === "CLINICIAN") {
      const user = await verifyStaffLogin({
        role: payload.role,
        employeeCode: payload.employeeCode ?? "",
        verification: payload.verification ?? "",
      });
      if (!user) {
        return Response.json({ error: "Staff verification failed" }, { status: 401 });
      }
      return Response.json({ userId: user.id, role: user.role });
    }
    return Response.json({ error: "Unsupported role" }, { status: 400 });
  } catch (error) {
    return errorResponse(error);
  }
}
