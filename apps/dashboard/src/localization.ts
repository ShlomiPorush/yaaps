import english from "./locales/en.json";
import hebrew from "./locales/he.json";

export const localeDocuments = {
  en: english,
  he: hebrew,
} as const;

export type Locale = keyof typeof localeDocuments;
export type LocaleDocument = (typeof localeDocuments)[Locale];

export function preferredLocale(
  languages: readonly string[],
  storedLocale?: string | null,
): Locale {
  if (storedLocale === "en" || storedLocale === "he") {
    return storedLocale;
  }

  for (const language of languages) {
    const locale = language.toLowerCase().split("-")[0];
    if (locale === "en" || locale === "he") {
      return locale;
    }
  }

  return "en";
}

export function localeDirection(locale: Locale): "ltr" | "rtl" {
  return locale === "he" ? "rtl" : "ltr";
}

export function formatDate(locale: Locale, value: string): string {
  return new Intl.DateTimeFormat(locale === "he" ? "he-IL" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
