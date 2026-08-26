"use client";

import { Suspense } from "react";
import { CarePage } from "../../src/components/care/CareShell";
import { TimelineView } from "../../src/components/care/TimelineView";

export default function TimelineRoute() {
  return (
    <CarePage title="Timeline">
      {({ patientId, userId, role }) => (
        <Suspense fallback={<p className="status">Loading timeline…</p>}>
          <TimelineView patientId={patientId} userId={userId} role={role} />
        </Suspense>
      )}
    </CarePage>
  );
}
