/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Calendar-Week Engine  (pure, timezone-aware, Monday weeks)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Replaces rolling-7-day windows with TRUE calendar weeks (Mon 00:00 →
 *  Sun 23:59:59.999) in the athlete's timezone. Everything here is pure
 *  and deterministic so it can be unit-tested without a browser.
 *
 *  Three windows the Trends screen needs (example: Wednesday 4:00 PM):
 *    · thisWeek            Monday 00:00 → now  (partial)
 *    · lastWeekSamePeriod  previous Monday 00:00 → previous Wednesday 4:00 PM
 *    · prevFullWeek        previous Monday 00:00 → previous Sunday 23:59:59
 *
 *  Timezone handling: pass the athlete's stored IANA timezone; we fall
 *  back to Asia/Manila only when none is set or it is invalid. We bucket
 *  each activity by its LOCAL civil day/time in that timezone using a
 *  wall-clock representation (a pseudo-UTC instant built from the local
 *  Y/M/D/H/M/S), which is DST-safe for day-granular weekly bucketing and
 *  needs no timezone library.
 */

(function () {
  "use strict";

  const MONTHS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
  ];

  const DEFAULT_TZ = "Asia/Manila";

  // Validate an IANA timezone; fall back to Asia/Manila.
  function resolveTimezone(tz) {
    if (typeof tz === "string" && tz.trim()) {
      try {
        new Intl.DateTimeFormat("en-CA", { timeZone: tz.trim() });
        return tz.trim();
      } catch (error) {
        /* invalid → fall through */
      }
    }
    return DEFAULT_TZ;
  }

  // Local civil Y/M/D/H/M/S in `tz` for an instant.
  function localCivil(instant, tz) {
    const date = instant instanceof Date ? instant : new Date(instant);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false
    }).formatToParts(date);

    const v = {};
    for (const p of parts) if (p.type !== "literal") v[p.type] = p.value;

    let H = Number(v.hour);
    if (H === 24) H = 0; // some ICU builds emit "24" at midnight
    return {
      y: Number(v.year), m: Number(v.month), d: Number(v.day),
      H, M: Number(v.minute), S: Number(v.second)
    };
  }

  // A comparable wall-clock instant (pseudo-UTC) from civil parts.
  function pseudo(y, m, d, H, M, S) {
    return Date.UTC(y, m - 1, d, H || 0, M || 0, S || 0);
  }

  // Weekday of a civil date, 0 = Sunday … 6 = Saturday.
  function weekdayOf(y, m, d) {
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  }

  // Civil date arithmetic (safe across month/year boundaries).
  function addDays(y, m, d, n) {
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  }

  function rangeLabel(start, end) {
    if (start.m === end.m) {
      return `${MONTHS[start.m - 1]} ${start.d}–${end.d}`;
    }
    return `${MONTHS[start.m - 1]} ${start.d}–${MONTHS[end.m - 1]} ${end.d}`;
  }

  /*
   * The three comparison windows for `now` in `tz`. Each window is
   * expressed as { start, end } wall-clock instants; use `bucket()` to
   * test membership so the inclusive/exclusive rules are applied for you.
   */
  function weekWindows(now, tz) {
    tz = resolveTimezone(tz);
    const nowInstant = now == null ? new Date() : now;
    const c = localCivil(nowInstant, tz);
    const wd = weekdayOf(c.y, c.m, c.d);
    const daysSinceMon = (wd + 6) % 7;

    const mon = addDays(c.y, c.m, c.d, -daysSinceMon);
    const lastMon = addDays(mon.y, mon.m, mon.d, -7);
    const lastSameDay = addDays(lastMon.y, lastMon.m, lastMon.d, daysSinceMon);

    const thisMonMid = pseudo(mon.y, mon.m, mon.d, 0, 0, 0);
    const nowPseudo = pseudo(c.y, c.m, c.d, c.H, c.M, c.S);
    const lastMonMid = pseudo(lastMon.y, lastMon.m, lastMon.d, 0, 0, 0);
    const lastSameEnd = pseudo(
      lastSameDay.y, lastSameDay.m, lastSameDay.d, c.H, c.M, c.S
    );

    return {
      timezone: tz,
      nowPseudo,
      thisWeek: { start: thisMonMid, end: nowPseudo, partial: true, endInclusive: true },
      lastWeekSamePeriod: { start: lastMonMid, end: lastSameEnd, partial: true, endInclusive: true },
      prevFullWeek: { start: lastMonMid, end: thisMonMid, partial: false, endInclusive: false },
      thisWeekLabel: rangeLabel(mon, addDays(mon.y, mon.m, mon.d, 6))
    };
  }

  // Test whether an instant falls inside a window (respecting the
  // inclusive/exclusive end rule).
  function inWindow(instant, window, tz) {
    tz = resolveTimezone(tz);
    const c = localCivil(instant, tz);
    const p = pseudo(c.y, c.m, c.d, c.H, c.M, c.S);
    return window.endInclusive
      ? p >= window.start && p <= window.end
      : p >= window.start && p < window.end;
  }

  /*
   * Six true Monday–Sunday weeks ending with the current (partial) week.
   * Each entry carries a real date-range label and an `inProgress` flag
   * for the current week. Use `bucketIndex()` to place an activity.
   */
  function sixWeeks(now, tz) {
    tz = resolveTimezone(tz);
    const nowInstant = now == null ? new Date() : now;
    const c = localCivil(nowInstant, tz);
    const wd = weekdayOf(c.y, c.m, c.d);
    const daysSinceMon = (wd + 6) % 7;
    const mon = addDays(c.y, c.m, c.d, -daysSinceMon);

    const weeks = [];
    for (let i = 0; i < 6; i += 1) {
      const start = addDays(mon.y, mon.m, mon.d, -(5 - i) * 7);
      const end = addDays(start.y, start.m, start.d, 6);
      const nextMon = addDays(start.y, start.m, start.d, 7);
      weeks.push({
        index: i,
        startCivil: start,
        endCivil: end,
        start: pseudo(start.y, start.m, start.d, 0, 0, 0),
        endExclusive: pseudo(nextMon.y, nextMon.m, nextMon.d, 0, 0, 0),
        label: rangeLabel(start, end),
        inProgress: i === 5
      });
    }
    return weeks;
  }

  // Index (0–5) of the six-week series an instant falls into, or -1.
  function bucketIndex(instant, weeks, tz) {
    tz = resolveTimezone(tz);
    const c = localCivil(instant, tz);
    const p = pseudo(c.y, c.m, c.d, c.H, c.M, c.S);
    for (const w of weeks) {
      if (p >= w.start && p < w.endExclusive) return w.index;
    }
    return -1;
  }

  window.AthlevoCalendar = {
    resolveTimezone,
    localCivil,
    weekWindows,
    inWindow,
    sixWeeks,
    bucketIndex,
    rangeLabel,
    DEFAULT_TZ
  };
})();
