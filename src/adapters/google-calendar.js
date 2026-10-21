import crypto from 'node:crypto';

// Google Calendar through a service account (the calendar must be shared with it).
// No SDK: one signed JWT for the token, then plain REST calls.
//
// Privacy: the lead's phone is stored in the event's PRIVATE extended properties
// and own events are fetched with a server-side filter on it. busy() returns only
// start and end, never titles, descriptions or attendees.

const API = 'https://www.googleapis.com/calendar/v3';
const b64url = (x) => Buffer.from(x).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

export function googleCalendar({ credentials, calendarId, extraBusyCalendars = [], fetchImpl = (...a) => fetch(...a), now = () => Date.now() }) {
  let token = null;

  async function accessToken() {
    if (token && token.exp > now() + 60000) return token.value;
    const iat = Math.floor(now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = b64url(JSON.stringify({
      iss: credentials.client_email, scope: 'https://www.googleapis.com/auth/calendar',
      aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600,
    }));
    const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claim}`).sign(credentials.private_key);
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${b64url(sig)}` }).toString(),
    });
    if (!res.ok) throw new Error(`Google token failed: HTTP ${res.status}`);
    const data = await res.json();
    token = { value: data.access_token, exp: now() + data.expires_in * 1000 };
    return token.value;
  }

  async function call(method, path, { params, body } = {}) {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
    const res = await fetchImpl(url.toString(), {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Google Calendar ${method} ${path}: HTTP ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  const events = (id, params) => call('GET', `/calendars/${encodeURIComponent(id)}/events`, { params: { singleEvents: 'true', orderBy: 'startTime', maxResults: '2500', ...params } }).then((d) => d.items || []);

  function toBusy(items) {
    const out = [];
    for (const e of items) {
      if (e.status === 'cancelled' || e.transparency === 'transparent') continue;
      if (e.start?.date) {
        // All-day events end on the day AFTER the last day.
        for (let d = e.start.date; d < e.end.date; d = new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10)) out.push({ allDay: true, date: d });
      } else {
        out.push({ start: new Date(e.start.dateTime).toISOString(), end: new Date(e.end.dateTime).toISOString() });
      }
    }
    return out;
  }

  return {
    async busy(fromIso, toIso) {
      const all = await Promise.all([calendarId, ...extraBusyCalendars].map((id) => events(id, { timeMin: fromIso, timeMax: toIso })));
      return toBusy(all.flat());
    },
    async eventsFor(phone) {
      const items = await events(calendarId, { timeMin: new Date(now()).toISOString(), privateExtendedProperty: `leadPhone=${phone}` });
      return items.filter((e) => e.start?.dateTime).map((e) => ({ id: e.id, start: new Date(e.start.dateTime).toISOString(), end: new Date(e.end.dateTime).toISOString() }));
    },
    async create({ start, end, phone, title, description, attendees = [] }) {
      const e = await call('POST', `/calendars/${encodeURIComponent(calendarId)}/events`, {
        params: { sendUpdates: 'all' },
        body: {
          summary: title, description,
          start: { dateTime: start }, end: { dateTime: end },
          attendees: attendees.filter(Boolean).map((email) => ({ email })),
          extendedProperties: { private: { leadPhone: phone, source: 'whatsapp-booking-agent' } },
        },
      });
      return { id: e.id };
    },
    async update(id, { start, end }) {
      await call('PATCH', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`, { params: { sendUpdates: 'all' }, body: { start: { dateTime: start }, end: { dateTime: end } } });
      return { id };
    },
    async remove(id) {
      await call('DELETE', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`, { params: { sendUpdates: 'all' } });
    },
  };
}
