import crypto from 'node:crypto';

// WhatsApp Cloud API (Meta): webhook signature, inbound parsing, outbound text.

// Meta signs every webhook with the app secret: header "x-hub-signature-256: sha256=<hex>".
// The signature covers the raw body, so verify before parsing.
export function verifySignature(rawBody, header, appSecret) {
  if (!header || !appSecret) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Inbound messages only; delivery statuses and other events are ignored.
export function parseWebhook(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      for (const m of v.messages || []) {
        let text = null;
        if (m.type === 'text') text = m.text?.body;
        else if (m.type === 'interactive') text = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title;
        else if (m.type === 'button') text = m.button?.text;
        out.push({
          messageId: m.id,
          phone: `+${m.from}`,
          phoneNumberId: v.metadata?.phone_number_id,
          type: m.type,
          text: text ?? `[${m.type} message]`,
          timestamp: Number(m.timestamp) * 1000,
        });
      }
    }
  }
  return out;
}

export function whatsappSender({ token, phoneNumberId, version = 'v21.0', fetchImpl = (...a) => fetch(...a) }) {
  return async function sendText({ phone, text }) {
    const res = await fetchImpl(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: phone.replace(/^\+/, ''), type: 'text', text: { body: text, preview_url: false } }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(`WhatsApp send failed: HTTP ${res.status} ${body.error?.code || ''} ${body.error?.message || ''}`.trim());
      err.code = body.error?.code ?? null; // the Meta error code, read by src/delivery.js
      err.status = res.status;
      throw err;
    }
    return res.json();
  };
}
