/**
 * Cron evaluator tests (Phase B). The correctness-critical part of the
 * scheduler — exercised hard: every field-syntax form, dom/dow OR-semantics,
 * month/dow boundaries, timezones (incl. a DST-adjacent case), invalid-cron
 * throwing, and the strictly-after semantics of nextFireAfter.
 */

import { describe, expect, it } from "vitest";
import {
  CronParseError,
  nextFireAfter,
  parseCron,
  validateCron,
} from "../src/core/cron.js";

describe("parseCron / validateCron", () => {
  it("parses a wildcard expression", () => {
    const p = parseCron("* * * * *");
    expect(p.minute.size).toBe(60);
    expect(p.hour.size).toBe(24);
    expect(p.domRestricted).toBe(false);
    expect(p.dowRestricted).toBe(false);
  });

  it("parses a single value, a list, a range, and steps", () => {
    expect([...parseCron("5 * * * *").minute]).toEqual([5]);
    expect([...parseCron("1,2,3 * * * *").minute].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect([...parseCron("10-13 * * * *").minute]).toEqual([10, 11, 12, 13]);
    expect([...parseCron("*/15 * * * *").minute]).toEqual([0, 15, 30, 45]);
    expect([...parseCron("10-20/5 * * * *").minute]).toEqual([10, 15, 20]);
    // open-ended a/n
    expect([...parseCron("50/5 * * * *").minute]).toEqual([50, 55]);
  });

  it("normalizes day-of-week 7 to 0 (Sunday) and supports 0", () => {
    expect(parseCron("* * * * 7").dow.has(0)).toBe(true);
    expect(parseCron("* * * * 0").dow.has(0)).toBe(true);
  });

  it("tracks dom/dow restriction flags", () => {
    const both = parseCron("0 0 1 * 1");
    expect(both.domRestricted).toBe(true);
    expect(both.dowRestricted).toBe(true);
    const domOnly = parseCron("0 0 1 * *");
    expect(domOnly.domRestricted).toBe(true);
    expect(domOnly.dowRestricted).toBe(false);
  });

  it("throws on malformed cron", () => {
    expect(() => validateCron("* * * *")).toThrow(CronParseError); // 4 fields
    expect(() => validateCron("* * * * * *")).toThrow(CronParseError); // 6 fields
    expect(() => validateCron("60 * * * *")).toThrow(CronParseError); // minute out of range
    expect(() => validateCron("* 24 * * *")).toThrow(CronParseError); // hour out of range
    expect(() => validateCron("* * 0 * *")).toThrow(CronParseError); // dom min is 1
    expect(() => validateCron("* * * 13 *")).toThrow(CronParseError); // month out of range
    expect(() => validateCron("* * * * 8")).toThrow(CronParseError); // dow out of range
    expect(() => validateCron("5-1 * * * *")).toThrow(CronParseError); // inverted range
    expect(() => validateCron("*/0 * * * *")).toThrow(CronParseError); // zero step
    expect(() => validateCron("a * * * *")).toThrow(CronParseError); // non-numeric
    expect(() => validateCron("")).toThrow(CronParseError);
  });
});

describe("nextFireAfter — basic semantics", () => {
  it("returns the next minute for '* * * * *'", () => {
    expect(nextFireAfter("* * * * *", "2026-06-18T00:00:00.000Z")).toBe(
      "2026-06-18T00:01:00.000Z",
    );
  });

  it("is STRICTLY after — an exact match boundary advances to the next fire", () => {
    // 00:00 matches '*/5'; strictly-after must skip to 00:05.
    expect(nextFireAfter("*/5 * * * *", "2026-06-18T00:00:00.000Z")).toBe(
      "2026-06-18T00:05:00.000Z",
    );
    // Mid-interval rounds up to the next slot.
    expect(nextFireAfter("*/5 * * * *", "2026-06-18T00:02:30.000Z")).toBe(
      "2026-06-18T00:05:00.000Z",
    );
  });

  it("handles hour rollover", () => {
    expect(nextFireAfter("0 * * * *", "2026-06-18T10:30:00.000Z")).toBe(
      "2026-06-18T11:00:00.000Z",
    );
  });

  it("handles a daily fire at a fixed time", () => {
    expect(nextFireAfter("0 9 * * *", "2026-06-18T09:00:00.000Z")).toBe(
      "2026-06-19T09:00:00.000Z",
    );
    expect(nextFireAfter("0 9 * * *", "2026-06-18T08:59:00.000Z")).toBe(
      "2026-06-18T09:00:00.000Z",
    );
  });

  it("handles month boundaries", () => {
    // Midnight on the 1st of each month.
    expect(nextFireAfter("0 0 1 * *", "2026-06-18T12:00:00.000Z")).toBe(
      "2026-07-01T00:00:00.000Z",
    );
  });

  it("handles a specific month (only February)", () => {
    expect(nextFireAfter("0 0 1 2 *", "2026-06-18T00:00:00.000Z")).toBe(
      "2027-02-01T00:00:00.000Z",
    );
  });

  it("throws for an impossible date (Feb 31)", () => {
    expect(() => nextFireAfter("0 0 31 2 *", "2026-01-01T00:00:00.000Z")).toThrow(
      CronParseError,
    );
  });
});

describe("nextFireAfter — day-of-month / day-of-week OR semantics", () => {
  it("matches EITHER dom or dow when both are restricted", () => {
    // "0 0 13 * 5" = midnight on the 13th OR any Friday.
    // 2026-06-18 is a Thursday. Next Friday is 2026-06-19.
    const next = nextFireAfter("0 0 13 * 5", "2026-06-18T12:00:00.000Z");
    expect(next).toBe("2026-06-19T00:00:00.000Z"); // Friday comes before the next 13th
  });

  it("uses only dom when dow is '*'", () => {
    // 15th of the month, regardless of weekday.
    expect(nextFireAfter("0 0 15 * *", "2026-06-18T00:00:00.000Z")).toBe(
      "2026-07-15T00:00:00.000Z",
    );
  });

  it("uses only dow when dom is '*'", () => {
    // Every Monday (dow=1). 2026-06-18 is Thursday → next Monday 2026-06-22.
    expect(nextFireAfter("0 0 * * 1", "2026-06-18T00:00:00.000Z")).toBe(
      "2026-06-22T00:00:00.000Z",
    );
  });

  it("matches a Sunday via dow=0", () => {
    // 2026-06-18 Thu → next Sunday 2026-06-21.
    expect(nextFireAfter("30 8 * * 0", "2026-06-18T00:00:00.000Z")).toBe(
      "2026-06-21T08:30:00.000Z",
    );
  });
});

describe("nextFireAfter — timezones", () => {
  it("evaluates wall-clock time in the given IANA zone (NY vs UTC)", () => {
    // "0 9 * * *" in America/New_York. On 2026-06-18 NY is EDT (UTC-4), so 09:00
    // local == 13:00 UTC. Same cron in UTC fires at 09:00 UTC.
    const after = "2026-06-18T00:00:00.000Z";
    expect(nextFireAfter("0 9 * * *", after, "America/New_York")).toBe(
      "2026-06-18T13:00:00.000Z",
    );
    expect(nextFireAfter("0 9 * * *", after, "UTC")).toBe("2026-06-18T09:00:00.000Z");
  });

  it("respects a non-US zone offset (Asia/Kolkata UTC+5:30)", () => {
    // 09:00 IST == 03:30 UTC.
    expect(nextFireAfter("0 9 * * *", "2026-06-18T00:00:00.000Z", "Asia/Kolkata")).toBe(
      "2026-06-18T03:30:00.000Z",
    );
  });

  it("handles a DST 'spring forward' day correctly (US, March 2026)", () => {
    // 2026-03-08 02:00 EST → 03:00 EDT (the 02:xx wall-clock hour does not exist).
    // A 09:00 local daily fire is well clear of the gap; before the transition NY
    // is EST (UTC-5) so on the transition day 09:00 EDT == 13:00 UTC.
    expect(nextFireAfter("0 9 * * *", "2026-03-08T00:00:00.000Z", "America/New_York")).toBe(
      "2026-03-08T13:00:00.000Z",
    );
    // The day BEFORE the transition (still EST) 09:00 local == 14:00 UTC.
    expect(nextFireAfter("0 9 * * *", "2026-03-07T00:00:00.000Z", "America/New_York")).toBe(
      "2026-03-07T14:00:00.000Z",
    );
  });

  it("defaults to UTC when no timezone is given", () => {
    expect(nextFireAfter("0 0 * * *", "2026-06-18T05:00:00.000Z")).toBe(
      "2026-06-19T00:00:00.000Z",
    );
  });

  it("throws on an invalid timezone", () => {
    expect(() => nextFireAfter("* * * * *", "2026-06-18T00:00:00.000Z", "Not/AZone")).toThrow(
      CronParseError,
    );
  });

  it("throws on an invalid 'after' timestamp", () => {
    expect(() => nextFireAfter("* * * * *", "not-a-date")).toThrow(CronParseError);
  });
});
