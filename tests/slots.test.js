import test from 'node:test';
import assert from 'node:assert/strict';
import { zonedToUtc, localDate, localTime } from '../src/time.js';
import { freeSlots, pickOffer, isStillFree } from '../src/slots.js';
import { defaultConfig } from '../src/config.js';
import { NOW } from './helpers.js';

const cfg = { ...defaultConfig };

test('wall clock to UTC, with and without DST', () => {
  assert.equal(zonedToUtc('2026-10-21', 9, 0, 'America/Sao_Paulo').toISOString(), '2026-10-21T12:00:00.000Z');
  assert.equal(zonedToUtc('2026-03-09', 9, 0, 'America/New_York').toISOString(), '2026-03-09T13:00:00.000Z'); // after DST starts
  assert.equal(zonedToUtc('2026-03-06', 9, 0, 'America/New_York').toISOString(), '2026-03-06T14:00:00.000Z'); // before
});

test('local date near midnight does not drift', () => {
  const lateNight = new Date('2026-10-21T02:30:00Z'); // 23:30 on the 20th in Sao Paulo
  assert.equal(localDate(lateNight, 'America/Sao_Paulo'), '2026-10-20');
  assert.equal(localTime(lateNight, 'America/Sao_Paulo'), '23:30');
});

test('no same-day slots by default, weekends skipped, working hours respected', () => {
  const slots = freeSlots({ busy: [], now: NOW, cfg });
  assert.ok(slots.length > 0);
  assert.ok(slots.every((s) => s.day > '2026-10-20'));
  assert.ok(!slots.some((s) => s.day === '2026-10-24' || s.day === '2026-10-25'));
  assert.ok(slots.every((s) => (s.time >= '09:00' && s.time <= '11:00') || (s.time >= '13:30' && s.time <= '17:00'))); // 45 min meetings must end inside the range
});

test('same day allowed only after the minimum notice', () => {
  const slots = freeSlots({ busy: [], now: NOW, cfg: { ...cfg, allowSameDay: true } });
  const today = slots.filter((s) => s.day === '2026-10-20');
  assert.ok(today.length > 0);
  assert.ok(today.every((s) => s.time >= '13:30')); // 10:00 + 180 min notice
});

test('busy events block the slot plus the gap on both sides', () => {
  const busy = [{ start: '2026-10-21T13:00:00.000Z', end: '2026-10-21T14:00:00.000Z' }]; // 10:00-11:00 local
  const day = freeSlots({ busy, now: NOW, cfg }).filter((s) => s.day === '2026-10-21').map((s) => s.time);
  assert.ok(day.includes('09:00'));   // ends 09:45: exactly the 15 min gap before 10:00
  assert.ok(!day.includes('09:30'));
  assert.ok(!day.includes('10:30'));
  assert.ok(!day.includes('11:00'));  // starts 0 min after the meeting, needs 15
  assert.ok(day.includes('13:30'));
});

test('holidays and all-day events block the whole day; horizon is enforced', () => {
  const slots = freeSlots({ busy: [{ allDay: true, date: '2026-10-22' }], now: NOW, cfg: { ...cfg, holidays: ['2026-10-23'], horizonDays: 7 } });
  const days = new Set(slots.map((s) => s.day));
  assert.ok(!days.has('2026-10-22') && !days.has('2026-10-23'));
  assert.ok([...days].every((d) => d <= '2026-10-27'));
});

test('offer: one morning and one afternoon when available, from the requested date', () => {
  const slots = freeSlots({ busy: [], now: NOW, cfg });
  const offer = pickOffer(slots, { count: 2 });
  assert.equal(offer.length, 2);
  assert.ok(offer[0].time < '12:00' && offer[1].time >= '13:00');
  assert.ok(pickOffer(slots, { fromDate: '2026-10-28' }).every((s) => s.day >= '2026-10-28'));
  assert.deepEqual(pickOffer([], {}), []);
});

test('still free re-check catches a meeting booked after the offer', () => {
  const slot = { start: '2026-10-21T12:00:00.000Z', end: '2026-10-21T12:45:00.000Z', day: '2026-10-21' };
  assert.equal(isStillFree(slot, [], cfg), true);
  assert.equal(isStillFree(slot, [{ start: '2026-10-21T12:30:00.000Z', end: '2026-10-21T13:00:00.000Z' }], cfg), false);
});
