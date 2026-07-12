export function getManilaDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const values = {};

  parts.forEach(part => {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  });

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day)
  };
}

export function createDateFromParts({
  year,
  month,
  day
}) {
  return new Date(
    Date.UTC(
      year,
      month - 1,
      day,
      12,
      0,
      0
    )
  );
}

export function addDays(date, days) {
  const copy = new Date(date);

  copy.setUTCDate(
    copy.getUTCDate() + days
  );

  return copy;
}

export function formatDateKey(date) {
  return date
    .toISOString()
    .slice(0, 10);
}

export function getMondayOfCurrentWeek() {
  const manilaParts =
    getManilaDateParts();

  const today =
    createDateFromParts(manilaParts);

  const weekday =
    today.getUTCDay();

  const daysSinceMonday =
    weekday === 0
      ? 6
      : weekday - 1;

  return addDays(
    today,
    -daysSinceMonday
  );
}

export function getPlanningWeekStart() {
  const manilaParts =
    getManilaDateParts();

  const today =
    createDateFromParts(manilaParts);

  const currentWeekMonday =
    getMondayOfCurrentWeek();

  const isSunday =
    today.getUTCDay() === 0;

  return isSunday
    ? addDays(currentWeekMonday, 7)
    : currentWeekMonday;
}

export function parseDateValue(value) {
  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    return null;
  }

  const match = value
    .trim()
    .match(
      /^(\d{4})-(\d{2})-(\d{2})$/
    );

  if (!match) {
    return null;
  }

  const parsedDate =
    new Date(
      Date.UTC(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        12,
        0,
        0
      )
    );

  return Number.isNaN(
    parsedDate.getTime()
  )
    ? null
    : parsedDate;
}

export function calculateWeeksUntilRace(
  raceDate,
  weekStart
) {
  if (!raceDate) {
    return null;
  }

  const milliseconds =
    raceDate.getTime() -
    weekStart.getTime();

  return Math.ceil(
    milliseconds /
      (7 * 24 * 60 * 60 * 1000)
  );
}