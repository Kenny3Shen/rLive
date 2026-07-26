import type { HistoryItem, SiteId } from "@/shared/types/live";

/**
 * The app's viewing history is a record of entering a room, not a playback
 * duration log. All counts in this module therefore mean currently stored
 * viewing records, never watched time.
 */
export type ViewingRecordDay = {
  /** China calendar date in `YYYY-MM-DD` form. */
  date: string;
  /** Number of records whose latest viewing timestamp falls on this date. */
  recordCount: number;
};

export type PlatformViewingRecord = {
  siteId: SiteId;
  /** Number of viewing records for this platform. */
  recordCount: number;
};

export type ViewingRecordStatistics = {
  /** Total stored viewing records (not playback duration). */
  totalRecords: number;
  /** Distinct rooms, identified by the platform and room ID together. */
  distinctRooms: number;
  /** Number of platforms represented in the stored viewing records. */
  distinctPlatforms: number;
  /** Viewing records whose China calendar date is today. */
  todayRecords: number;
  /** Zero-filled, chronological China-calendar-day counts ending today. */
  last7Days: ViewingRecordDay[];
  /** Non-zero platform record counts, ordered by count then platform ID. */
  platformDistribution: PlatformViewingRecord[];
};

const CHINA_TIME_ZONE = "Asia/Shanghai";
const LAST_CALENDAR_DAYS = 7;

const chinaDateFormatter = new Intl.DateTimeFormat("en-CA", {
  calendar: "gregory",
  numberingSystem: "latn",
  timeZone: CHINA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

type CalendarDate = {
  year: number;
  month: number;
  day: number;
};

function dateKey({ year, month, day }: CalendarDate): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Gets a date in China time without relying on the machine's local timezone.
 * `formatToParts` avoids locale-specific punctuation and field ordering.
 */
function chinaCalendarDate(date: Date): CalendarDate | null {
  if (Number.isNaN(date.getTime())) return null;

  const parts = chinaDateFormatter.formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = Number(values.get("year"));
  const month = Number(values.get("month"));
  const day = Number(values.get("day"));

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  return { year, month, day };
}

function chinaDateKey(timestamp: number): string | null {
  if (!Number.isFinite(timestamp)) return null;
  const calendarDate = chinaCalendarDate(new Date(timestamp));
  return calendarDate ? dateKey(calendarDate) : null;
}

function calendarDayKeysEndingAt(today: CalendarDate): string[] {
  // This is calendar arithmetic on nominal dates, rather than subtracting
  // 24-hour intervals from an instant. It remains correct over month/year
  // boundaries and deliberately has no dependency on the host timezone.
  const end = Date.UTC(today.year, today.month - 1, today.day);

  return Array.from({ length: LAST_CALENDAR_DAYS }, (_, index) => {
    const cursor = new Date(end);
    cursor.setUTCDate(cursor.getUTCDate() - (LAST_CALENDAR_DAYS - 1 - index));
    return dateKey({
      year: cursor.getUTCFullYear(),
      month: cursor.getUTCMonth() + 1,
      day: cursor.getUTCDate(),
    });
  });
}

/**
 * Summarizes the currently stored room-entry records for the statistics page.
 *
 * The optional `now` parameter makes the calendar window reproducible in
 * tests. Dates are always grouped in `Asia/Shanghai`, regardless of the
 * desktop's configured timezone.
 */
export function aggregateViewingRecordStatistics(
  records: readonly HistoryItem[],
  now: Date = new Date(),
): ViewingRecordStatistics {
  const today = chinaCalendarDate(now);
  if (!today) {
    throw new RangeError("Expected a valid reference date for viewing-record statistics");
  }

  const todayKey = dateKey(today);
  const last7DayKeys = calendarDayKeysEndingAt(today);
  const last7DayKeySet = new Set(last7DayKeys);
  const countsByDay = new Map(last7DayKeys.map((key) => [key, 0]));
  const countsByPlatform = new Map<SiteId, number>();
  const distinctRoomKeys = new Set<string>();
  const distinctPlatformIds = new Set<SiteId>();
  let todayRecords = 0;
  let totalRecords = 0;

  for (const record of records) {
    const watchedDateKey = chinaDateKey(record.watched_at);
    // A history record should always have a valid millisecond timestamp. Skip
    // malformed input rather than allowing it to distort a calendar chart.
    if (!watchedDateKey) continue;

    totalRecords += 1;
    distinctRoomKeys.add(`${record.site_id}\u0000${record.room_id}`);
    distinctPlatformIds.add(record.site_id);
    countsByPlatform.set(record.site_id, (countsByPlatform.get(record.site_id) ?? 0) + 1);

    if (watchedDateKey === todayKey) todayRecords += 1;
    if (last7DayKeySet.has(watchedDateKey)) {
      countsByDay.set(watchedDateKey, (countsByDay.get(watchedDateKey) ?? 0) + 1);
    }
  }

  return {
    totalRecords,
    distinctRooms: distinctRoomKeys.size,
    distinctPlatforms: distinctPlatformIds.size,
    todayRecords,
    last7Days: last7DayKeys.map((date) => ({
      date,
      recordCount: countsByDay.get(date) ?? 0,
    })),
    platformDistribution: [...countsByPlatform.entries()]
      .map(([siteId, recordCount]) => ({ siteId, recordCount }))
      .sort(
        (left, right) =>
          right.recordCount - left.recordCount || left.siteId.localeCompare(right.siteId),
      ),
  };
}
