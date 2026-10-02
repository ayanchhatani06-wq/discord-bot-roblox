/**
 * All timezone handling goes through IANA identifiers and the Intl API, which
 * carries the current DST rules. Abbreviations like "PST" and country names are
 * deliberately not accepted as input: they are ambiguous (several countries
 * span multiple zones) and they do not describe summer time.
 */

const CANONICAL_TIMEZONES = Intl.supportedValuesOf('timeZone');
// Intl enumerates canonical zones only, which leaves out plain "UTC" even
// though it is a reasonable choice for someone who wants a neutral zone.
const EXTRA_ALLOWED_TIMEZONES = ['UTC'];
const VALID_TIMEZONES = [...EXTRA_ALLOWED_TIMEZONES, ...CANONICAL_TIMEZONES];
const VALID_TIMEZONE_SET = new Set(VALID_TIMEZONES);

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Checked against an allowlist rather than by trying Intl and catching the
 * error: V8 happily formats "PST" and "EST", and those are exactly the
 * ambiguous, DST-blind abbreviations staff must not be able to choose.
 */
function isValidTimezone(timezone) {
  return VALID_TIMEZONE_SET.has(timezone);
}

/**
 * Reads `GMT+5`, `utc+5:30`, `+5` and `gmt5` as an offset in minutes.
 *
 * People think in offsets and the studio's boards are written in them, so the
 * search has to take one. What it must not do is store one: a fixed offset
 * has no daylight-saving rules, so this turns the offset into a list of real
 * places at that offset and lets somebody say which they are in.
 *
 * Returns null for anything that is not an offset, including a plain number,
 * which is far more likely to be somebody part-way through typing a name.
 */
