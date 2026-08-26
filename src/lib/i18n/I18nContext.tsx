"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { formatDateTime } from "./format";
import {
  LOCALES,
  type Locale,
  type MessageKey,
  isLocale,
  translate,
} from "./messages";

const STORAGE_KEY = "nightingale.locale";

type I18nValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  formatDateTime: (value: Date | string | number) => string;
  locales: readonly Locale[];
};

const I18nContext = createContext<I18nValue | null>(null);

function readStoredLocale(): Locale {
  if (typeof window === "undefined") {
    return "en";
  }
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored && isLocale(stored) ? stored : "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setLocaleState(readStoredLocale());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    document.documentElement.lang = locale === "zh" ? "zh-CN" : locale;
    window.localStorage.setItem(STORAGE_KEY, locale);
  }, [hydrated, locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
  }, []);

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      setLocale,
      t: (key, vars) => translate(locale, key, vars),
      formatDateTime: (date) => formatDateTime(date, locale),
      locales: LOCALES,
    }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return value;
}

export function riskLabelKey(label: string | null | undefined): MessageKey {
  const normalized = label?.trim().toUpperCase();
  if (
    normalized === "CRITICAL" ||
    normalized === "HIGH" ||
    normalized === "MEDIUM" ||
    normalized === "LOW" ||
    normalized === "WARNING" ||
    normalized === "INFO" ||
    normalized === "UNRESOLVED_ACTION" ||
    normalized === "PATIENT_INSIGHT"
  ) {
    return `risk.${normalized}` as MessageKey;
  }
  return "risk.risk";
}
