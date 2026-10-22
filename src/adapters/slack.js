// Team alerts through a Slack incoming webhook (one URL per channel).
// kind 'handoff': the agent went silent; 'delivery': a send failed and a person
// has to act; 'error': the agent could not answer (calendar or database down);
// 'limit': one conversation hit its daily reply cap. Any can carry a note.
export function slackNotifier({ webhookUrl, fetchImpl = (...a) => fetch(...a) }) {
  return async function notify({ kind = 'handoff', phone, reason, note, profile = {} }) {
    const who = [profile.name, profile.company].filter(Boolean).join(', ') || 'unknown lead';
    const heads = {
      delivery: `:warning: WhatsApp message not delivered: ${who} (${phone}).`,
      error: `:rotating_light: The agent could not answer ${who} (${phone}). The message is saved; reply by hand.`,
      limit: `:no_entry: ${who} (${phone}) reached the daily reply limit for one conversation. The agent pauses there until tomorrow.`,
      handoff: `:raising_hand: WhatsApp handoff: ${who} (${phone}). Reason: ${reason}. The agent is now silent in this conversation.`,
    };
    const head = heads[kind] || heads.handoff;
    const text = note ? `${head} ${note}` : head;
    const res = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`Slack webhook failed: HTTP ${res.status}`);
  };
}
