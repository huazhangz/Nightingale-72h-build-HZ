import type { Role } from "@prisma/client";
import { requireActor, errorResponse, HttpError } from "../auth/session";
import { runHandoverAgent } from "../agent/handover/agent";
import { AgentNotConfiguredError, agentSettingsFromEnv, isAgentAvailable } from "../agent/handover/config";
import { isPromptVersion } from "../agent/handover/prompts";
import { decideProposal, latestHandoverRun, publicRunFromResult } from "../agent/handover/repository";
import { agentRunLimiter, SlidingWindowLimiter } from "../agent/rate-limit";
import { drainRiskQueue, scheduleRiskDrain } from "../agent/risk/queue";
import { getPatientRisk, listWorklist, overridePatientRisk, requestRiskAssessment } from "../agent/risk/repository";
import { clearedSessionCookie, sessionCookie, signSession } from "../auth/session-token";
import { assertPatientIsolation } from "../auth/rbac";
import { verifyPatientLogin, verifyStaffLogin } from "../auth/login";
import { getGlanceCard } from "../care-note/glance";
import { searchPatientEntries } from "../care-note/search";
import { getPatientTimeline } from "../care-note/timeline";
import { createCareEntry, patchCareEntry, revertEntry } from "../care-note/entries";
import { createHumanHighlight } from "../care-note/highlights";
import { createPatientAction, patchPatientAction } from "../care-note/actions";
import { submitHighlightFeedback } from "../learning/importance";
import { recordEntryViews, releaseFinalSummary } from "../care-note/progress-engine";
import { prisma } from "../db";

