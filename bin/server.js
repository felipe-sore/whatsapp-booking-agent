#!/usr/bin/env node
// Production entry point. Configuration comes from the environment (see .env.example).

import fs from 'node:fs';
import { createAgent } from '../src/agent.js';
import { createServer } from '../src/server.js';
import { claudeBrain } from '../src/brain/claude.js';
import { googleCalendar } from '../src/adapters/google-calendar.js';
import { whatsappSender } from '../src/adapters/whatsapp-cloud.js';
import { slackNotifier } from '../src/adapters/slack.js';
import { MemoryStore } from '../src/store.js';

const env = process.env;
const need = (k) => { if (!env[k]) { console.error(`Missing ${k}`); process.exit(1); } return env[k]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cfg = env.BOOKING_AGENT_CONFIG ? JSON.parse(fs.readFileSync(env.BOOKING_AGENT_CONFIG, 'utf8')) : {};

let store = new MemoryStore();
if (env.DATABASE_URL) {
  const { default: pg } = await import('pg');
  const { PostgresStore } = await import('../src/adapters/postgres-store.js');
  store = new PostgresStore(new pg.Pool({ connectionString: env.DATABASE_URL }));
} else {
  console.warn('DATABASE_URL not set: conversations live in memory and are lost on restart.');
}

const sendText = whatsappSender({ token: need('WHATSAPP_TOKEN'), phoneNumberId: need('WHATSAPP_PHONE_NUMBER_ID'), version: env.WHATSAPP_GRAPH_VERSION || 'v21.0' });
const notify = env.SLACK_WEBHOOK_URL ? slackNotifier({ webhookUrl: env.SLACK_WEBHOOK_URL }) : async (n) => console.log('handoff', n.phone, n.reason);

const agent = createAgent({
  cfg,
  brain: claudeBrain(),
  calendar: googleCalendar({
    credentials: JSON.parse(fs.readFileSync(need('GOOGLE_SERVICE_ACCOUNT_JSON'), 'utf8')),
    calendarId: need('GOOGLE_CALENDAR_ID'),
    extraBusyCalendars: (env.GOOGLE_EXTRA_BUSY_CALENDARS || '').split(',').filter(Boolean),
  }),
  store,
  // Pace like a person: wait the "typing" time before each bubble.
  send: async ({ phone, text, typingMs }) => { await sleep(typingMs); await sendText({ phone, text }); },
  notify,
});

const { server } = createServer({
  agent, verifyToken: need('WHATSAPP_VERIFY_TOKEN'), appSecret: need('WHATSAPP_APP_SECRET'),
  adminToken: env.ADMIN_TOKEN, quietMs: Number(env.BUFFER_QUIET_MS || 8000),
});
const port = Number(env.PORT || 3000);
server.listen(port, () => console.log(`booking agent on :${port} (mode ${agent.cfg.mode})`));
