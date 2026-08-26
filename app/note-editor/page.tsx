"use client";

import { Suspense } from "react";
import { CarePage } from "../../src/components/care/CareShell";
import { NoteEditor } from "../../src/components/care/NoteEditor";

export default function NoteEditorRoute() {
  return (
    <CarePage titleKey="pages.noteEditor">
      {({ patientId, userId, role }) => (
        <Suspense fallback={<p className="status">Loading…</p>}>
          <NoteEditor patientId={patientId} userId={userId} role={role} />
        </Suspense>
      )}
    </CarePage>
  );
}
