import http from 'node:http';
import { verifySignature, parseWebhook } from './adapters/whatsapp-cloud.js';
import { MessageBuffer } from './buffer.js';

// HTTP front door for the WhatsApp Cloud API.
//   GET  /webhook                      Meta's subscription check (hub.challenge)
//   POST /webhook                      inbound messages, signature verified on the raw body
//   POST /conversations/:phone/human   a human took over: the agent goes silent (Bearer ADMIN_TOKEN)
//   GET  /health
// Meta expects a fast 200, so messages go to the buffer and are answered after a quiet period.

export function createServer({ agent, verifyToken, appSecret, adminToken, quietMs = 8000, log = console }) {
  const buffer = new MessageBuffer({
    quietMs,
    onFlush: (turn) => agent.handle(turn).catch((err) => log.error(`turn failed for ${turn.phone}: ${err.message}`)),
  });

  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 1e6) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const reply = (status, body = '') => { res.writeHead(status, { 'Content-Type': 'text/plain' }); res.end(body); };
    try {
      if (req.method === 'GET' && url.pathname === '/health') return reply(200, 'ok');

      if (req.method === 'GET' && url.pathname === '/webhook') {
        const ok = url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === verifyToken;
        return ok ? reply(200, url.searchParams.get('hub.challenge') || '') : reply(403, 'forbidden');
      }

      if (req.method === 'POST' && url.pathname === '/webhook') {
        const raw = await readBody(req);
        if (!verifySignature(raw, req.headers['x-hub-signature-256'], appSecret)) return reply(401, 'bad signature');
        for (const m of parseWebhook(JSON.parse(raw.toString('utf8')))) {
          buffer.push({ conversationId: m.phone, phone: m.phone, messageId: m.messageId, text: m.text });
        }
        return reply(200, 'ok');
      }

      const human = url.pathname.match(/^\/conversations\/([^/]+)\/human$/);
      if (req.method === 'POST' && human) {
        if (!adminToken || req.headers.authorization !== `Bearer ${adminToken}`) return reply(401, 'unauthorized');
        const found = await agent.humanReplied(decodeURIComponent(human[1]));
        return found ? reply(200, 'agent silenced') : reply(404, 'no conversation');
      }

      return reply(404, 'not found');
    } catch (err) {
      log.error(`request failed: ${err.message}`);
      return reply(400, 'bad request');
    }
  });

  return { server, buffer };
}
