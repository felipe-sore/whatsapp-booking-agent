// Sentences the CODE writes. When a rule blocks what the model proposed,
// the lead gets one of these instead of an invented answer.

const strings = {
  'pt-BR': {
    ask_name: 'Com quem eu falo?',
    ask_company: 'De qual empresa você é?',
    ask_email: 'Qual e-mail eu coloco no convite?',
    offer: (a) => (a.length > 1 ? `Tenho ${a.slice(0, -1).join(', ')} ou ${a.at(-1)}. Qual fica melhor?` : `Tenho ${a[0]}. Fica bom?`),
    no_slots: 'Minha agenda está cheia nos próximos dias. Vou pedir pra alguém do time te chamar com novas opções.',
    slot_taken: 'Esse horário acabou de ser ocupado.',
    booked: (when) => `Agendado para ${when}. O convite chega no seu e-mail.`,
    rescheduled: (when) => `Remarcado para ${when}. O convite foi atualizado.`,
    cancelled: 'Cancelado. Se quiser marcar outro dia, é só falar.',
    no_event: 'Não encontrei nenhuma reunião marcada para este número.',
    confirm_cancel: 'Quer mesmo cancelar a reunião?',
    handoff: 'Vou passar sua conversa para alguém do time, que já te responde por aqui.',
  },
  en: {
    ask_name: 'Who am I talking to?',
    ask_company: 'Which company are you with?',
    ask_email: 'Which email should I send the invite to?',
    offer: (a) => (a.length > 1 ? `I have ${a.slice(0, -1).join(', ')} or ${a.at(-1)}. Which works better?` : `I have ${a[0]}. Does that work?`),
    no_slots: 'My calendar is full for the next few days. Someone from the team will reach out with new options.',
    slot_taken: 'That time was just taken.',
    booked: (when) => `Booked for ${when}. The invite is on its way to your email.`,
    rescheduled: (when) => `Moved to ${when}. The invite was updated.`,
    cancelled: 'Cancelled. If you want another day, just let me know.',
    no_event: 'I could not find a meeting booked for this number.',
    confirm_cancel: 'Do you want to cancel the meeting?',
    handoff: 'I am handing this conversation to someone on the team, who will reply here.',
  },
};

export function t(locale) {
  return strings[locale] || strings.en;
}