function parseOffsetQuery(query) {
  const cleaned = String(query ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (cleaned === 'gmt' || cleaned === 'utc') return 0;

  const match = cleaned.match(/^(?:gmt|utc)?([+-])?(\d{1,2})(?::?([0-5]\d))?$/);
  if (!match) return null;

  const [, sign, hours, minutes] = match;
  // A bare number is ambiguous, so an offset must say so: either a sign or a
  // GMT/UTC prefix. `5` stays a name search; `+5` and `gmt5` are offsets.
  const prefixed = /^(?:gmt|utc)/.test(String(query ?? '').trim().toLowerCase());
  if (!sign && !prefixed) return null;

  const total = Number(hours) * 60 + Number(minutes || 0);
  if (total > 14 * 60) return null;
  return sign === '-' ? -total : total;
}

/**
 * Zones people actually live in, floated to the top of an offset search.
 *
 * Alphabetical order answers "GMT+5" with Antarctica/Mawson, which is correct
 * and useless. This is not a complete list and is not meant to be: it is the
 * places a studio's staff are likely to be, so the right answer is visible
 * without scrolling. Anything missing is still in the list below it.
 */
const COMMON_TIMEZONES = Object.freeze([
  'Pacific/Auckland', 'Australia/Sydney', 'Australia/Brisbane', 'Australia/Perth',
  'Asia/Tokyo', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Singapore',
  'Asia/Manila', 'Asia/Jakarta', 'Asia/Bangkok', 'Asia/Saigon',
  'Asia/Dhaka', 'Asia/Katmandu', 'Asia/Calcutta', 'Asia/Colombo',
  'Asia/Karachi', 'Asia/Tashkent', 'Asia/Dubai', 'Asia/Tehran', 'Asia/Baghdad',
  'Asia/Riyadh', 'Asia/Jerusalem', 'Europe/Istanbul', 'Africa/Cairo',
  'Africa/Johannesburg', 'Africa/Nairobi', 'Africa/Lagos', 'Africa/Casablanca',
  'Europe/Moscow', 'Europe/Athens', 'Europe/Kiev', 'Europe/Bucharest',
  'Europe/Berlin', 'Europe/Paris', 'Europe/Madrid', 'Europe/Rome',
  'Europe/Amsterdam', 'Europe/Warsaw', 'Europe/Belgrade', 'Europe/Stockholm',
  'Europe/London', 'Europe/Dublin', 'Europe/Lisbon',
  'America/Sao_Paulo', 'America/Buenos_Aires', 'America/Santiago',
  'America/New_York', 'America/Toronto', 'America/Bogota', 'America/Lima',
  'America/Guayaquil', 'America/Chicago', 'America/Mexico_City',
  'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage',
  'Pacific/Honolulu', 'UTC',
]);

const COMMON_RANK = new Map(COMMON_TIMEZONES.map((tz, index) => [tz, index]));

// Regions where almost nobody works, kept but pushed below the rest.
const THIN_REGIONS = /^(Antarctica|Etc|Indian|Pacific|Atlantic|Arctic)\//;

/** Every zone sitting at that offset right now, most likely answers first. */
function timezonesAtOffset(offsetMinutes, limit = 25, at = new Date()) {
  const matches = [];
  for (const tz of VALID_TIMEZONES) {
    let offset;
    try {
      offset = getOffsetMinutes(tz, at);
    } catch {
      continue;
    }
    // Collected in full before sorting: stopping at the limit first would rank
    // whatever the alphabet happened to reach, which is the bug this fixes.
    if (offset === offsetMinutes) matches.push(tz);
  }

  const score = (tz) => {
    if (COMMON_RANK.has(tz)) return COMMON_RANK.get(tz);
    return THIN_REGIONS.test(tz) ? 20000 : 10000;
  };

  matches.sort((a, b) => (score(a) - score(b)) || a.localeCompare(b));
  return matches.slice(0, limit);
}

function searchTimezones(query, limit = 25) {
  // An offset is answered with the places at it, so somebody who thinks in
  // GMT+5 never has to know that the stored answer is called Asia/Karachi.
  const offset = parseOffsetQuery(query);
  if (offset !== null) {
    const matches = timezonesAtOffset(offset, limit);
    if (matches.length > 0) return matches;
  }

  const normalized = String(query ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  if (!normalized) return VALID_TIMEZONES.slice(0, limit);

  const starts = [];
  const contains = [];
  for (const tz of VALID_TIMEZONES) {
    const lower = tz.toLowerCase();
    if (lower.startsWith(normalized)) starts.push(tz);
    else if (lower.includes(normalized)) contains.push(tz);
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}

const partsFormatterCache = new Map();

function partsFormatter(timeZone) {
  let formatter = partsFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    partsFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * The wall-clock reading in `timeZone` at a given instant. Uses formatToParts
 * rather than parsing a formatted string, which avoids locale quirks.
 */
function getZonedParts(date, timeZone) {
  const parts = partsFormatter(timeZone).formatToParts(date);
  const lookup = {};
  for (const part of parts) {
    if (part.type !== 'literal') lookup[part.type] = part.value;
  }
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
    second: Number(lookup.second),
    weekday: lookup.weekday,
  };
}

/**
 * Offset in minutes east of UTC for `timeZone` at `date` (DST-aware).
 */
function getOffsetMinutes(timeZone, date = new Date()) {
  const parts = getZonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - date.getTime()) / MINUTE_MS);
}

function formatOffsetLabel(offsetMinutes) {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, '0');
  const minutes = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hours}:${minutes}`;
}

/**
 * The short form people actually say: GMT+5, GMT-5, GMT+5:30, GMT.
 *
 * `Asia/Karachi` is the correct thing to store — it survives daylight saving,
 * which a fixed offset does not — but it is not what somebody means when they
 * ask where a colleague is. This is for reading; the zone name stays the truth.
 *
 * Computed at render time rather than stored, so a zone that moves for summer
 * shows the offset that is true today instead of the one true when it was set.
 */
function formatGmtLabel(offsetMinutes) {
  if (offsetMinutes === 0) return 'GMT';
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  // Half-hour and 45-minute zones are real (India, Nepal, parts of Australia),
  // so the minutes are kept when there are any and dropped when there are not.
  return `GMT${sign}${hours}${minutes > 0 ? `:${String(minutes).padStart(2, '0')}` : ''}`;
}

/** The same label straight from a zone name, for callers that have no offset. */
function gmtLabelFor(timeZone, at = new Date()) {
  if (!timeZone) return null;
  try {
    return formatGmtLabel(getOffsetMinutes(timeZone, at));
  } catch {
    return null;
  }
}

function formatTimeInZone(timeZone, at = new Date()) {
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(at);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(at);
  return `${time} (${weekday})`;
}

function formatDateTimeInZone(timeZone, at = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(at);
}

/**
 * Discord renders these in each viewer's own local time, so deadlines never
 * need to be re-rendered per person.
 * Styles: t short time, T long time, d short date, D long date,
 *         f short date+time, F full, R relative.
 */
function discordTimestamp(msOrDate, style = 'F') {
  const ms = msOrDate instanceof Date ? msOrDate.getTime() : Number(msOrDate);
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

/**
 * Converts a wall-clock reading in `timeZone` to a UTC instant.
 *
 * Two awkward cases are reported rather than guessed at:
 *  - the hour skipped when clocks go forward does not exist;
 *  - the hour repeated when clocks go back happens twice.
 */
function wallTimeToUtc({ year, month, day, hour = 0, minute = 0 }, timeZone) {
  if (!isValidTimezone(timeZone)) {
    return { ok: false, reason: 'invalid_timezone' };
  }

  const asUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const probeOffsets = new Set([
    getOffsetMinutes(timeZone, new Date(asUtc)),
    getOffsetMinutes(timeZone, new Date(asUtc - 12 * HOUR_MS)),
    getOffsetMinutes(timeZone, new Date(asUtc + 12 * HOUR_MS)),
  ]);

  const matches = [];
  for (const offset of probeOffsets) {
    const candidate = asUtc - offset * MINUTE_MS;
    const parts = getZonedParts(new Date(candidate), timeZone);
    const roundTrips =
      parts.year === year &&
      parts.month === month &&
      parts.day === day &&
      parts.hour === hour &&
      parts.minute === minute;
    if (roundTrips && !matches.some((m) => m.utcMs === candidate)) {
      matches.push({ utcMs: candidate, offsetMinutes: offset });
    }
  }

  if (matches.length === 0) {
    return { ok: false, reason: 'nonexistent_local_time' };
  }

  matches.sort((a, b) => a.utcMs - b.utcMs);
  return {
    ok: true,
    utcMs: matches[0].utcMs,
    offsetMinutes: matches[0].offsetMinutes,
    ambiguous: matches.length > 1,
    alternatives: matches.slice(1),
  };
}

/**
 * Accepts "YYYY-MM-DD HH:mm" or "YYYY-MM-DD" (treated as 23:59 local, which the
 * confirmation preview states explicitly so nobody has to guess).
 */
function parseDeadlineInput(text, timeZone) {
  const raw = String(text ?? '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (!match) {
    return { ok: false, reason: 'unparsable', hint: 'Use YYYY-MM-DD or YYYY-MM-DD HH:mm (24-hour).' };
  }

  const [, y, mo, d, h, mi] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = h === undefined ? 23 : Number(h);
  const minute = mi === undefined ? 59 : Number(mi);
  const impliedEndOfDay = h === undefined;

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    return { ok: false, reason: 'out_of_range' };
  }

  const converted = wallTimeToUtc({ year, month, day, hour, minute }, timeZone);
  if (!converted.ok) return converted;

  return {
    ok: true,
    utcMs: converted.utcMs,
    offsetMinutes: converted.offsetMinutes,
    ambiguous: converted.ambiguous,
    impliedEndOfDay,
    timeZone,
    preview: `${formatDateTimeInZone(timeZone, new Date(converted.utcMs))} ${timeZone} (${formatOffsetLabel(converted.offsetMinutes)})`,
  };
}

function minutesSinceMidnight(date, timeZone) {
  const parts = getZonedParts(date, timeZone);
  return parts.hour * 60 + parts.minute;
}

function parseClockInput(text) {
  const match = String(text ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function formatClockMinutes(minutes) {
  if (minutes === null || minutes === undefined) return null;
  const hour = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Windows are interpreted in the staff member's own timezone and may wrap past
 * midnight (22:00-07:00 is a normal quiet-hours setting).
 */
function isWithinWindow(nowMinutes, startMinutes, endMinutes) {
  if (startMinutes === null || startMinutes === undefined) return false;
  if (endMinutes === null || endMinutes === undefined) return false;
  if (startMinutes === endMinutes) return false;
  if (startMinutes < endMinutes) return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

function isWithinQuietHours({ at = new Date(), timeZone, quietStartMinute, quietEndMinute }) {
  if (!timeZone || !isValidTimezone(timeZone)) return false;
  if (quietStartMinute === null || quietStartMinute === undefined) return false;
  if (quietEndMinute === null || quietEndMinute === undefined) return false;
  return isWithinWindow(minutesSinceMidnight(at, timeZone), quietStartMinute, quietEndMinute);
}

/**
 * When quiet hours are active, the instant they end — so a reminder can be
 * deferred rather than dropped.
 */
function quietHoursEndAt({ at = new Date(), timeZone, quietStartMinute, quietEndMinute }) {
  if (!isWithinQuietHours({ at, timeZone, quietStartMinute, quietEndMinute })) return null;

  const parts = getZonedParts(at, timeZone);
  const nowMinutes = parts.hour * 60 + parts.minute;
  const endsTomorrow = quietStartMinute > quietEndMinute && nowMinutes >= quietStartMinute;
  const base = { year: parts.year, month: parts.month, day: parts.day };

  const target = wallTimeToUtc(
    {
      ...base,
      hour: Math.floor(quietEndMinute / 60),
      minute: quietEndMinute % 60,
    },
    timeZone
  );

  if (!target.ok) return at.getTime() + HOUR_MS;
  return endsTomorrow ? target.utcMs + DAY_MS : target.utcMs;
}

function isWithinWorkingHours({ at = new Date(), timeZone, workingDays, workingStartMinute, workingEndMinute }) {
  if (!timeZone || !isValidTimezone(timeZone)) return null;
  if (workingStartMinute === null || workingStartMinute === undefined) return null;

  const parts = getZonedParts(at, timeZone);
  const weekdayIndex = WEEKDAY_LABELS.findIndex((label) => label.startsWith(parts.weekday));
  const days = normalizeWorkingDays(workingDays);
  if (days && days.length > 0 && !days.includes(weekdayIndex)) return false;

  return isWithinWindow(parts.hour * 60 + parts.minute, workingStartMinute, workingEndMinute);
}

function normalizeWorkingDays(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value.map(Number).filter((n) => n >= 0 && n <= 6);
  return String(value)
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .map((part) => (/^\d$/.test(part) ? Number(part) : WEEKDAY_KEYS.indexOf(part)))
    .filter((n) => n >= 0 && n <= 6);
}

function formatWorkingDays(value) {
  const days = normalizeWorkingDays(value);
  if (!days || days.length === 0) return null;
  return days.map((index) => WEEKDAY_LABELS[index].slice(0, 3)).join(', ');
}

module.exports = {
  MINUTE_MS,
  HOUR_MS,
  DAY_MS,
  WEEKDAY_KEYS,
  WEEKDAY_LABELS,
  isValidTimezone,
  searchTimezones,
  getZonedParts,
  getOffsetMinutes,
  formatOffsetLabel,
  formatGmtLabel,
  gmtLabelFor,
  parseOffsetQuery,
  timezonesAtOffset,
  COMMON_TIMEZONES,
  formatTimeInZone,
  formatDateTimeInZone,
  discordTimestamp,
  wallTimeToUtc,
  parseDeadlineInput,
  minutesSinceMidnight,
  parseClockInput,
  formatClockMinutes,
  isWithinWindow,
  isWithinQuietHours,
  quietHoursEndAt,
  isWithinWorkingHours,
  normalizeWorkingDays,
  formatWorkingDays,
};
