import { describe, expect, it } from "vitest";

import { formatDeviceDate, formatRemainingDuration } from "./localization.js";

describe("expiry formatting", () => {
  const now = new Date("2026-08-26T12:00:00.000Z");

  it("combines days and hours while at least a day remains", () => {
    const text = formatRemainingDuration("en", "2026-08-31T15:30:00.000Z", now);
    expect(text).toContain("5 days");
    expect(text).toContain("3 hours");
  });

  it("omits a zero hour remainder", () => {
    expect(formatRemainingDuration("en", "2026-08-31T12:30:00.000Z", now)).toBe(
      "5 days",
    );
  });

  it("falls back to hours and minutes inside the final day", () => {
    const text = formatRemainingDuration("en", "2026-08-26T19:30:00.000Z", now);
    expect(text).toContain("7 hours");
    expect(text).toContain("30 minutes");
  });

  it("never reports less than one minute for a live report", () => {
    expect(formatRemainingDuration("en", "2026-08-26T12:00:20.000Z", now)).toBe(
      "1 minute",
    );
  });

  it("returns null once the report has expired", () => {
    expect(
      formatRemainingDuration("en", "2026-08-26T11:59:00.000Z", now),
    ).toBeNull();
  });

  it("localizes the duration units in Hebrew", () => {
    const text = formatRemainingDuration("he", "2026-08-31T15:30:00.000Z", now);
    expect(text).toContain("ימים");
    expect(text).toContain("שעות");
  });

  it("formats the calendar date with the device regional format", () => {
    const expected = new Intl.DateTimeFormat(undefined, {
      dateStyle: "short",
    }).format(new Date("2026-08-31T15:30:00.000Z"));
    expect(formatDeviceDate("2026-08-31T15:30:00.000Z")).toBe(expected);
  });
});
