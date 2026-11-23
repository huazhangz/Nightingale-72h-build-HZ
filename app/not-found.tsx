"use client";

import Link from "next/link";
import { useI18n } from "../src/lib/i18n/I18nContext";

export default function NotFound() {
  const { t } = useI18n();
  return (
    <div className="public-shell"><main className="public-main" id="main">
      <section className="auth-card" aria-labelledby="not-found-title">
        <h1 id="not-found-title">{t("errors.notFoundTitle")}</h1>
        <p className="muted">{t("errors.notFoundBody")}</p>
        <Link className="btn" href="/">
          {t("errors.home")}
        </Link>
      </section>
    </main></div>
  );
}
