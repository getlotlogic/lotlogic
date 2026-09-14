// ── Lot-local calendar dates ─────────────────────────────────
// Every LotLogic property is in Eastern time today. The Parking Log's date
// filters are calendar dates the operator picked while standing in the lot, so
// they have to be turned into instants in the LOT's zone, not the browser's and
// not UTC. Sending a bare date, or one stamped with `Z`, ended the day at
// 19:59:59 Eastern — every truck that registered between 8 PM and midnight fell
// outside "today" in the log and in the CSV export.
// Wave 2 (property config): every property still resolves to Eastern today
// (no property has a configured timezone yet), so this constant stays as
// the default `timeZone` for every function below. A caller that knows a
// property's configured zone (`property.config?.timezone`) passes it in.
export const LOT_TIMEZONE = 'America/New_York';

// The UTC offset in force in `timeZone` on the calendar day `ymd` ("-04:00").
// Anchored at 12:00 UTC of that day — i.e. mid-morning Eastern, safely past the
// 2 AM DST switch — so both ends of the day get the day's own offset.
export function tzOffsetOn(ymd, timeZone = LOT_TIMEZONE) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(`${ymd}T12:00:00Z`));
    const name = (parts.find(p => p.type === 'timeZoneName') || {}).value || '';
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
    if (!m) return name === 'GMT' ? '+00:00' : null;
    return `${m[1]}${m[2].padStart(2, '0')}:${m[3] || '00'}`;
  } catch { return null; }
}

// The UTC offset in force in `timeZone` at a specific instant — unlike
// tzOffsetOn (anchored at 12:00 UTC of a calendar day), this reads the
// offset at the exact Date given, so a bound built near a DST transition
// (2 AM local) gets its own offset instead of borrowing midday's.
export function tzOffsetAt(date, timeZone = LOT_TIMEZONE) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(date);
    const name = (parts.find(p => p.type === 'timeZoneName') || {}).value || '';
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
    if (!m) return name === 'GMT' ? '+00:00' : null;
    return `${m[1]}${m[2].padStart(2, '0')}:${m[3] || '00'}`;
  } catch { return null; }
}

// "2026-09-03" → "2026-09-03T00:00:00.000-04:00" / "...T23:59:59.999-04:00".
// Anything that is not a bare calendar date is passed straight through, because
// the caller already sent a full timestamp.
// `timeZone` defaults to LOT_TIMEZONE, so a caller that never passes one (or
// passes undefined, e.g. a property whose config has never been written)
// gets byte-identical output to before this argument existed.
export function lotDayBound(ymd, edge, timeZone = LOT_TIMEZONE) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || '')) return ymd;
  const time = edge === 'end' ? '23:59:59.999' : '00:00:00.000';
  let off = tzOffsetOn(ymd, timeZone);
  if (!off) return ymd; // No Intl offset support: leave the old behaviour alone.
  const refined = tzOffsetAt(new Date(`${ymd}T${time}${off}`), timeZone);
  return `${ymd}T${time}${refined || off}`;
}

