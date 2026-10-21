// Shape of what is sent: forbidden characters out, one question per turn,
// short bubbles split at sentence ends, and no clock time the code did not offer.

const TIME = /\b([01]?\d|2[0-3])(?::([0-5]\d)|h([0-5]\d)?)\b/gi;

export function mentionedTimes(text) {
  return [...String(text).matchAll(TIME)].map((m) => `${m[1].padStart(2, '0')}:${m[2] || m[3] || '00'}`);
}

export function shapeMessages(raw, cfg, { allowedTimes = [] } = {}) {
  const notes = [];
  let msgs = (raw || []).map((m) => String(m || '').trim()).filter(Boolean);

  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  msgs = msgs.map((m) => cfg.forbiddenText.reduce((acc, [bad, good]) => acc.replace(new RegExp(`\\s*${esc(bad)}\\s*`, 'g'), good), m));

  const allowed = new Set(allowedTimes);
  const kept = msgs.filter((m) => mentionedTimes(m).every((t) => allowed.has(t)));
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
