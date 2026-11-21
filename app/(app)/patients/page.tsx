"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { isClinicalRole, useCareContext } from "../../../src/components/care/CareShell";
import { PatientWorklist } from "../../../src/components/care/PatientWorklist";
import { useI18n } from "../../../src/lib/i18n/I18nContext";

export default function PatientsPage() {
  const { t } = useI18n();
  const router = useRouter();
  const { role } = useCareContext();
  useEffect(() => {
    if (!isClinicalRole(role)) router.replace("/glance");
  }, [role, router]);
  if (!isClinicalRole(role)) return null;
  return (
    <>
      <h1>{t("pages.patients")}</h1>
      <PatientWorklist />
    </>
  );
}
