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

// Dates the user compares against their own calendar follow the device's
// regional format (undefined locale), not the interface language.
export function formatDeviceDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "short" }).format(
    new Date(value),
  );
}

function unitText(
  locale: Locale,
  amount: number,
  unit: "day" | "hour" | "minute",
): string {
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "long",
  }).format(amount);
}

export function formatRemainingDuration(
  locale: Locale,
  value: string,
  now: Date = new Date(),
): string | null {
  const milliseconds = new Date(value).getTime() - now.getTime();
  if (milliseconds <= 0) {
    return null;
  }
  const totalMinutes = Math.floor(milliseconds / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) {
    parts.push(unitText(locale, days, "day"));
    if (hours > 0) {
      parts.push(unitText(locale, hours, "hour"));
    }
  } else if (hours > 0) {
    parts.push(unitText(locale, hours, "hour"));
    if (minutes > 0) {
      parts.push(unitText(locale, minutes, "minute"));
    }
  } else {
    parts.push(unitText(locale, Math.max(minutes, 1), "minute"));
  }
  return new Intl.ListFormat(locale, { style: "long", type: "unit" }).format(
    parts,
  );
}
