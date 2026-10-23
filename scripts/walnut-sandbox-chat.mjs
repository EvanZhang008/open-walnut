#!/usr/bin/env bun
/**
 * Send ONE message to a sandbox Walnut Personal AI over the WebSocket RPC and print its reply.
 * Proves a credential works end-to-end (Personal AI actually answers), not just that auth resolves.
 *
 * The WS broadcast envelope is { type:'event', name:'agent:...', data:{...}, seq } — we
 * accumulate `agent:text-delta` { delta } and resolve on `agent:response` { text }.
 *
 * Runs on bun (scripts/walnut-sandbox.sh starts it with the sandbox's own bun). It uses the
 * runtime's built-in WebSocket, so it needs nothing from node_modules.
 *
 * Usage: bun scripts/walnut-sandbox-chat.mjs <ws-base-url> ["message"]
 *   e.g. bun scripts/walnut-sandbox-chat.mjs http://localhost:3457 "what can you do?"
 */
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

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ type: 'req', id, method: 'chat', payload: { message } }));
});
ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
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
ws.addEventListener('error', (e) => { console.log('WS error: ' + (e.message || 'connection failed')); done(3); });
