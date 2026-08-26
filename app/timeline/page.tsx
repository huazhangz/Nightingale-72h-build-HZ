"use client";

import { Suspense } from "react";
import { CarePage } from "../../src/components/care/CareShell";
import { GlanceView } from "../../src/components/care/GlanceView";
import { TimelineView } from "../../src/components/care/TimelineView";

export default function TimelineRoute() {
  return (
    <CarePage titleKey="pages.timeline">
      {({ patientId, userId, role }) => (
        <>
          <GlanceView patientId={patientId} userId={userId} role={role} />
          <Suspense fallback={<p className="status">Loading…</p>}>
            <TimelineView patientId={patientId} userId={userId} role={role} />
          </Suspense>
        </>
      )}
    </CarePage>
  );
}
