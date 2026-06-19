/**
 * A small, dependency-free standard 5-field cron evaluator for Phase B
 * scheduling.
 *
 * FIELDS (in order): minute hour day-of-month month day-of-week
 *   minute       0-59
 *   hour         0-23
 *   day-of-month 1-31
 *   month        1-12
 *   day-of-week  0-6   (0 = Sunday; 7 is also accepted as Sunday)
 *
 * SUPPORTED SYNTAX per field:
 *   *            every value
 *   a            a single value
 *   a,b,c        a list
 *   a-b          an inclusive range
 *   star-slash-n every n-th value across the whole range (step, written as the
 *                literal asterisk then slash then n)
 *   a-b/n        every n-th value across a sub-range (step over range)
 *   a/n          every n-th value from a to the field max (open-ended step)
 *
 * DAY-OF-MONTH / DAY-OF-WEEK OR-SEMANTICS (standard cron / Vixie cron):
 *   When BOTH dom and dow are restricted (neither is "*"), a timestamp matches
 *   if it matches EITHER field. When only one is restricted, only that one is
 *   used. When both are "*", every day matches.
 *
 * DETERMINISM: every entry point takes the `now`/`after` instant as an ISO
 * string parameter. This module NEVER calls argless `Date.now()` / `new Date()`.
 * It uses `new Date(isoString)` + UTC field math + `Intl.DateTimeFormat` for the
 * timezone projection only.
 */

const FIELD_RANGES: Array<{ min: number; max: number }> = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day of week (0 = Sun)
];

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** True when the field was a bare "*", controlling the dom/dow OR-rule. */
  domRestricted: boolean;
  dowRestricted: boolean;
}

/** Thrown when a cron string cannot be parsed. */
export class CronParseError extends Error {
  readonly name = "CronParseError";
}

function parseField(raw: string, index: number): { values: Set<number>; restricted: boolean } {
  const { min, max } = FIELD_RANGES[index]!;
  const restricted = raw.trim() !== "*";
  const out = new Set<number>();

  // day-of-week: normalize 7 -> 0 (both mean Sunday).
  const normalize = (n: number): number => (index === 4 && n === 7 ? 0 : n);
  const inRange = (n: number): boolean => n >= min && n <= (index === 4 ? 7 : max);

  for (const part of raw.split(",")) {
    const token = part.trim();
    if (token === "") throw new CronParseError(`Empty term in cron field "${raw}".`);

    // Split off an optional step (`.../n`).
    let stepStr: string | undefined;
    let rangePart = token;
    const slash = token.indexOf("/");
    if (slash !== -1) {
      rangePart = token.slice(0, slash);
      stepStr = token.slice(slash + 1);
    }

    let step = 1;
    if (stepStr !== undefined) {
      if (!/^\d+$/.test(stepStr)) throw new CronParseError(`Invalid step "${stepStr}" in "${raw}".`);
      step = Number(stepStr);
      if (step < 1) throw new CronParseError(`Step must be >= 1 in "${raw}".`);
    }

    // Resolve the base range the step iterates over.
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [aStr, bStr, ...rest] = rangePart.split("-");
      if (rest.length > 0 || aStr === undefined || bStr === undefined) {
        throw new CronParseError(`Invalid range "${rangePart}" in "${raw}".`);
      }
      if (!/^\d+$/.test(aStr) || !/^\d+$/.test(bStr)) {
        throw new CronParseError(`Invalid range bounds "${rangePart}" in "${raw}".`);
      }
      lo = Number(aStr);
      hi = Number(bStr);
    } else {
      if (!/^\d+$/.test(rangePart)) {
        throw new CronParseError(`Invalid value "${rangePart}" in "${raw}".`);
      }
      lo = Number(rangePart);
      // A bare value WITH a step (`a/n`) means "from a to field-max, step n".
      hi = stepStr !== undefined ? max : lo;
    }

    if (!inRange(lo) || !inRange(hi)) {
      throw new CronParseError(`Value out of range in "${raw}" (field ${index}).`);
    }
    if (lo > hi) {
      throw new CronParseError(`Inverted range "${rangePart}" in "${raw}".`);
    }

    for (let v = lo; v <= hi; v += step) {
      out.add(normalize(v));
    }
  }

  if (out.size === 0) throw new CronParseError(`Cron field "${raw}" matched no values.`);
  return { values: out, restricted };
}

/** Parses + validates a standard 5-field cron string. Throws on malformed input. */
export function parseCron(cron: string): ParsedCron {
  if (typeof cron !== "string") throw new CronParseError("Cron must be a string.");
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronParseError(
      `Cron must have exactly 5 fields (got ${fields.length}): "${cron}".`,
    );
  }
  const minute = parseField(fields[0]!, 0);
  const hour = parseField(fields[1]!, 1);
  const dom = parseField(fields[2]!, 2);
  const month = parseField(fields[3]!, 3);
  const dow = parseField(fields[4]!, 4);
  return {
    minute: minute.values,
    hour: hour.values,
    dom: dom.values,
    month: month.values,
    dow: dow.values,
    domRestricted: dom.restricted,
    dowRestricted: dow.restricted,
  };
}

