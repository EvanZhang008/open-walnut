#!/usr/bin/env node
/**
 * A stand-in `claude -p` for the one-shot tests (oneshot-core.ts). It speaks
 * the CLI's stream-json output in both input modes:
 *
 * - text mode (no --input-format): reads stdin to EOF, then answers it once.
 * - stream-json input: prints its init line at once (a pooled child does this
 *   while it boots), answers every user message line, exits at stdin EOF.
 *
 * Each answer carries who ran it: pid, ppid (the daemon, when the daemon ran
 * it), cwd, the ONESHOT_PROBE env var, and whether it was a --resume. A message
 * containing "hang" is never answered; "crash" exits 3 after a stderr line.
 * With --include-partial-messages the answer also streams as two text deltas.
 */
const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const streamIn = flag('--input-format') === 'stream-json'
const partial = args.includes('--include-partial-messages')
const sessionId = flag('--session-id') || flag('--resume') || 'fake-' + process.pid
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')

function info() {
  return {
    pid: process.pid,
    ppid: process.ppid,
    cwd: process.cwd(),
    probe: process.env.ONESHOT_PROBE || '',
    resume: args.includes('--resume'),
    model: flag('--model') || '',
  }
}

function answer(text) {
  if (text.includes('hang')) { setInterval(() => {}, 60_000); return }
  if (text.includes('crash')) { process.stderr.write('boom\n'); process.exit(3) }
  const reply = 'reply:' + text.trim() + ' ' + JSON.stringify(info())
  if (partial) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'reply:' } } })
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply.slice(6) } } })
  }
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } })
  out({ type: 'result', subtype: 'success', result: reply, total_cost_usd: 0.0123, usage: { input_tokens: 5, output_tokens: 7 } })
}

process.stderr.write('fake-claude warn\n')
process.stdin.setEncoding('utf8')
if (streamIn) {
  out({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(), model: 'fake' })
  let buf = ''
  process.stdin.on('data', (chunk) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      try {
        const msg = JSON.parse(line)
        if (msg.type === 'user') answer(String(msg.message && msg.message.content))
      } catch { /* not a message */ }
    }
  })
  process.stdin.on('end', () => process.exit(0))
} else {
  let all = ''
  process.stdin.on('data', (chunk) => { all += chunk })
  process.stdin.on('end', () => {
    out({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(), model: 'fake' })
    answer(all)
    if (!all.includes('hang')) process.exit(0)
  })
}