const FEATURED_PATIENT_EMAIL = "elena.rossi@nightingale.test";

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
    name: "Museil Kamil",
    role: "STAFF",
    employeeCode: "00001",
    title: "Registered Nurse",
    department: "Outpatient Nursing",
  },
  {
    email: "clinician@nightingale.test",
    name: "Joe Zhou",
    role: "CLINICIAN",
    employeeCode: "00002",
    title: "Attending Physician",
    department: "Internal Medicine",
  },
  {
    email: "admin@nightingale.test",
    name: "Avery Admin",
    role: "ADMIN",
    employeeCode: "00003",
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

    const patients = await prisma.user.findMany({
      where: { clinicId: clinic.id, role: "PATIENT" },
      select: { id: true, name: true, email: true, phone: true, role: true },
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

    const featured =
      patients.find((user) => user.email === FEATURED_PATIENT_EMAIL) ?? patients[0] ?? null;

    return Response.json({
      clinic: { id: clinic.id, name: clinic.name },
      users: [...users, ...(featured ? [featured] : [])].map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      })),
      patients,
      patientId: featured?.id ?? null,
      featuredPatientId: featured?.id ?? null,
      defaultUserId: null,
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
    const sortParam = url.searchParams.get("sort");
    const sort =
      sortParam === "newest" || sortParam === "oldest" || sortParam === "relevance"
        ? sortParam
        : undefined;
    const results = await searchPatientEntries(patientId, actor, query, {
      sort,
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
    });
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
    scheduleRiskDrain();
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
    scheduleRiskDrain();
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
    scheduleRiskDrain();
    return Response.json({ entry });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleHighlightFeedback(request: Request, highlightId: string): Promise<Response> {
  try {
    const actor = await requireActor(request);
    const payload = (await request.json()) as { verdict?: string; note?: string };
    const verdict = payload.verdict?.trim().toUpperCase();
    if (verdict !== "PIN" && verdict !== "EDIT" && verdict !== "AGREE" && verdict !== "DISAGREE") {
      return Response.json({ error: "verdict must be PIN, EDIT, AGREE, or DISAGREE" }, { status: 400 });
    }
    const result = await submitHighlightFeedback(actor, highlightId, {
      verdict,
      note: payload.note,
    });
    return Response.json({ feedback: { verdict, highlightId }, weights: result.weights });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleCreateHighlight(request: Request, entryId: string): Promise<Response> {
  try {
    const actor = await requireActor(request);
    const payload = (await request.json()) as {
      startOffset?: number;
      endOffset?: number;
      excerpt?: string;
      label?: string;
    };
    if (payload.startOffset === undefined || payload.endOffset === undefined) {
      return Response.json({ error: "startOffset and endOffset are required" }, { status: 400 });
    }
    const highlight = await createHumanHighlight(actor, entryId, {
      startOffset: payload.startOffset,
      endOffset: payload.endOffset,
      excerpt: payload.excerpt,
      label: payload.label,
    });
    scheduleRiskDrain();
    return Response.json({ highlight }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleCreatePatientAction(request: Request, patientId: string): Promise<Response> {
  try {
    const actor = await requireActor(request);
    const payload = (await request.json()) as {
      text?: string;
      kind?: string;
      careEntryId?: string;
    };
    if (!payload.text?.trim()) {
      return Response.json({ error: "text is required" }, { status: 400 });
    }
    const action = await createPatientAction(actor, patientId, {
      text: payload.text,
      kind: payload.kind,
      careEntryId: payload.careEntryId,
    });
    return Response.json({ action }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handlePatchPatientAction(
  request: Request,
  patientId: string,
  actionId: string,
): Promise<Response> {
  try {
    const actor = await requireActor(request);
    const payload = (await request.json()) as {
      status?: "PENDING" | "RESOLVED";
      kind?: string;
      text?: string;
      careEntryId?: string;
    };
    const action = await patchPatientAction(actor, patientId, actionId, payload);
    return Response.json({ action });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleRecordEntryViews(request: Request, patientId: string): Promise<Response> {
  try {
    const actor = await requireActor(request);
    assertPatientIsolation(actor, patientId);
    const payload = (await request.json()) as { entryIds?: string[] };
    const updates = await recordEntryViews(actor, payload.entryIds ?? []);
    return Response.json({ updates });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleReleaseFinalSummary(request: Request, entryId: string): Promise<Response> {
  try {
    const actor = await requireActor(request);
    const entry = await releaseFinalSummary(actor, entryId);
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
      return loginSuccess(user);
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
      return loginSuccess(user);
    }
    return Response.json({ error: "Unsupported role" }, { status: 400 });
  } catch (error) {
    return errorResponse(error);
  }
}

function loginSuccess(user: { id: string; role: Role }): Response {
  return Response.json(
    { userId: user.id, role: user.role },
    { headers: { "set-cookie": sessionCookie(signSession(user.id)) } },
  );
}

export function handleLogout(): Response {
  return Response.json({ ok: true }, { headers: { "set-cookie": clearedSessionCookie() } });
}

function agentErrorResponse(error: unknown): Response {
  if (error instanceof AgentNotConfiguredError) {
    return Response.json({ error: error.message, code: error.code }, { status: 503 });
  }
  return errorResponse(error);
}

export async function handleAgentStatus(request: Request): Promise<Response> {
  try {
    await requireActor(request);
    const settings = agentSettingsFromEnv();
    return Response.json({
      available: isAgentAvailable(settings),
      client: settings.client,
      model: settings.model,
      promptVersion: settings.promptVersion,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleRunHandover(request: Request, patientId: string): Promise<Response> {
  try {
    const actor = await requireActor(request);
    assertPatientIsolation(actor, patientId);
    const payload = (await request.json().catch(() => ({}))) as { promptVersion?: unknown };
    if (payload.promptVersion !== undefined && !isPromptVersion(payload.promptVersion)) {
      throw new HttpError(400, "INVALID_PROMPT_VERSION", "Unknown promptVersion");
    }
    // Check configuration before consuming a rate-limit slot.
    if (!isAgentAvailable(agentSettingsFromEnv())) {
      throw new AgentNotConfiguredError();
    }
    const limit = agentRunLimiter.take(actor.id);
    if (!limit.allowed) {
      return Response.json(
        { error: "Too many handover runs; try again shortly.", code: "RATE_LIMITED" },
        { status: 429, headers: { "retry-after": String(Math.ceil(limit.retryAfterMs / 1000)) } },
      );
    }
    const startedAt = new Date();
    const result = await runHandoverAgent(actor, patientId, {
      ...(isPromptVersion(payload.promptVersion) ? { promptVersion: payload.promptVersion } : {}),
      signal: request.signal,
    });
    return Response.json({ run: publicRunFromResult(result, startedAt) });
  } catch (error) {
    return agentErrorResponse(error);
  }
}

export async function handleLatestHandover(request: Request, patientId: string): Promise<Response> {
  try {
    const actor = await requireActor(request);
    assertPatientIsolation(actor, patientId);
    return Response.json({ run: await latestHandoverRun(actor, patientId) });
  } catch (error) {
    return agentErrorResponse(error);
  }
}

export async function handleDecideProposal(request: Request, proposalId: string): Promise<Response> {
  try {
    const actor = await requireActor(request);
    const payload = (await request.json().catch(() => ({}))) as { decision?: unknown };
    if (payload.decision !== "accept" && payload.decision !== "dismiss") {
      throw new HttpError(400, "INVALID_DECISION", "decision must be accept or dismiss");
    }
    return Response.json({ proposal: await decideProposal(actor, proposalId, payload.decision) });
  } catch (error) {
    return agentErrorResponse(error);
  }
}

const riskRequestLimiter = new SlidingWindowLimiter(10, 10 * 60 * 1000);

export async function handleWorklist(request: Request): Promise<Response> {
  try {
    const actor = await requireActor(request);
    return Response.json({ patients: await listWorklist(actor) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleGetRisk(request: Request, patientId: string): Promise<Response> {
  try {
    const actor = await requireActor(request);
    assertPatientIsolation(actor, patientId);
    return Response.json(await getPatientRisk(actor, patientId));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleRequestRisk(request: Request, patientId: string): Promise<Response> {
  try {
    const actor = await requireActor(request);
    assertPatientIsolation(actor, patientId);
    const limit = riskRequestLimiter.take(actor.id);
    if (!limit.allowed) {
      return Response.json(
        { error: "Too many reassessments; try again shortly.", code: "RATE_LIMITED" },
        { status: 429, headers: { "retry-after": String(Math.ceil(limit.retryAfterMs / 1000)) } },
      );
    }
    return Response.json(await requestRiskAssessment(actor, patientId));
  } catch (error) {
    return agentErrorResponse(error);
  }
}

export async function handleOverrideRisk(request: Request, patientId: string): Promise<Response> {
  try {
    const actor = await requireActor(request);
    assertPatientIsolation(actor, patientId);
    const payload = (await request.json().catch(() => ({}))) as { level?: unknown; reason?: unknown };
    return Response.json(
      await overridePatientRisk(actor, patientId, {
        level: typeof payload.level === "string" ? payload.level : "",
        reason: typeof payload.reason === "string" ? payload.reason : "",
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

/** Cron hook: POST with header x-cron-secret = NIGHTINGALE_CRON_SECRET. Disabled when the secret is unset. */
export async function handleDrainRiskQueue(request: Request): Promise<Response> {
  const secret = process.env.NIGHTINGALE_CRON_SECRET;
  if (!secret || secret.length < 16) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const provided = request.headers.get("x-cron-secret") ?? "";
  const { timingSafeEqual } = await import("node:crypto");
  const ok = provided.length === secret.length && timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
  if (!ok) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    return Response.json({ processed: await drainRiskQueue({ limit: 25 }) });
  } catch (error) {
    return errorResponse(error);
  }
}
