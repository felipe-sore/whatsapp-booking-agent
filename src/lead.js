// Lead profile, score and audit trail. All deterministic: the model only
// reports what it heard; the code decides what is stored and what it is worth.

const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const FREE_EMAIL = /@(gmail|hotmail|outlook|yahoo|icloud|live|proton(mail)?)\./i;
export const FIELDS = ['name', 'company', 'email', 'need', 'role'];

export function validEmail(v) {
  return EMAIL.test(String(v || '').trim());
}

// Merges what the model extracted. Returns the field changes for the audit log.
export function mergeProfile(profile, extracted = {}, at = new Date()) {
  const events = [];
  for (const f of FIELDS) {
    let v = extracted[f];
    if (v === null || v === undefined) continue;
    v = String(v).trim();
    if (!v) continue;
    if (f === 'email') {
      v = v.toLowerCase();
      if (!validEmail(v)) { events.push({ type: 'rejected_value', field: f, value: v, at: at.toISOString() }); continue; }
    }
    if (profile[f] !== v) {
      events.push({ type: profile[f] ? 'field_changed' : 'field_detected', field: f, old: profile[f] || null, new: v, at: at.toISOString() });
      profile[f] = v;
    }
  }
  return events;
}

export function score(profile, signals = {}) {
  let s = 0;
  if (profile.need) s += 20;
  if (profile.company) s += 10;
  if (profile.name) s += 5;
  if (profile.email) s += FREE_EMAIL.test(profile.email) ? 5 : 20;
  if (signals.asked_price) s += 15;
  if (signals.wants_meeting) s += 30;
  if (signals.urgent) s += 15;
  s = Math.min(100, s);
  return { score: s, status: s > 70 ? 'hot' : s > 30 ? 'warm' : 'cold' };
}

export function missingFields(profile, required) {
  return required.filter((f) => !profile[f]);
}
