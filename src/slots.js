import { zonedToUtc, localDate, localTime, addDays, weekdayOf } from './time.js';

// Free meeting slots. The model never computes availability: it only sees
// what this function returns.
//
// busy: [{ start, end }] in ISO, or { allDay: true, date: 'YYYY-MM-DD' } for
// all-day events (a holiday calendar blocks the whole day this way).
export function freeSlots({ busy, now, cfg }) {
  const tz = cfg.timezone;
  const today = localDate(now, tz);
  const gap = cfg.gapMinutes * 60000;
  const dur = cfg.durationMinutes * 60000;
  const earliest = now.getTime() + cfg.minNoticeMinutes * 60000;
  const blockedDays = new Set([...(cfg.holidays || []), ...busy.filter((b) => b.allDay).map((b) => b.date)]);
  const timed = busy.filter((b) => !b.allDay).map((b) => [Date.parse(b.start), Date.parse(b.end)]);

  const out = [];
  for (let i = 0; i <= cfg.horizonDays; i++) {
    const day = addDays(today, i);
    if (i === 0 && !cfg.allowSameDay) continue;
    if (blockedDays.has(day)) continue;
    for (const [from, to] of cfg.workingHours[weekdayOf(day)] || []) {
      const [fh, fm] = from.split(':').map(Number);
      const [th, tm] = to.split(':').map(Number);
      for (let mins = fh * 60 + fm; mins + cfg.durationMinutes <= th * 60 + tm; mins += cfg.stepMinutes) {
        const s = zonedToUtc(day, Math.floor(mins / 60), mins % 60, tz).getTime();
        const e = s + dur;
        if (s < earliest) continue;
        if (timed.some(([bs, be]) => s < be + gap && e > bs - gap)) continue;
        const start = new Date(s);
        out.push({ start: start.toISOString(), end: new Date(e).toISOString(), day, time: localTime(start, tz) });
      }
    }
  }
  return out;
}

// The code, not the model, picks what to offer: one morning and one afternoon
// slot when both exist within the first few available days, otherwise the
// earliest ones.
export function pickOffer(slots, { fromDate, count = 2, daysToLook = 3 } = {}) {
  const pool = slots.filter((s) => !fromDate || s.day >= fromDate);
  if (!pool.length) return [];
  const days = [...new Set(pool.map((s) => s.day))].slice(0, daysToLook);
  const near = pool.filter((s) => days.includes(s.day));
  const morning = near.find((s) => s.time < '12:00');
  const afternoon = near.find((s) => s.time >= '13:00');
  const picked = [morning, afternoon].filter(Boolean);
  for (const s of pool) {
    if (picked.length >= count) break;
    if (!picked.includes(s)) picked.push(s);
  }
  return picked.slice(0, count).sort((a, b) => a.start.localeCompare(b.start));
}

export function isStillFree(slot, busy, cfg) {
  const s = Date.parse(slot.start);
  const e = Date.parse(slot.end);
  const gap = cfg.gapMinutes * 60000;
  if ((cfg.holidays || []).includes(slot.day)) return false;
  return !busy.some((b) => (b.allDay ? b.date === slot.day : s < Date.parse(b.end) + gap && e > Date.parse(b.start) - gap));
}
