import { weekdayOf, addDays } from './time.js';

// Shape of what is sent: forbidden characters out, one question per turn,
// short bubbles split at sentence ends, and no clock time (or day) the code did not offer.

// Clock times as people write them. Each pattern returns [hour, minute, am/pm].
const TIME_PATTERNS = [
  /(?<![\d:h])(\d{1,2})\s?[:h]\s?([0-5]\d)(?:\s?([ap])\.?\s?m\b\.?)?(?!\d)/giu, // 15:00, 10h30, 3:30 pm
  /(?<![\d:h])(\d{1,2})h(?![\p{L}\d])()()/giu,                                     // 15h
  /(?<![\d:h])(\d{1,2})\s?()([ap])\.?\s?m\b\.?/giu,                                // 3pm, 3 p.m.
  /(?<![\p{L}\d])(?:às|as|das|at)\s+(\d{1,2})\s?(?:horas?|hrs?|hs)()()(?![\p{L}])/giu, // às 15 horas, at 15 hrs
];

export function mentionedTimes(text) {
  let rest = String(text);
  const found = [];
  for (const re of TIME_PATTERNS) {
    for (const m of rest.matchAll(re)) {
      let h = Number(m[1]);
      const min = m[2] || '00';
      const ampm = (m[3] || '').toLowerCase();
      if (ampm) {
        if (h < 1 || h > 12) continue;
        h = (h % 12) + (ampm === 'p' ? 12 : 0);
      }
      if (h > 23) continue;
      found.push({ at: m.index, time: `${String(h).padStart(2, '0')}:${min}` });
    }
    // Blank out what this pattern took, so a later one does not read it again.
    rest = rest.replace(re, (s) => ' '.repeat(s.length));
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.time);
}

const WEEKDAY_WORDS = {
  domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};
const RELATIVE_WORDS = [['depois de amanha', 2], ['day after tomorrow', 2], ['amanha', 1], ['tomorrow', 1], ['hoje', 0], ['today', 0]];

// Days named in a message, as weekday numbers: "quinta", "Thursday", and
// "amanhã" or "tomorrow" relative to today (YYYY-MM-DD in the business time zone).
export function mentionedWeekdays(text, today) {
  let t = String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const days = new Set();
  for (const [word, n] of RELATIVE_WORDS) {
    const re = new RegExp(`(?<![a-z])${word}(?![a-z])`, 'g');
    if (today && re.test(t)) days.add(weekdayOf(addDays(today, n)));
    t = t.replace(re, ' ');
  }
  for (const m of t.matchAll(/(?<![a-z])(domingo|segunda|terca|quarta|quinta|sexta|sabado|sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?![a-z])/g)) {
    days.add(WEEKDAY_WORDS[m[1]]);
  }
  return days;
}

// A message may name a time only if it was offered, and when it also names a
// day, that day must match: "quinta às 10:00" is dropped when 10:00 was offered on Tuesday.
function onlyOfferedTimes(text, offered, today) {
  const times = mentionedTimes(text);
  if (!times.length) return true;
  const days = mentionedWeekdays(text, today);
  const onDay = (s) => !days.size || days.has(weekdayOf(s.day));
  return times.every((tm) => offered.some((s) => s.time === tm && onDay(s)))
    && [...days].every((d) => offered.some((s) => weekdayOf(s.day) === d && times.includes(s.time)));
}

// offered: the slots on the table ({ day, time }); today: YYYY-MM-DD in the business time zone.
// allowedTimes (times only, no day check) is kept for callers without slots.
export function shapeMessages(raw, cfg, { allowedTimes = [], offered, today } = {}) {
  const notes = [];
  let msgs = (raw || []).map((m) => String(m || '').trim()).filter(Boolean);

  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  msgs = msgs.map((m) => cfg.forbiddenText.reduce((acc, [bad, good]) => acc.replace(new RegExp(`\\s*${esc(bad)}\\s*`, 'g'), good), m));

  const allowed = new Set(allowedTimes);
  const kept = msgs.filter((m) => (offered
    ? onlyOfferedTimes(m, offered, today)
    : mentionedTimes(m).every((t) => allowed.has(t))));
  if (kept.length < msgs.length) notes.push('dropped_unoffered_time');
  msgs = kept;

  // One question per turn: keep bubbles up to and including the first question.
  const q = msgs.findIndex((m) => m.includes('?'));
  if (q >= 0) {
    const first = msgs[q];
    const cut = first.indexOf('?');
    const trimmed = first.slice(0, cut + 1);
    if (trimmed !== first || q < msgs.length - 1) notes.push('trimmed_extra_question');
    msgs = [...msgs.slice(0, q), trimmed];
  }

  const bubbles = [];
  for (const m of msgs) bubbles.push(...splitBubble(m, cfg.maxBubbleChars));
  if (bubbles.length > cfg.maxBubbles) notes.push('too_many_bubbles');
  return { bubbles: bubbles.slice(0, cfg.maxBubbles), notes };
}

export function splitBubble(text, max) {
  if (text.length <= max) return [text];
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
  const out = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + s).trim().length > max && cur) { out.push(cur.trim()); cur = ''; }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Human-looking pacing: "typing" time grows with length, with a floor and a cap.
export function typingDelayMs(text, { perChar = 45, min = 1200, max = 8000 } = {}) {
  return Math.max(min, Math.min(max, text.length * perChar));
}
