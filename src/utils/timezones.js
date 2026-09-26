const VALID_TIMEZONES = Intl.supportedValuesOf('timeZone');
const VALID_TIMEZONE_SET = new Set(VALID_TIMEZONES);

function isValidTimezone(timezone) {
  return VALID_TIMEZONE_SET.has(timezone);
}

function searchTimezones(query, limit = 25) {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, '_');
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

function getOffsetMinutes(timezone, at = new Date()) {
  const tzDate = new Date(at.toLocaleString('en-US', { timeZone: timezone }));
  const utcDate = new Date(at.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.round((tzDate.getTime() - utcDate.getTime()) / 60000);
}

function formatOffsetLabel(offsetMinutes) {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, '0');
  const minutes = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hours}:${minutes}`;
}

function formatTimeInZone(timezone, at = new Date()) {
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(at);
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  }).format(at);
  return `${time} (${weekday})`;
}

module.exports = {
  isValidTimezone,
  searchTimezones,
  getOffsetMinutes,
  formatOffsetLabel,
  formatTimeInZone,
};
