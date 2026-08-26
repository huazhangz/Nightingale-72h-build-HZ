"use client";

import { CarePage } from "../../src/components/care/CareShell";
import { NoteEditor } from "../../src/components/care/NoteEditor";

export default function NoteEditorRoute() {
  return (
    <CarePage titleKey="pages.noteEditor">
      {({ patientId, userId }) => <NoteEditor patientId={patientId} userId={userId} />}
    </CarePage>
  );
}
