// Team alerts through a Slack incoming webhook (one URL per channel).
// kind 'handoff': the agent went silent; kind 'delivery': a send failed and a
// person has to act. Either can carry a note (what failed, what to do).
export function slackNotifier({ webhookUrl, fetchImpl = (...a) => fetch(...a) }) {
  return async function notify({ kind = 'handoff', phone, reason, note, profile = {} }) {
    const who = [profile.name, profile.company].filter(Boolean).join(', ') || 'unknown lead';
    const head = kind === 'delivery'
      ? `:warning: WhatsApp message not delivered: ${who} (${phone}).`
      : `:raising_hand: WhatsApp handoff: ${who} (${phone}). Reason: ${reason}. The agent is now silent in this conversation.`;
    const text = note ? `${head} ${note}` : head;
    const res = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`Slack webhook failed: HTTP ${res.status}`);
  };
}
