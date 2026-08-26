"use client";

import { CarePage } from "../../src/components/care/CareShell";
import { TimelineView } from "../../src/components/care/TimelineView";

export default function TimelineRoute() {
  return (
    <CarePage title="Timeline">
      {({ patientId, userId }) => <TimelineView patientId={patientId} userId={userId} />}
    </CarePage>
  );
}
