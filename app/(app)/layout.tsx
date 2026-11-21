import { Suspense, type ReactNode } from "react";
import { CareShell } from "../../src/components/care/CareShell";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={null}>
      <CareShell>{children}</CareShell>
    </Suspense>
  );
}
