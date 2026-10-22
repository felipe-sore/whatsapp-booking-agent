// Team alerts through a Slack incoming webhook (one URL per channel):
// handoffs, and failed sends that need a person.
export function slackNotifier({ webhookUrl, fetchImpl = (...a) => fetch(...a) }) {
  return async function notify({ phone, reason, note, profile = {} }) {
    const who = [profile.name, profile.company].filter(Boolean).join(', ') || 'unknown lead';
    const text = reason === 'delivery_failed'
      ? `:warning: WhatsApp message not delivered: ${who} (${phone}). ${note}`
      : `:raising_hand: WhatsApp handoff: ${who} (${phone}). Reason: ${reason}. The agent is now silent in this conversation.`;
    const res = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`Slack webhook failed: HTTP ${res.status}`);
  };
}
