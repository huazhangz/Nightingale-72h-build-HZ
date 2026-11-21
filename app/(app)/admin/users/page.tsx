"use client";

import { UserAdmin } from "../../../../src/components/admin/UserAdmin";
import { useCareContext } from "../../../../src/components/care/CareShell";
import { useI18n } from "../../../../src/lib/i18n/I18nContext";

export default function AdminUsersPage() {
  const { t } = useI18n();
  const { user } = useCareContext();
  return (
    <>
      <h1>{t("pages.admin")}</h1>
      {user.role === "ADMIN" ? <UserAdmin currentUserId={user.id} /> : <p className="status error">{t("note.noAccess")}</p>}
    </>
  );
}
