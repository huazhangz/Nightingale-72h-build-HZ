"use client";

import { CarePage } from "../../src/components/care/CareShell";
import { SearchView } from "../../src/components/care/SearchView";

export default function SearchRoute() {
  return (
    <CarePage titleKey="pages.search">
      {({ patientId, userId }) => <SearchView patientId={patientId} userId={userId} />}
    </CarePage>
  );
}
