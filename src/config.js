// Everything a business changes lives here. Override with your own object:
// createAgent({ cfg: { ...defaultConfig, timezone: 'America/New_York', ... } })

const weekdays = [['09:00', '12:00'], ['13:30', '18:00']];

export const defaultConfig = {
  business: {
    name: 'Northwind Studio',
    agentName: 'Ana',
    about: 'A B2B consultancy that helps companies organize sales and marketing.',
    services: [
      'Sales process consulting',
      'Marketing automation',
      'CRM setup',
    ],
    meetingPurpose: 'a 45-minute call to understand your scenario',
  },
  locale: 'pt-BR',

  // Calendar rules
  timezone: 'America/Sao_Paulo',
  durationMinutes: 45,
  stepMinutes: 30,
  gapMinutes: 15,
  minNoticeMinutes: 180,
  allowSameDay: false,
  horizonDays: 14,
  workingHours: { 1: weekdays, 2: weekdays, 3: weekdays, 4: weekdays, 5: weekdays },
  holidays: [],
  offerCount: 2,

  // What must be known before an event is created
  requiredFields: ['name', 'company', 'email'],
  eventTitle: (p) => `Call | ${p.company}`,
  internalAttendees: [],
  stopAfterBooking: false, // true: the agent goes quiet after booking (a human takes over)

  // Gates
  enabled: true,
  mode: 'live',            // 'shadow' decides and logs, but never sends
  canaryConversations: [], // non-empty: only these conversations get answers
  stopLabels: ['do_not_contact', 'human_only'],
  replyHours: { start: 7, end: 22 },
  dailyCap: 300,               // replies per day, all conversations together
  conversationDailyCap: 30,    // replies per day in one conversation: one abusive number cannot use up dailyCap

  // Model input
  modelHistoryMessages: 40,    // only the latest messages go to the model; what is known rides in the turn context

  // Message shape
  maxBubbles: 3,
  maxBubbleChars: 160,
  forbiddenText: [['—', ', '], ['–', ', ']],
};
