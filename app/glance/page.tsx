"use client";

import { CarePage } from "../../src/components/care/CareShell";
import { GlanceView } from "../../src/components/care/GlanceView";

export default function GlanceRoute() {
  return (
    <CarePage titleKey="pages.glance">
      {({ patientId, userId }) => <GlanceView patientId={patientId} userId={userId} />}
    </CarePage>
  );
}
