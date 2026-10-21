// Handoff alert through a Slack incoming webhook (one URL per channel).
export function slackNotifier({ webhookUrl, fetchImpl = (...a) => fetch(...a) }) {
  return async function notify({ phone, reason, profile = {} }) {
    const who = [profile.name, profile.company].filter(Boolean).join(', ') || 'unknown lead';
    const res = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `:raising_hand: WhatsApp handoff: ${who} (${phone}). Reason: ${reason}. The agent is now silent in this conversation.` }),
    });
    if (!res.ok) throw new Error(`Slack webhook failed: HTTP ${res.status}`);
  };
}
