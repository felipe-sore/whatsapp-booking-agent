---
name: whatsapp-booking-agent
description: >
  Operate and extend a WhatsApp agent that qualifies leads and books meetings on a real calendar,
  where Claude proposes a decision and code enforces every rule (slots, privacy, required fields,
  handoff). Use to configure a business, run the simulator, run and read the evals, add an eval
  scenario, change a booking rule with its test, or read why the agent did something.
---

# WhatsApp booking agent

## Principle

The model talks; the code decides. Before changing anything, ask: "if the model got this wrong,
what would happen?" If the answer costs money, embarrasses the business or leaks data, the rule
belongs in code with a test, not in the prompt.

## Common jobs

- **Configure a business:** edit `src/config.js` (or pass a `cfg` object to `createAgent`). Ask the
  user for time zone, meeting duration, gap, minimum notice, same-day policy, working hours,
  holidays, services and the fields required before booking. Then run `npm test` and `npm run eval`.
- **Try it:** `npm run chat` (scripted brain) or `npm run chat -- --claude`. `/log` shows the last
  decision: what the model proposed (`modelAction`), what the code did (`action`) and why (`notes`).
- **Evals:** `npm run eval` checks the pipeline. `npm run eval -- --claude` grades the real model and
  costs API tokens: ask before running it. Read `evals/report.md`; a failing scenario includes a
  per-turn trace (`turn:modelAction>finalAction[notes]`).
- **Add a scenario:** append to `evals/scenarios.json` with the turns and the expectation
  (`booked`, `handoff`, `cancelled`, `notBookedBeforeTurn`). Universal checks run on every turn.
- **Change a rule:** write or adjust the test in `tests/` first, then the code. Never move a rule
  from code into the prompt.

## Before going live (phase 2)

Start in `mode: 'shadow'` (decides and logs, sends nothing), review the decision log on real
conversations, then `live` with a canary list of 3 to 5 conversations, then everyone.

## Never

- Let the model see raw calendar events or other leads' data.
- Give the model a tool that deletes or writes free-form data.
- Concatenate user text into SQL or shell commands.
- Mark a booking as done in the reply before the calendar call succeeded.
