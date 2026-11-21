"use client";

import { AccountView } from "../../../src/components/account/AccountView";
import { useI18n } from "../../../src/lib/i18n/I18nContext";

export default function AccountPage() {
  const { t } = useI18n();
  return (
    <>
      <h1>{t("pages.account")}</h1>
      <AccountView />
    </>
  );
}
