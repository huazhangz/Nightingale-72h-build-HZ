import { requireActor, errorResponse } from "../auth/session";
import { getGlanceCard } from "../care-note/glance";
import { getPatientTimeline } from "../care-note/timeline";
import { createCareEntry, patchCareEntry, revertEntry } from "../care-note/entries";

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
