import { Suspense, type ReactNode } from "react";
import { PublicFrame } from "../../src/components/auth/PublicFrame";

export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={null}>
      <PublicFrame>{children}</PublicFrame>
    </Suspense>
  );
}
