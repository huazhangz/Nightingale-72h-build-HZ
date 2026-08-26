"use client";

import { CarePage } from "../../src/components/care/CareShell";
import { SearchView } from "../../src/components/care/SearchView";

export default function SearchRoute() {
  return (
    <CarePage titleKey="pages.search">
      {({ patientId, userId, role }) => (
        <SearchView patientId={patientId} userId={userId} role={role} />
      )}
    </CarePage>
  );
}
