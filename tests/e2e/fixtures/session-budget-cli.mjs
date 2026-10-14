import fs from 'node:fs';
import readline from 'node:readline';

// This fixture has no network access or child processes. Cleanup is nonce-scoped and self-directed.
const required = ['BUDGET_FIXTURE_SID', 'BUDGET_FIXTURE_TRANSCRIPT', 'BUDGET_FIXTURE_PROXY', 'BUDGET_FIXTURE_WITNESS', 'BUDGET_FIXTURE_CLEANUP', 'BUDGET_FIXTURE_NONCE'];
for (const key of required) if (!process.env[key]) throw new Error(`Missing fixture setting: ${key}`);
const sid = process.env.BUDGET_FIXTURE_SID;
const nonce = process.env.BUDGET_FIXTURE_NONCE;
const witness = row => fs.appendFileSync(process.env.BUDGET_FIXTURE_WITNESS, JSON.stringify({ nonce, ...row }) + '\n');
const emit = row => process.stdout.write(JSON.stringify(row) + '\n');
const finish = () => { witness({ event: 'exit', pid: process.pid }); process.exit(0); };
process.on('SIGINT', finish);
process.on('SIGTERM', finish);
setTimeout(finish, 90_000);
setInterval(() => {
  try { if (fs.readFileSync(process.env.BUDGET_FIXTURE_CLEANUP, 'utf8') === nonce) finish(); } catch {}
}, 50);
witness({ event: 'ready', pid: process.pid });
emit({ type: 'system', subtype: 'init', session_id: sid });
let count = 0;
readline.createInterface({ input: process.stdin }).on('line', line => {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  if (frame.type === 'control_request') {
    witness({ event: 'control', request: frame.request });
    emit({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
    return;
  }
  if (frame.type !== 'user') return;
  witness({ event: 'user', text: frame.message?.content });
  const id = `reply-${nonce}-${++count}-${Date.now()}`;
  const timestamp = new Date().toISOString();
  const usage = { input_tokens: 0, output_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, speed: 'standard', inference_geo: '', service_tier: 'standard' };
  const canonical = { type: 'assistant', sessionId: sid, timestamp,
    message: { id, model: 'claude-opus-5-5', stop_reason: 'end_turn', usage } };
  fs.appendFileSync(process.env.BUDGET_FIXTURE_TRANSCRIPT, JSON.stringify(canonical) + '\n');
  fs.appendFileSync(process.env.BUDGET_FIXTURE_PROXY, 'request CACHE ' + JSON.stringify({ request_id: id, session_id: sid,
    started_ms: Date.parse(timestamp) - 1, finished_ms: Date.parse(timestamp), requested_model: 'claude-opus-5-5',
    response_model: 'claude-opus-5-5', forwarded_model: 'global.anthropic.claude-opus-5-5',
    ...usage, outcome: 'complete', usage_present: true }) + '\n');
  emit({ ...canonical, session_id: sid, message: { ...canonical.message, stop_reason: null } });
  emit({ type: 'result', subtype: 'success', session_id: sid, total_cost_usd: 9999, is_error: false });
});
