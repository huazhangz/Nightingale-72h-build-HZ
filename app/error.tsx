"use client";

import { useEffect } from "react";
import { useI18n } from "../src/lib/i18n/I18nContext";

/** Route-level error boundary: a calm message and a retry, never a stack trace. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useI18n();
  useEffect(() => {
    console.error(error.digest ?? error.message);
  }, [error]);
  return (
    <div className="public-shell"><main className="public-main" id="main">
      <section className="auth-card" role="alert" aria-labelledby="error-title">
        <h1 id="error-title">{t("errors.errorTitle")}</h1>
        <p className="muted">{t("errors.errorBody")}</p>
        <button type="button" className="btn" onClick={reset}>
          {t("errors.retry")}
        </button>
      </section>
    </main></div>
  );
}
