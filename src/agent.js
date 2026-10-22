import { defaultConfig } from './config.js';
import { t } from './i18n.js';
import { checkGates, dayKey } from './gates.js';
import { freeSlots, pickOffer, isStillFree } from './slots.js';
import { localDate, label as fmtLabel } from './time.js';
import { mergeProfile, score, missingFields } from './lead.js';
import { shapeMessages, typingDelayMs } from './messages.js';
import { validateDecision } from './decision.js';
import { systemPrompt, turnContext } from './prompt.js';
import { MemoryStore } from './store.js';

// The agent: the model proposes a decision, this file decides what happens.
//
// Everything that can cost money, embarrass the business or leak data is
// enforced here, whatever the model returned:
//   - times: only slots computed by src/slots.js, re-checked right before booking
//   - booking: never without name, company and a valid email
//   - privacy: the model never sees other people's events; reschedule/cancel only own events
//   - a human in the conversation, or a stop label, silences the agent for good
//   - a model error or refusal hands over to a human with a neutral message
//   - shadow mode touches nothing outside: no message, no calendar write
//   - one turn at a time per conversation, so two bursts never book twice
//     (in-process lock: run one instance per number)

export function createAgent({
  cfg: userCfg = {}, brain, calendar, store = new MemoryStore(),
  send = async () => {}, notify = async () => {}, clock = () => new Date(),
}) {
  const cfg = { ...defaultConfig, ...userCfg, business: { ...defaultConfig.business, ...(userCfg.business || {}) } };
  const txt = t(cfg.locale);
  const label = (iso) => fmtLabel(iso, cfg.timezone, cfg.locale);
  const system = systemPrompt(cfg);

  async function availability(now) {
    const to = new Date(now.getTime() + (cfg.horizonDays + 1) * 86400000).toISOString();
    const busy = await calendar.busy(now.toISOString(), to);
    return { busy, free: freeSlots({ busy, now, cfg }) };
  }

  function offerBubbles(offer) {
    return offer.length ? [txt.offer(offer.map((s) => label(s.start)))] : [txt.no_slots];
  }

  // Turns of the same conversation run one after the other. Without this, a
  // second burst arriving while the first is still typing would load the same
  // state, book the same slot twice, and the last save would erase the other.
  const queues = new Map();
  function serial(convId, fn) {
    const run = (queues.get(convId) || Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    queues.set(convId, tail);
    tail.then(() => { if (queues.get(convId) === tail) queues.delete(convId); });
    return run;
  }
  const takenOver = new Set();

  // A human agent wrote in the conversation: the bot leaves it for good.
  // A turn already in flight sees the flag and sends nothing.
  function humanReplied(convId) {
    takenOver.add(convId);
    return serial(convId, async () => {
      const conv = await store.get(convId);
      if (!conv) return false;
      conv.state = 'human';
      await store.save(conv);
      return true;
    });
  }

  // An offered slot can go stale while the lead thinks it over: it must still
  // respect the minimum notice and the same-day rule at the moment of booking.
  function stillBookable(slot, now) {
    if (Date.parse(slot.start) < now.getTime() + cfg.minNoticeMinutes * 60000) return false;
    return cfg.allowSameDay || slot.day > localDate(now, cfg.timezone);
  }

  const handle = (turn) => serial(turn.conversationId, () => handleTurn(turn));

  async function handleTurn({ conversationId, phone, texts }) {
    const now = clock();
    const shadow = cfg.mode === 'shadow';
    const conv = await store.conversation(conversationId, phone);
    conv.history.push(...texts.map((text) => ({ role: 'lead', text, at: now.toISOString() })));
    const record = { conversationId, at: now.toISOString(), notes: [] };

    const gate = checkGates(conv, cfg, now, await store.repliesOn(dayKey(now, cfg)));
    if (!gate.ok) {
      Object.assign(record, { outcome: gate.skip ? 'skipped' : 'deferred', why: gate.skip || gate.defer });
      await store.save(conv);
      await store.logDecision(record);
      return record;
    }

    const { busy, free } = await availability(now);
    const ownEvents = await calendar.eventsFor(phone);
    const availableDays = [...new Set(free.map((s) => s.day))];
    const context = turnContext({ now, cfg, conv, ownEvents, availableDays, label });

    let d;
    try {
      d = await brain.decide({ system, history: conv.history, context });
      const errors = validateDecision(d);
      if (errors.length) throw new Error(`invalid decision: ${errors.join(', ')}`);
    } catch (err) {
      record.notes.push(`model_failed: ${err.message}`);
      d = { action: 'handoff', messages: [], extracted: {}, signals: {}, handoff_reason: 'model_failed' };
    }
    record.modelAction = d.action;
    record.modelReason = d.reason;

    const audit = mergeProfile(conv.profile, d.extracted, now);
    Object.assign(conv.signals, Object.fromEntries(Object.entries(d.signals || {}).filter(([, v]) => v)));
    conv.lead = score(conv.profile, conv.signals);
    await store.logAudit(conversationId, audit);

    const allowedTimes = conv.offered.map((s) => s.time);
    let { bubbles, notes } = shapeMessages(d.messages, cfg, { allowedTimes });
    record.notes.push(...notes);
    let action = d.action;

    if (action === 'offer_slots') {
      const fromDate = d.offer_from_date && d.offer_from_date > localDate(now, cfg.timezone) ? d.offer_from_date : undefined;
      conv.offered = pickOffer(free, { fromDate, count: cfg.offerCount });
      bubbles = [...bubbles.filter((b) => !b.includes('?')), ...offerBubbles(conv.offered)];
      if (!conv.offered.length) action = handoffTo('no_slots');
    } else if (action === 'book') {
      const missing = missingFields(conv.profile, cfg.requiredFields);
      const slot = conv.offered.find((s) => s.start === d.slot_choice);
      if (missing.length) {
        action = 'reply';
        record.notes.push(`book_blocked_missing_${missing[0]}`);
        bubbles = [txt[`ask_${missing[0]}`]];
      } else if (!slot) {
        action = 'offer_slots';
        record.notes.push('book_blocked_slot_not_offered');
        conv.offered = pickOffer(free, { count: cfg.offerCount });
        bubbles = offerBubbles(conv.offered);
      } else if (!stillBookable(slot, clock())) {
        action = 'offer_slots';
        record.notes.push('book_blocked_slot_expired');
        conv.offered = pickOffer(free, { count: cfg.offerCount });
        bubbles = [txt.slot_taken, ...offerBubbles(conv.offered)];
      } else if (!isStillFree(slot, (await availability(clock())).busy, cfg)) {
        // Re-read the calendar: someone may have taken the slot since it was offered.
        action = 'offer_slots';
        record.notes.push('book_blocked_slot_taken');
        conv.offered = pickOffer(free.filter((s) => s.start !== slot.start), { count: cfg.offerCount });
        bubbles = [txt.slot_taken, ...offerBubbles(conv.offered)];
      } else {
        const p = conv.profile;
        const event = {
          start: slot.start, end: slot.end, phone,
          title: cfg.eventTitle(p),
          description: `Name: ${p.name}\nCompany: ${p.company}\nPhone: ${phone}\nNeed: ${p.need || ''}`,
          attendees: [p.email, ...cfg.internalAttendees],
        };
        const created = shadow ? { id: 'shadow' } : await calendar.create(event);
        conv.eventId = created.id;
        conv.state = 'booked';
        conv.offered = [];
        bubbles = [txt.booked(label(slot.start))];
        record.booked = { eventId: created.id, start: slot.start };
      }
    } else if (action === 'reschedule' || action === 'cancel') {
      const own = ownEvents[0];
      const slot = conv.offered.find((s) => s.start === d.slot_choice);
      if (!own) {
        action = 'reply';
        bubbles = [txt.no_event];
      } else if (!d.confirmed) {
        action = 'reply';
        record.notes.push(`${d.action}_needs_confirmation`);
        bubbles = d.action === 'cancel' ? [txt.confirm_cancel] : bubbles;
      } else if (action === 'cancel') {
        if (!shadow) await calendar.remove(own.id);
        conv.state = 'active';
        bubbles = [txt.cancelled];
        record.cancelled = own.id;
      } else if (!slot || !stillBookable(slot, clock()) || !isStillFree(slot, busy.filter((b) => b.start !== own.start), cfg)) {
        action = 'offer_slots';
        conv.offered = pickOffer(free, { fromDate: d.offer_from_date || undefined, count: cfg.offerCount });
        bubbles = offerBubbles(conv.offered);
      } else {
        if (!shadow) await calendar.update(own.id, { start: slot.start, end: slot.end });
        conv.offered = [];
        bubbles = [txt.rescheduled(label(slot.start))];
        record.rescheduled = { eventId: own.id, start: slot.start };
      }
    } else if (action === 'handoff') {
      action = handoffTo(d.handoff_reason || 'requested');
    } else if (action === 'stay_silent') {
      bubbles = [];
    }

    function handoffTo(reason) {
      conv.state = 'human';
      record.handoff = reason;
      if (!bubbles.length || reason === 'model_failed') bubbles = [txt.handoff];
      return 'handoff';
    }
    if (record.handoff && !shadow) await notify({ conversationId, phone, reason: record.handoff, profile: conv.profile });

    record.action = action;
    record.bubbles = bubbles;

    if (shadow) {
      record.outcome = 'shadow';
      if (record.booked || record.cancelled || record.rescheduled) record.notes.push('shadow_calendar_not_written');
    } else if (takenOver.has(conversationId)) {
      // A human replied while this turn was thinking: say nothing.
      conv.state = 'human';
      bubbles = [];
      record.outcome = 'human_took_over';
    } else if (bubbles.length) {
      for (const text of bubbles) await send({ conversationId, phone, text, typingMs: typingDelayMs(text) });
      await store.countReply(dayKey(now, cfg));
      record.outcome = 'sent';
    } else {
      record.outcome = 'silent';
    }
    conv.history.push(...bubbles.map((text) => ({ role: 'agent', text, at: now.toISOString() })));
    await store.save(conv);
    await store.logDecision(record);
    return record;
  }

  return { handle, humanReplied, cfg, store, availability };
}
