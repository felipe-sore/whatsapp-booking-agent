import { defaultConfig } from './config.js';
import { t } from './i18n.js';
import { checkGates, dayKey, countConversationReply } from './gates.js';
import { freeSlots, pickOffer, isStillFree } from './slots.js';
import { localDate, label as fmtLabel } from './time.js';
import { mergeProfile, score, missingFields } from './lead.js';
import { shapeMessages, typingDelayMs } from './messages.js';
import { validateDecision } from './decision.js';
import { systemPrompt, turnContext } from './prompt.js';
import { MemoryStore } from './store.js';
import { classifyMetaError, classifySendError, deliveryFailureNote, isTransient } from './delivery.js';

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
//   - a failed send (at send time or later, as a webhook status) is classified
//     by its Meta error code; the team is alerted when a person has to act
//     (permanent error, a handoff that did not arrive, or a calendar change the
//     lead never heard about). A failed alert never stops the turn from saving.
//   - one turn at a time per conversation, so two bursts never book twice
//     (in-process lock: run one instance per number)
//   - one conversation cannot use up the day: it has its own reply cap
//   - an outage (calendar, database, network) never fails in silence: the
//     lead's message is kept and the team is told to answer by hand

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

  // Alerts are best effort: Slack being down must not lose the turn.
  async function alert(record, payload) {
    try { await notify(payload); } catch (err) { record.notes.push(`notify_failed: ${err.message}`); }
  }

  // Meta accepted a send, then reported it as failed through the status webhook.
  function deliveryFailed({ conversationId, messageId, code, detail }) {
    return serial(conversationId, async () => {
      const conv = await store.get(conversationId);
      if (!conv) return null;
      const cls = classifyMetaError(code);
      const calendarChanged = Boolean(messageId && (conv.calendarNoticeIds || []).includes(messageId));
      const handedOver = conv.state === 'human';
      const note = deliveryFailureNote(cls, { calendarChanged, handedOver });
      const record = {
        conversationId, at: clock().toISOString(), notes: [], outcome: 'delivery_failed',
        delivery: { code: cls.code, action: cls.action, reason: cls.reason, messageId, detail, note },
      };
      if (calendarChanged || handedOver || !isTransient(cls)) {
        await alert(record, { kind: 'delivery', conversationId, phone: conv.phone, note, profile: conv.profile });
      }
      await store.logDecision(record);
      return record;
    });
  }

  async function handleTurn({ conversationId, phone, texts }) {
    const now = clock();
    const conv = await store.conversation(conversationId, phone);
    conv.history.push(...texts.map((text) => ({ role: 'lead', text, at: now.toISOString() })));
    const record = { conversationId, at: now.toISOString(), notes: [] };
    try {
      return await runTurn({ conversationId, phone, conv, record, now });
    } catch (err) {
      record.outcome = 'error';
      record.notes.push(`turn_failed: ${err.message}`);
      if (cfg.mode !== 'shadow') {
        await alert(record, { kind: 'error', conversationId, phone, note: `Error: ${err.message}.`, profile: conv.profile });
      }
      await store.save(conv);
      await store.logDecision(record);
      return record;
    }
  }

  async function runTurn({ conversationId, phone, conv, record, now }) {
    const shadow = cfg.mode === 'shadow';
    const previousOffer = conv.offered;
    const gate = checkGates(conv, cfg, now, await store.repliesOn(dayKey(now, cfg)));
    if (!gate.ok) {
      Object.assign(record, { outcome: gate.skip ? 'skipped' : 'deferred', why: gate.skip || gate.defer });
      // A conversation that hits its own cap is unusual: tell the team once a day.
      const day = dayKey(now, cfg);
      if (gate.defer === 'conversation_daily_cap' && conv.replies.alerted !== day && !shadow) {
        conv.replies.alerted = day;
        await alert(record, { kind: 'limit', conversationId, phone, profile: conv.profile });
      }
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
      d = await brain.decide({ system, history: conv.history.slice(-cfg.modelHistoryMessages), context });
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

    let { bubbles, notes } = shapeMessages(d.messages, cfg, { offered: conv.offered, today: localDate(now, cfg.timezone) });
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
      const sent = [];
      const ids = [];
      const calendarChanged = Boolean(record.booked || record.rescheduled || record.cancelled);
      try {
        for (const text of bubbles) {
          const res = await send({ conversationId, phone, text, typingMs: typingDelayMs(text) });
          sent.push(text);
          if (res?.messages?.[0]?.id) ids.push(res.messages[0].id);
        }
        record.outcome = 'sent';
      } catch (err) {
        // Stop at the first failure: the rest would fail the same way, and a
        // half-delivered turn must not be logged as the lead having read it.
        const cls = classifySendError(err);
        const note = deliveryFailureNote(cls, { sent: sent.length, total: bubbles.length, calendarChanged, handedOver: Boolean(record.handoff) });
        record.outcome = 'send_failed';
        record.delivery = { code: cls.code, action: cls.action, reason: cls.reason, sent: sent.length, error: err.message, note };
        // An offer the lead never saw cannot be booked later.
        if (action === 'offer_slots') conv.offered = previousOffer;
        bubbles = sent;
        record.bubbles = sent;
        if (!record.handoff && (calendarChanged || !isTransient(cls))) {
          await alert(record, { kind: 'delivery', conversationId, phone, note, profile: conv.profile });
        }
      }
      // A failed status arriving later for one of these ids means the lead missed the change.
      if (calendarChanged) conv.calendarNoticeIds = ids;
      if (sent.length) {
        await store.countReply(dayKey(now, cfg));
        countConversationReply(conv, dayKey(now, cfg));
      }
    } else {
      record.outcome = 'silent';
    }
    // One alert per handoff, after the send, so it can say whether the handoff message arrived.
    if (record.handoff && !shadow) {
      await alert(record, { kind: 'handoff', conversationId, phone, reason: record.handoff, note: record.delivery?.note, profile: conv.profile });
    }
    conv.history.push(...bubbles.map((text) => ({ role: 'agent', text, at: now.toISOString() })));
    await store.save(conv);
    await store.logDecision(record);
    return record;
  }

  return { handle, humanReplied, deliveryFailed, cfg, store, availability };
}
