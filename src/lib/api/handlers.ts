import type { Role } from "@prisma/client";
import { requireActor, errorResponse } from "../auth/session";
import { getGlanceCard } from "../care-note/glance";
import { getPatientTimeline } from "../care-note/timeline";
import { createCareEntry, patchCareEntry, revertEntry } from "../care-note/entries";
import { createProvenancePointer } from "../care-note/provenance";
import { prisma } from "../db";

const DEMO_USERS: Array<{ email: string; name: string; role: Role }> = [
  { email: "patient@nightingale.test", name: "Pat Patient", role: "PATIENT" },
  { email: "staff@nightingale.test", name: "Sam Staff", role: "STAFF" },
  { email: "clinician@nightingale.test", name: "Casey Clinician", role: "CLINICIAN" },
  { email: "admin@nightingale.test", name: "Avery Admin", role: "ADMIN" },
];

export async function handleDemoBootstrap(): Promise<Response> {
  try {
    const clinic = await prisma.clinic.upsert({
      where: { slug: "nightingale-demo" },
      update: { name: "Nightingale Demo Clinic" },
      create: { name: "Nightingale Demo Clinic", slug: "nightingale-demo" },
    });

    const users = [];
    for (const user of DEMO_USERS) {
      users.push(
        await prisma.user.upsert({
          where: { email: user.email },
          update: { name: user.name, role: user.role, clinicId: clinic.id },
          create: {
            email: user.email,
            name: user.name,
            role: user.role,
            clinicId: clinic.id,
            passwordHash: "dev-only-not-a-real-hash",
          },
        }),
      );
    }

    const patient = users.find((user) => user.role === "PATIENT");
    const clinician = users.find((user) => user.role === "CLINICIAN");
    const staff = users.find((user) => user.role === "STAFF");

    if (patient && clinician && staff) {
      const existing = await prisma.careEntry.findFirst({
        where: { patientId: patient.id },
      });
      if (!existing) {
        const body = "Observed cough and fever. Plan: chase labs tomorrow.";
        const excerpt = "cough and fever";
        const startOffset = body.indexOf(excerpt);
        const endOffset = startOffset + excerpt.length;
        const entry = await prisma.careEntry.create({
          data: {
            clinicId: clinic.id,
            patientId: patient.id,
            authorId: clinician.id,
            title: "Acute review",
            body,
            version: 1,
            encounterAt: new Date(),
          },
        });
        await prisma.comment.create({
          data: {
            careEntryId: entry.id,
            authorId: staff.id,
            body: "Internal staff comment: chase CRP and flag if rising.",
          },
        });
        await prisma.highlight.create({
          data: {
            careEntryId: entry.id,
            createdById: clinician.id,
            startOffset,
            endOffset,
            excerpt,
            label: "risk",
            source: "MODEL",
            confidence: 0.92,
            provenancePointer: createProvenancePointer(entry.id, startOffset, endOffset),
          },
        });
      }
    }
    return Response.json({
      clinic: { id: clinic.id, name: clinic.name },
      users: users.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      })),
      patientId: patient?.id ?? null,
      defaultUserId: clinician?.id ?? users[0]?.id ?? null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handlePatientTimeline(request: Request, patientId: string): Promise<Response> {
  try {
    const actor = await requireActor(request);
    const entries = await getPatientTimeline(patientId, actor);
    return Response.json({ entries });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handlePatientGlance(request: Request, patientId: string): Promise<Response> {
  try {
    const actor = await requireActor(request);
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
