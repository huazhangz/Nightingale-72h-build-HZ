import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime } from "../src/lib/i18n/format";
import { LOCALES, dictionaries, translate, type MessageKey } from "../src/lib/i18n/messages";
import { REDACTED, redactPhi } from "../src/lib/security/redact";

const SAMPLE_KEYS: MessageKey[] = [
  "pages.glance",
  "pages.timeline",
  "pages.noteEditor",
  "pages.search",
  "role.legend",
  "patient.legend",
  "language.legend",
  "risk.CRITICAL",
  "risk.HIGH",
  "risk.MEDIUM",
  "risk.LOW",
  "action.comment",
  "action.highlight",
  "version.history",
  "timeline.viewHistory",
  "timeline.viewDetail",
  "note.conflict",
  "note.noAccess",
  "login.patientTitle",
  "progress.submitted",
];

describe("i18n dictionaries", () => {
  it("returns non-empty strings for all five locales", () => {
    expect(LOCALES).toEqual(["en", "zh", "fi", "de", "fr"]);
    for (const locale of LOCALES) {
      const table = dictionaries[locale];
      expect(Object.keys(table).length).toBeGreaterThan(0);
      for (const key of SAMPLE_KEYS) {
        const value = translate(locale, key);
        expect(value.trim().length).toBeGreaterThan(0);
        expect(value).toBe(table[key]);
      }
    }
    expect(translate("zh", "risk.CRITICAL")).toBe("危急");
    expect(translate("fi", "nav.timeline")).toBe("Aikajana");
    expect(translate("de", "risk.HIGH")).toBe("HOCH");
    expect(translate("fr", "pages.search")).toBe("Recherche");
    expect(translate("en", "version.history")).toBe("Version history");
  });

  it("formats dates with Intl according to the selected locale", () => {
    const instant = new Date("2024-06-15T12:00:00.000Z");
    const en = formatDateTime(instant, "en");
    const zh = formatDateTime(instant, "zh");
    const fi = formatDate(instant, "fi");
    const de = formatDate(instant, "de");
    const fr = formatDate(instant, "fr");

    expect(en).not.toBe(zh);
    expect(new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(instant)).toBe(
      en,
    );
    expect(new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(instant)).toBe(
      zh,
    );
    expect(fi).toBe(new Intl.DateTimeFormat("fi-FI", { dateStyle: "medium" }).format(instant));
    expect(de).toBe(new Intl.DateTimeFormat("de-DE", { dateStyle: "medium" }).format(instant));
    expect(fr).toBe(new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium" }).format(instant));
    expect(zh).toMatch(/2024/);
    expect(fi).toMatch(/15/);
    expect(de).toMatch(/15/);
  });

  it("redacts Chinese identifiers and European phone numbers", () => {
    const input =
      "患者：张华 联系 +358 40 123 4567 / +49 30 12345678 / +33 1 23 45 67 89 email anne.dupont@hopital.fr 身份证 110101199001011234 张华先生";
    const output = redactPhi(input);
    expect(output).not.toMatch(/张华/);
    expect(output).not.toMatch(/\+358/);
    expect(output).not.toMatch(/\+49/);
    expect(output).not.toMatch(/\+33/);
    expect(output).not.toMatch(/anne\.dupont@hopital\.fr/i);
    expect(output).not.toMatch(/110101199001011234/);
    expect(output).toContain(REDACTED);
  });
});
