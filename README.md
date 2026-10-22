# whatsapp-booking-agent

![tests](https://github.com/felipe-sore/whatsapp-booking-agent/actions/workflows/test.yml/badge.svg)

An agent that talks to leads on WhatsApp, qualifies them and books a meeting on a real calendar, without ever inventing a time, leaking someone else's agenda or booking without the data it needs.

**The model talks. The code decides.** Claude reads the conversation and returns a structured decision (reply, offer times, book, reschedule, cancel, hand over, stay silent). Everything that can cost money, embarrass the business or leak data is enforced in tested code, whatever the model returned.

```
lead message ─▶ buffer ─▶ gates ─▶ Claude (decision as JSON) ─▶ rules in code ─▶ calendar / CRM / reply
                 (bursts,   (human took over,                     (slots, privacy,
                  dupes)     stop labels, shadow,                  required fields,
                             hours, daily cap)                     re-check before booking)
```

## Why it is built this way

I build and run WhatsApp bots for real businesses (sales, scheduling, outbound). The bots that relied on the prompt for their critical rules had the weak spots you would expect: a time offered that was not free, a slot on the same day when the business said never, a model that could see everyone's events and was only *asked* to filter them, a free-form tool that could delete data, lead text concatenated into SQL. This project is the version I would want in production, with each of those failure modes moved out of the prompt and into code with a test.

| Rule | Where it lives | Test |
|---|---|---|
| Times are computed from the real calendar, in the business time zone, with duration, gap, notice, same-day policy, holidays and a booking horizon | `src/slots.js` | `tests/slots.test.js` (including DST and midnight) |
| The model never writes a time; any clock time it writes that was not offered is dropped | `src/messages.js` | `tests/units.test.js`, evals |
| No booking without name, company and a valid email; the code asks for what is missing | `src/agent.js` | `tests/agent.test.js` |
| The slot is re-checked against the calendar right before booking, and a slot offered days ago that is now past the notice window is not booked | `src/agent.js` | race and stale-slot tests in `tests/agent.test.js` |
| One turn at a time per conversation: two bursts never book the same slot twice, and a human who replies while the bot is thinking wins | `src/agent.js` | concurrency tests in `tests/agent.test.js` |
| The model never sees other people's events; reschedule and cancel act only on the lead's own meeting | `src/adapters/memory-calendar.js`, `src/agent.js` | privacy and cancel tests |
| Cancel needs an explicit confirmation | `src/agent.js` | cancel test |
| A human writing in the conversation silences the agent for good | `src/gates.js` | gate and agent tests |
| Model error, refusal or malformed output hands over to a human with a neutral message | `src/agent.js`, `src/decision.js` | failure tests |
| A failed WhatsApp send is classified by its Meta error code (transient, low reputation, permanent, unknown), whether it fails on the call or later as a `failed` status on the webhook; the team is alerted when a person has to act, including a booking the lead never heard about, and a broken alert never loses the turn | `src/delivery.js`, `src/agent.js` | delivery tests |
| Lead score and the audit trail of every field change are computed by code | `src/lead.js` | `tests/units.test.js` |
| One question per turn, short bubbles, no long dashes | `src/messages.js` | evals |
| Shadow mode (decide and log; no message, no calendar write, no team ping), canary conversations, reply hours, daily cap | `src/gates.js`, `src/agent.js` | gate tests |

## Try it in one minute

```bash
git clone https://github.com/felipe-sore/whatsapp-booking-agent.git
cd whatsapp-booking-agent && npm install
npm run chat                 # scripted brain, no API key, fictional calendar
npm run chat -- --claude     # Claude (needs ANTHROPIC_API_KEY or `ant auth login`)
npm run chat -- --en         # English
```

Inside the simulator, `/events` shows the calendar and `/log` shows the last decision with every rule the code applied.

## Evals

`npm run eval` plays scripted conversations and grades every agent turn: no clock time that was not offered, at most one question, bubble length and count, no long dash, no private calendar title (the demo calendar has meetings like "Board review: Project Falcon" that must never appear). Every created event is checked for a valid email, the lead's phone and no overlap with existing meetings.

One scenario uses a **rogue model** that tries to book without data, invents "tomorrow at 15:00", asks two questions and uses a long dash. The code has to hold, and the transcript is in the report.

- In CI the evals run with a deterministic scripted brain: they test the pipeline on every push.
- `npm run eval -- --claude` runs the same scenarios against the real model (it uses API tokens).

The latest report is generated in [`evals/report.md`](evals/report.md).

## The model call

`src/brain/claude.js`, one request per turn:

- `claude-opus-5-5` by default (`BOOKING_AGENT_MODEL` to change), effort `low` for chat (`BOOKING_AGENT_EFFORT`).
- Structured outputs with the JSON schema in `src/decision.js`, validated again by hand before anything runs.
- The system prompt is static per business and cached; the per-turn context (now, what is known, offered slots, the lead's own meetings) rides on the last user message, so the cached prefix never changes.
- Server-side fallback (`fallbacks: "default"`) re-runs a declined request on another model; a final refusal hands the conversation to a human.

The prompt (`src/prompt.js`) carries what I learned writing sales and booking bots: a decision hierarchy for when rules conflict, when to stop qualifying (need, name and company known), when to hand over, and how to treat hesitation. What the prompt does not carry is any rule the business cannot afford to see broken.

## Configuration

`src/config.js`: business name and services, locale (`pt-BR` and `en` included), time zone, meeting duration, gap, step, minimum notice, same-day policy, horizon, working hours per weekday, holidays, required fields, event title, internal attendees, gates (mode, canary list, stop labels, reply hours, daily cap) and message shape.

## Run it for real

```bash
cp .env.example .env        # WhatsApp Cloud API, Google service account, Claude, optional Slack
docker compose up -d        # agent + Postgres (schema in sql/schema.sql)
```

- **WhatsApp Cloud API:** point the app webhook to `https://<host>/webhook` with your `WHATSAPP_VERIFY_TOKEN`. Every POST is verified against `x-hub-signature-256` on the raw body before parsing; bursts are buffered and duplicates dropped.
- **Google Calendar:** share the calendar with the service account. The lead's phone is stored in the event's private extended properties, and own events are fetched with a server-side filter on it. Add a public holiday calendar to `GOOGLE_EXTRA_BUSY_CALENDARS` to block holidays.
- **Handoff:** `SLACK_WEBHOOK_URL` posts every handoff. When a person on your team takes a conversation, `POST /conversations/<phone>/human` with `Authorization: Bearer $ADMIN_TOKEN` silences the agent there.
- **Postgres:** every query is parameterized; a test feeds `'); DROP TABLE` through every write path.
- **Go live gradually:** start with `"mode": "shadow"` in `BOOKING_AGENT_CONFIG` (decides and logs; sends nothing and writes nothing to the calendar), then a canary list, then everyone.

## Status

| Phase | Scope | Status |
|---|---|---|
| 1 | Engine, rules, scripted and Claude brains, simulator, tests, evals | done |
| 2 | WhatsApp Cloud API webhook and sender (with Meta error triage), Google Calendar, Slack alerts, Postgres store, HTTP server, Docker | done, tested against mocked APIs |
| 3 | Same evals against the real model | optional: `npm run eval -- --claude` with your own API key, or the manual workflow `evals (Claude)` with an `ANTHROPIC_API_KEY` secret |

The code is new: what makes it trustworthy today is the test suite and the evals, not production traffic. The adapters are tested against the documented request and response shapes, not yet against live accounts.

## Tests

`npm test`: slot engine (time zones, DST, gap, notice, holidays), message shaping, lead profile and score, gates, buffer, every booking rule in the agent with a stubbed model, Meta send-error triage, the Claude request contract, webhook signature and parsing, the HTTP server end to end, Google Calendar (signed JWT, privacy filter, all-day events), Slack and the Postgres store. Node 18, 20 and 22 on every push.

## About

Built by [Felipe Sore](https://linkedin.com/in/felipesore) with Claude Code.

## License

MIT. See [LICENSE](LICENSE).
