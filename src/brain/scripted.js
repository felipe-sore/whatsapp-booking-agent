// A deterministic stand-in for the model, used by the simulator without an
// API key and by the evals in CI. It is intentionally simple: the point of
// the scripted brain is to exercise the pipeline, not to be smart.
// Run the evals with --claude to grade the real model.

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;
const NAME = /(?:sou (?:o |a )?|me chamo |aqui (?:é|e) (?:o |a )?|my name is |i'?m |this is )(?!(?:d[aoe]|from|at|with)\s)([\p{L}]+)/iu;
const COMPANY = /(?:da empresa |na empresa |trabalho na |trabalho no |sou da |sou do |i'?m from |from |at |company is )([\p{L}0-9][\w&.-]*)/iu;
const HUMAN = /\b(humano|atendente|pessoa de verdade|human|real person|agent)\b/i;
const CANCEL = /\b(cancel|cancelar|desmarcar)\b/i;
const YES = /\b(sim|pode|confirmo|yes|sure|confirm)\b/i;
const PICK_FIRST = /\b(1|primeir[oa]|first|o de manh[ãa]|morning)\b/i;
const PICK_SECOND = /\b(2|segund[oa]|second|o da tarde|afternoon)\b/i;

const blank = () => ({ name: null, company: null, email: null, need: null, role: null });
const noSignals = () => ({ asked_price: false, wants_meeting: false, urgent: false });

export function scriptedBrain({ locale = 'pt-BR' } = {}) {
  const pt = locale.startsWith('pt');
  return {
    async decide({ history, context }) {
      const leadTurns = history.filter((h) => h.role === 'lead');
      const last = leadTurns.at(-1)?.text || '';
      const extracted = blank();
      const email = last.match(EMAIL);
      if (email) extracted.email = email[0];
      const name = last.match(NAME);
      if (name) extracted.name = name[1];
      const company = last.match(COMPANY);
      if (company) extracted.company = company[1].replace(/[.,]$/, '');
      if (leadTurns.length === 1 && last.length > 20 && !email) extracted.need = last;
      const signals = { ...noSignals(), asked_price: /pre[çc]o|price|quanto custa/i.test(last), wants_meeting: /reuni|call|conversar|meeting/i.test(last) };
      const base = { messages: [], extracted, signals, slot_choice: null, offer_from_date: null, confirmed: false, handoff_reason: null, reason: 'scripted' };

      if (HUMAN.test(last)) return { ...base, action: 'handoff', handoff_reason: 'asked_for_human' };
      const booked = !/booked meetings: none/.test(context);
      if (CANCEL.test(last) || (booked && YES.test(last) && /cancel/i.test(history.at(-2)?.text || ''))) {
        return { ...base, action: 'cancel', confirmed: YES.test(last) && !CANCEL.test(last) };
      }

      const offered = (context.match(/offered slots: (.*)/)?.[1] || 'none').split(' | ').filter((s) => s !== 'none').map((s) => s.split(' ')[0]);
      if (offered.length && (PICK_FIRST.test(last) || PICK_SECOND.test(last) || email)) {
        const choice = PICK_SECOND.test(last) && offered[1] ? offered[1] : offered[0];
        return { ...base, action: 'book', slot_choice: choice };
      }

      const known = context.match(/known about this person: (.*)/)?.[1] || '';
      const has = (f) => known.includes(`${f}:`) || extracted[f];
      if (!has('need')) return { ...base, action: 'reply', messages: [pt ? 'Oi! Me conta o que você está buscando?' : 'Hi! What are you looking for?'] };
      if (!has('name')) return { ...base, action: 'reply', messages: [pt ? 'Entendi. Com quem eu falo?' : 'Got it. Who am I talking to?'] };
      if (!has('company')) return { ...base, action: 'reply', messages: [pt ? 'Prazer! De qual empresa você é?' : 'Nice to meet you. Which company are you with?'] };
      if (!offered.length) return { ...base, action: 'offer_slots', messages: [pt ? 'Faz sentido a gente conversar.' : 'It makes sense to talk.'] };
      return { ...base, action: 'reply', messages: [pt ? 'Qual dos horários fica melhor?' : 'Which time works better?'] };
    },
  };
}
