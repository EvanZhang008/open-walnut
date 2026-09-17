#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'

const root = process.env.WARM_FIXTURE_ROOT
if (!root || !root.includes('walnut-warm-ui-')) throw new Error('An isolated warm fixture is required')
const args = process.argv.slice(2)
const value = (flag) => args[args.indexOf(flag) + 1]
const sid = args.includes('--resume') ? value('--resume') : value('--session-id')
const emit = (event) => process.stdout.write(JSON.stringify({ ...event, session_id: sid }) + '\n')
const transcriptDir = path.join(root, '.claude/projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'))
fs.mkdirSync(transcriptDir, { recursive: true })
const transcript = path.join(transcriptDir, `${sid}.jsonl`)
let parentUuid = null
if (fs.existsSync(transcript)) {
  const rows = fs.readFileSync(transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  parentUuid = rows.at(-1)?.uuid ?? null
}
function persist(message) {
  const uuid = randomUUID()
  fs.appendFileSync(transcript, JSON.stringify({ type: message.role, message, uuid, parentUuid, sessionId: sid, cwd: process.cwd(), timestamp: new Date().toISOString() }) + '\n')
  parentUuid = uuid
}
let turns = 0
let chain = Promise.resolve()
emit({ type: 'system', subtype: 'init', model: 'mock-warm-model', cwd: process.cwd(), tools: [], mcp_servers: [], permissionMode: 'bypassPermissions' })

async function answer(content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content)
  const tag = text.match(/warm-check ([a-z0-9-]+)/)?.[1]
  if (!tag) throw new Error('Expected a warm-check prompt')
  persist({ role: 'user', content: text })
  fs.writeFileSync(path.join(root, `received-${tag}.json`), JSON.stringify({ pid: process.pid, sid, args, text }))
  if (tag.endsWith('-crash')) process.exit(2)
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (!fs.existsSync(path.join(root, `release-${tag}`))) return
      clearInterval(timer)
      resolve()
    }, 20)
  })
  const reply = tag.endsWith('-dense')
    ? Array.from({ length: 80 }, (_, i) => `## Section ${i + 1}\n\nA realistic conversation section with repeated technical details, a state transition, and verification evidence.\n\n\`status = idle; pid = unchanged\`\n`).join('\n')
    : `Verified reply ${tag}: ${String.fromCodePoint(0x4f60, 0x597d, 0x1f680)}`
  const id = `warm-${process.pid}-${++turns}`
  const message = { id, type: 'message', role: 'assistant', model: 'mock-warm-model', content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50 } }
  persist(message)
  emit({ type: 'assistant', message })
  emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 100, num_turns: 1, result: reply, total_cost_usd: turns * 0.001, usage: { input_tokens: 100, output_tokens: 50 } })
  emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const event = JSON.parse(line)
  if (event.type === 'user') {
    chain = chain.then(() => answer(event.message.content)).catch((error) => { process.stderr.write(String(error)); process.exit(3) })
  } else if (event.type === 'control_request') {
    const question = String(event.request.question ?? '')
    const answer = question.includes('PHASE_SIGNAL')
      ? 'EXEC_SUMMARY: Warm session verification.\nUSER_REQUEST: Verify warm sends.\nCONTEXT: Isolated fixture.\nPROGRESS: [WIP] Verification.\nREFERENCES: unchanged\nWORK_LOG: Verified a turn.\nPHASE_SIGNAL: conversational(user-asked-question).'
      : 'Warm session verification'
    emit({ type: 'control_response', response: { subtype: 'success', request_id: event.request_id, response: { response: answer, title: 'Warm session verification' } } })
  }
})
