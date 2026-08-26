import { LOCALE_TAGS, type Locale } from "./messages";

export function formatDateTime(value: Date | string | number, locale: Locale): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatDate(value: Date | string | number, locale: Locale): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    dateStyle: "medium",
  }).format(date);
}
