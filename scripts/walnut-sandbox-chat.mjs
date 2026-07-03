#!/usr/bin/env node
/**
 * Send ONE message to a sandbox Walnut butler over the WebSocket RPC and print its reply.
 * Proves a credential works end-to-end (butler actually answers), not just that auth resolves.
 *
 * The WS broadcast envelope is { type:'event', name:'agent:...', data:{...}, seq } — we
 * accumulate `agent:text-delta` { delta } and resolve on `agent:response` { text }.
 *
 * Usage: node scripts/walnut-sandbox-chat.mjs <ws-base-url> ["message"]
 *   e.g. node scripts/walnut-sandbox-chat.mjs http://localhost:3457 "what can you do?"
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { default: WebSocket } = await import(path.join(HERE, '..', 'node_modules', 'ws', 'index.js'));

const base = process.argv[2] || 'http://localhost:3457';
const message = process.argv[3] || 'in one sentence, what can you help me with?';
const wsUrl = base.replace(/^http/, 'ws') + '/ws';

const ws = new WebSocket(wsUrl);
let reply = '';
const id = 'sandbox-' + Math.floor(performance.now());
const done = (code) => { try { ws.close(); } catch {} process.exit(code); };
const timeout = setTimeout(() => {
  if (reply.length > 0) { console.log('REPLY (timeout, partial):\n' + reply); done(0); }
  else { console.log('NO REPLY within 60s'); done(1); }
}, 60_000);

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'req', id, method: 'chat', payload: { message } }));
});
ws.on('message', (buf) => {
  let m; try { m = JSON.parse(buf.toString()); } catch { return; }
  if (m.type !== 'event') return;
  if (m.name === 'agent:text-delta' && m.data && typeof m.data.delta === 'string') {
    reply += m.data.delta;
  } else if (m.name === 'agent:response' && m.data && typeof m.data.text === 'string') {
    clearTimeout(timeout);
    console.log('REPLY:\n' + m.data.text);
    done(0);
  } else if (m.name === 'agent:error') {
    clearTimeout(timeout);
    console.log('AGENT ERROR: ' + (m.data && m.data.error));
    done(2);
  }
});
ws.on('error', (e) => { console.log('WS error: ' + e.message); done(3); });
