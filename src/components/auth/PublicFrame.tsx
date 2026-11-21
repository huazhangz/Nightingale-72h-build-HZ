"use client";

import type { ReactNode } from "react";
import { useI18n } from "../../lib/i18n/I18nContext";
import type { MessageKey } from "../../lib/i18n/messages";

/** Frame for signed-out pages: brand, language choice, one centred card. */
export function PublicFrame({ children }: { children: ReactNode }) {
  const { t, locale, setLocale, locales } = useI18n();
  return (
    <div className="public-shell">
      <header className="public-header">
        <p className="brand">{t("brand")}</p>
        <div className="role-selector language-selector">
          <label htmlFor="public-language">{t("language.legend")}</label>
          <select id="public-language" value={locale} onChange={(event) => setLocale(event.target.value as typeof locale)}>
            {locales.map((code) => (
              <option key={code} value={code}>
                {t(`language.${code}` as MessageKey)}
              </option>
            ))}
          </select>
        </div>
      </header>
      <main className="public-main" id="main">
        {children}
      </main>
    </div>
  );
}