/** Validates a cron string; throws (CronParseError) when malformed. */
export function validateCron(cron: string): void {
  parseCron(cron);
}

// ---------------------------------------------------------------------------
// Timezone projection
// ---------------------------------------------------------------------------

/** Wall-clock fields of an instant projected into a timezone. */
interface WallClock {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  dow: number; // 0=Sun
}

const DOW_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Projects a UTC instant into the given IANA timezone's wall-clock fields. */
function toWallClock(date: Date, timezone: string): WallClock {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      weekday: "short",
    });
  } catch {
    throw new CronParseError(`Invalid timezone: "${timezone}".`);
  }
  const parts = fmt.formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  let hour = Number(get("hour"));
  // Intl can emit "24" for midnight under hour12:false in some engines.
  if (hour === 24) hour = 0;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour,
    minute: Number(get("minute")),
    dow: DOW_INDEX[get("weekday")] ?? 0,
  };
}

/** True iff a projected wall-clock instant matches the parsed cron. */
function wallClockMatches(wc: WallClock, p: ParsedCron): boolean {
  if (!p.minute.has(wc.minute)) return false;
  if (!p.hour.has(wc.hour)) return false;
  if (!p.month.has(wc.month)) return false;

  // dom / dow OR-semantics.
  const domOk = p.dom.has(wc.day);
  const dowOk = p.dow.has(wc.dow);
  if (p.domRestricted && p.dowRestricted) {
    return domOk || dowOk;
  }
  if (p.domRestricted) return domOk;
  if (p.dowRestricted) return dowOk;
  return true; // both "*"
}

// ---------------------------------------------------------------------------
// nextFireAfter
// ---------------------------------------------------------------------------

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
/**
 * Absolute lookahead horizon (ms). A valid 5-field cron fires at least once
 * every ~year (the sparsest is "once a year"), so 5 years is a safe ceiling; an
 * impossible cron (e.g. Feb 31) blows past it and throws. We bound on ELAPSED
 * TIME rather than step count so the coarse-skip can't be defeated into a
 * multi-million-iteration minute scan.
 */
const MAX_LOOKAHEAD_MS = 5 * 366 * MS_PER_DAY;

/**
 * Returns the next time the cron fires STRICTLY AFTER `afterISO`, evaluated in
 * `timezone`, as a UTC ISO 8601 string (second/ms = 0).
 *
 * Algorithm: start at the first whole minute strictly after `after`, project
 * each candidate into `timezone`, and return the first match. To stay fast for
 * sparse crons (e.g. "0 0 1 2 *" — once a year) we COARSE-SKIP: if the
 * candidate's month/day-of-{month,week} can't match, jump forward a whole day
 * (re-aligned to local midnight); if the hour can't match, jump a whole hour
 * (re-aligned to :00). This is still robust across DST + month/year boundaries
 * because every candidate is re-projected through Intl after the jump — we only
 * use the skip to avoid scanning minutes we know can't match.
 */
export function nextFireAfter(cron: string, afterISO: string, timezone = "UTC"): string {
  const parsed = parseCron(cron);
  const afterMs = Date.parse(afterISO);
  if (!Number.isFinite(afterMs)) {
    throw new CronParseError(`Invalid "after" timestamp: "${afterISO}".`);
  }

  // Advance to the first whole-minute boundary STRICTLY after `after` ("strictly
  // after" semantics: an exact minute match does not re-fire).
  let cursorMs = Math.floor(afterMs / MS_PER_MINUTE) * MS_PER_MINUTE + MS_PER_MINUTE;

  // Does the date (month + dom/dow OR-rule) match this wall-clock day?
  const dayMatches = (wc: WallClock): boolean => {
    if (!parsed.month.has(wc.month)) return false;
    const domOk = parsed.dom.has(wc.day);
    const dowOk = parsed.dow.has(wc.dow);
    if (parsed.domRestricted && parsed.dowRestricted) return domOk || dowOk;
    if (parsed.domRestricted) return domOk;
    if (parsed.dowRestricted) return dowOk;
    return true;
  };

  const deadlineMs = cursorMs + MAX_LOOKAHEAD_MS;
  while (cursorMs <= deadlineMs) {
    const candidate = new Date(cursorMs);
    const wc = toWallClock(candidate, timezone);

    if (!dayMatches(wc)) {
      // Skip the rest of this local day: jump to the next local midnight.
      const intoDayMs = (wc.hour * 60 + wc.minute) * MS_PER_MINUTE;
      cursorMs += MS_PER_DAY - intoDayMs;
      continue;
    }
    if (!parsed.hour.has(wc.hour)) {
      // Skip the rest of this local hour: jump to the next local :00.
      cursorMs += MS_PER_HOUR - wc.minute * MS_PER_MINUTE;
      continue;
    }
    if (!parsed.minute.has(wc.minute)) {
      cursorMs += MS_PER_MINUTE;
      continue;
    }
    return candidate.toISOString();
  }

  throw new CronParseError(
    `Cron "${cron}" produced no fire time within the lookahead window of ${afterISO}.`,
  );
}
