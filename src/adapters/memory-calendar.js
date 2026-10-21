// In-memory calendar for tests, the simulator and the evals.
// The interface is what a real adapter (Google Calendar) implements:
//   busy(fromIso, toIso)  -> [{ start, end } | { allDay, date }]   no titles, no attendees
//   eventsFor(phone)      -> the caller's own events only
//   create / update / remove

export class MemoryCalendar {
  constructor(events = []) {
    this.events = events.map((e, i) => ({ id: e.id || `seed-${i}`, ...e }));
    this.next = 1;
  }

  async busy(fromIso, toIso) {
    return this.events
      .filter((e) => (e.allDay ? e.date >= fromIso.slice(0, 10) && e.date <= toIso.slice(0, 10) : e.end > fromIso && e.start < toIso))
      .map((e) => (e.allDay ? { allDay: true, date: e.date } : { start: e.start, end: e.end }));
  }

  // Privacy lives here, not in the prompt: a lead only ever sees events whose
  // phone field matches their own number.
  async eventsFor(phone) {
    return this.events.filter((e) => !e.allDay && e.phone === phone).map(({ id, start, end }) => ({ id, start, end }));
  }

  async create(event) {
    const id = `evt-${this.next++}`;
    this.events.push({ id, ...event });
    return { id };
  }

  async update(id, patch) {
    const e = this.events.find((x) => x.id === id);
    if (!e) throw new Error(`event ${id} not found`);
    Object.assign(e, patch);
    return { id };
  }

  async remove(id) {
    this.events = this.events.filter((x) => x.id !== id);
  }
}
