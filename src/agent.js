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

  // A human agent wrote in the conversation: the bot leaves it for good.
  function humanReplied(convId) {
    const conv = store.conversations.get(convId);
    if (conv) conv.state = 'human';
  }

  async function handle({ conversationId, phone, texts }) {
    const now = clock();
    const conv = store.conversation(conversationId, phone);
    conv.history.push(...texts.map((text) => ({ role: 'lead', text, at: now.toISOString() })));
    const record = { conversationId, at: now.toISOString(), notes: [] };

    const gate = checkGates(conv, cfg, now, store.repliesOn(dayKey(now, cfg)));
    if (!gate.ok) {
      Object.assign(record, { outcome: gate.skip ? 'skipped' : 'deferred', why: gate.skip || gate.defer });
      store.logDecision(record);
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
    store.logAudit(conversationId, audit);

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
      } else if (!isStillFree(slot, (await availability(clock())).busy, cfg)) {
        // Re-read the calendar: someone may have taken the slot since it was offered.
        action = 'offer_slots';
        record.notes.push('book_blocked_slot_taken');
        conv.offered = pickOffer(free.filter((s) => s.start !== slot.start), { count: cfg.offerCount });
        bubbles = [txt.slot_taken, ...offerBubbles(conv.offered)];
      } else {
        const p = conv.profile;
        const created = await calendar.create({
          start: slot.start, end: slot.end, phone,
          title: cfg.eventTitle(p),
          description: `Name: ${p.name}\nCompany: ${p.company}\nPhone: ${phone}\nNeed: ${p.need || ''}`,
          attendees: [p.email, ...cfg.internalAttendees],
        });
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
        await calendar.remove(own.id);
        conv.state = 'active';
        bubbles = [txt.cancelled];
        record.cancelled = own.id;
      } else if (!slot || !isStillFree(slot, busy.filter((b) => b.start !== own.start), cfg)) {
        action = 'offer_slots';
        conv.offered = pickOffer(free, { fromDate: d.offer_from_date || undefined, count: cfg.offerCount });
        bubbles = offerBubbles(conv.offered);
      } else {
        await calendar.update(own.id, { start: slot.start, end: slot.end });
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
    if (record.handoff) await notify({ conversationId, phone, reason: record.handoff, profile: conv.profile });

    record.action = action;
    record.bubbles = bubbles;
    conv.history.push(...bubbles.map((text) => ({ role: 'agent', text, at: now.toISOString() })));

    if (cfg.mode === 'shadow') {
      record.outcome = 'shadow';
    } else if (bubbles.length) {
      for (const text of bubbles) await send({ conversationId, phone, text, typingMs: typingDelayMs(text) });
      store.countReply(dayKey(now, cfg));
      record.outcome = 'sent';
    } else {
      record.outcome = 'silent';
    }
    store.logDecision(record);
    return record;
  }

  return { handle, humanReplied, cfg, store, availability };
}
