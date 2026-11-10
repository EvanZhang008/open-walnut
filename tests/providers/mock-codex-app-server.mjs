#!/usr/bin/env node
/**
 * A scripted stand-in for `codex app-server` (NDJSON JSON-RPC on stdio), for the
 * direct Codex client's tests. `--version` prints MOCK_CODEX_VERSION (default
 * 0.167.0). Every request the client sends is appended to MOCK_CODEX_LOG, and
 * threads persist under CODEX_HOME so a second process can resume one.
 *
 * A prompt's first word picks what the turn does:
 *   (anything else)   streams "echo: <text>" and completes
 *   SLOW <ms>         streams a delta every 50ms until <ms>, then completes; a steer is echoed
 *   CMD               a command item: started, output, completed
 *   ASK_CMD           asks a command approval, then says the decision
 *   ASK_FILE          asks a file-change approval, then says the decision
 *   ASK_MCP           an MCP tool call that asks an elicitation, then says the answer
 *   USAGE_LIMIT | RATE_LIMIT | OVERLOADED | HTTP_502   the turn fails with that error
 *   DIE               exits mid-turn
 *   HANG              starts the turn and sends nothing more
 *   GHOST             completes, then sends late events of that turn while the next one starts
 *   DEAF              like SLOW 60000, but turn/interrupt never ends it
 *   RACE              a steer meets the turn's end: turn/completed first, then the steer's error
 *   RACE_LATE         the steer's error first, the turn's end 200ms later
 *   NOT_STEERABLE     a steer is refused with activeTurnNotSteerable
 *   SLOW_ACK          a steer is taken (its userMessage item is sent), the turn ends 300ms later,
 *                     and the steer's answer comes MOCK_STEER_ACK_MS (1500) after it
 *   HANG_DEAF         like HANG, and turn/interrupt is answered but never ends the turn
 *   STEER_AFTER_FINAL says "ok", then a steer is taken (answered, its userMessage item sent)
 *                     and the turn completes without answering it, as real Codex does
 *                     (MOCK_FINAL_STEER_ACK_MS delays the steer's answer)
 *   LATE_ACK_FINAL    STEER_AFTER_FINAL, with the turn/start answer sent 400ms after its events
 *   STOP_RACE_FINAL   STEER_AFTER_FINAL whose steer does not end it; turn/interrupt is answered and
 *                     the turn then ends "completed" (Codex finished just before the stop)
 *   WARN              sends a warning notification, then says "ok"
 *   HOLD_OWN          reports its own input only after the first steer's report and answer
 *   REJECT_SAME       reports its own input at the first steer (send the same words), then
 *                     ends and refuses that steer
 *   PLAN              completes a plan item ("1. Do it."), then the turn
 *   BG [<ms>]         starts a command and ends the turn with it running, as a background
 *                     terminal (thread/backgroundTerminals/list has it); <ms> (400) later it
 *                     exits 0 and its item/completed comes under the ended turn's id, as real
 *                     Codex 0.167 does (MOCK_BG_SILENT: it only leaves the list)
 *   BG_HOLD           the same, but it runs until terminated (thread/backgroundTerminals/terminate)
 *   BG_READ <pid>     background terminal <pid> exits inside this turn, then the turn reads it
 *                     (a terminalInteraction after its end); says "read", ends
 *   BG_PEEK <pid>     reads background terminal <pid> while it runs, then it exits 1 later in
 *                     the same turn; says "peeked", ends
 * thread/compact/start runs a compaction turn; review/start runs a child turn (its own id,
 * rootTurnId = the answered id) that says "review: <instructions>", ended under the root id.
 * config/read gives MOCK_SANDBOX_WW (JSON) as the [sandbox_workspace_write] table.
 * A thread id ending in 0000locked: thread/resume fails as an unreadable rollout would.
 * Like Codex, every input the turn takes (its prompt, each steer) is sent as a userMessage item.
 */

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'

const argv = process.argv.slice(2)
if (argv.includes('--version')) {
  process.stdout.write(`codex-cli ${process.env.MOCK_CODEX_VERSION || '0.167.0'}\n`)
  process.exit(0)
}
if (argv.includes('debug')) {
  process.stdout.write(JSON.stringify({ models: [] }) + '\n')
  process.exit(0)
}
if (!argv.includes('app-server')) {
  process.stderr.write(`mock codex: unsupported args ${argv.join(' ')}\n`)
  process.exit(2)
}

const LOG = process.env.MOCK_CODEX_LOG
const HOME = process.env.CODEX_HOME || fs.mkdtempSync('/tmp/mock-codex-home-')
const THREADS = path.join(HOME, 'mock-threads.json')
const log = (entry) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify({ pid: process.pid, ...entry }) + '\n') }
log({ kind: 'spawn', argv })

const readThreads = () => { try { return JSON.parse(fs.readFileSync(THREADS, 'utf8')) } catch { return {} } }
const saveThread = (id, data) => { const all = readThreads(); all[id] = data; fs.writeFileSync(THREADS, JSON.stringify(all)) }

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const notify = (method, params) => { if (process.env.MOCK_CODEX_TRACE) log({ kind: 'sent', method, turnId: params?.turnId ?? params?.turn?.id }); send({ method, params }) }
let nextServerId = 1000
const waiting = new Map()
const askClient = (method, params) => new Promise((resolve) => {
  const id = nextServerId++
  waiting.set(id, resolve)
  send({ id, method, params })
})

let threadId = null
let ghostOf = null
/** Background terminals: processId -> { itemId, turnId, command, timer } */
const bgTerms = new Map()
let nextPid = 4242
function endBackground(pid, exitCode, output) {
  const b = bgTerms.get(pid)
  if (!b) return
  clearTimeout(b.timer)
  bgTerms.delete(pid)
  if (process.env.MOCK_BG_SILENT) return
  notify('item/completed', { threadId, turnId: b.turnId, item: { type: 'commandExecution', id: b.itemId, command: b.command, cwd: '/tmp', processId: pid, status: 'completed', exitCode, aggregatedOutput: output, commandActions: [] } })
}
/** @type {null | { id: string, kind: string, steers: string[], end: (status: string, error?: object) => void, done: boolean }} */
let turn = null
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const MODELS = [
  { id: 'gpt-mock', model: 'gpt-mock', displayName: 'GPT Mock', description: 'Mock model', hidden: false, isDefault: true,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }, { reasoningEffort: 'medium', description: 'Medium' }, { reasoningEffort: 'high', description: 'High' }] },
  { id: 'gpt-mock-mini', model: 'gpt-mock-mini', displayName: 'GPT Mock Mini', description: 'Small mock', hidden: false, isDefault: false,
    defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }] },
]

// Like Codex 0.167, the item carries the client id the input was sent with (MOCK_NO_CLIENT_ID: none, as an older Codex).
function userItem(turnId, text, clientId) {
  const item = { type: 'userMessage', id: `u_${randomUUID().slice(0, 8)}`, clientId: process.env.MOCK_NO_CLIENT_ID ? null : clientId ?? null, content: [{ type: 'text', text, text_elements: [] }] }
  notify('item/started', { threadId, turnId, item })
  notify('item/completed', { threadId, turnId, item })
}

function message(turnId, text) {
  const itemId = `msg_${randomUUID().slice(0, 8)}`
  notify('item/started', { threadId, turnId, item: { type: 'agentMessage', id: itemId, text: '' } })
  notify('item/agentMessage/delta', { threadId, turnId, itemId, delta: text })
  notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: itemId, text } })
}

function usage(turnId) {
  notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: {
    total: { totalTokens: 120, inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 5 },
    last: { totalTokens: 120, inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 5 },
    modelContextWindow: 200000,
  } })
}

const FAILURES = {
  USAGE_LIMIT: { message: "You've hit your usage limit. Try again in 3 hours.", codexErrorInfo: 'usageLimitExceeded' },
  RATE_LIMIT: { message: 'Rate limit reached for requests', codexErrorInfo: 'rateLimitExceeded' },
  OVERLOADED: { message: 'The model is overloaded', codexErrorInfo: 'serverOverloaded' },
  HTTP_502: { message: 'upstream failed', codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 502 } } },
}

async function runTurn(t, text) {
  const [word, arg] = text.trim().split(/\s+/)
  const finish = (status, error) => {
    if (t.done) return
    t.done = true
    if (status === 'completed') usage(t.id)
    notify('turn/completed', { threadId, turn: { id: t.id, items: [], status, error: error ?? null } })
    if (turn === t) turn = null
    const saved = readThreads()[threadId]
    if (saved) saveThread(threadId, { ...saved, turns: [...(saved.turns || []), { id: t.id, items: [{ type: 'userMessage', id: `u_${t.id}`, content: [{ type: 'text', text }] }], status }] })
  }
  t.end = finish
  await sleep(5)
  notify('turn/started', { threadId, turn: { id: t.id, items: [], status: 'inProgress', error: null } })
  // HOLD_OWN / REJECT_SAME: the turn's own input is reported late (at the first steer).
  if (t.kind !== 'HOLD_OWN' && t.kind !== 'REJECT_SAME') userItem(t.id, text, t.clientId)
  else t.ownText = text
  if (FAILURES[word]) {
    message(t.id, 'working')
    notify('error', { threadId, turnId: t.id, willRetry: false, error: FAILURES[word] })
    finish('failed', FAILURES[word])
    return
  }
  switch (word) {
    case 'DIE':
      message(t.id, 'about to die')
      await sleep(50)
      process.exit(7)
      return
    case 'HANG': case 'HANG_DEAF':
      return
    case 'HOLD_OWN': case 'REJECT_SAME':
      message(t.id, 'working')
      t.held = true
      setTimeout(() => finish('completed'), 5000)
      return
    case 'WARN':
      notify('warning', { threadId, message: 'Model metadata for `mock-model` not found.' })
      message(t.id, 'ok')
      finish('completed')
      return
    case 'STEER_AFTER_FINAL': case 'LATE_ACK_FINAL': case 'STOP_RACE_FINAL':
      message(t.id, 'ok')
      t.held = true
      setTimeout(() => finish('completed'), 3000)
      return
    case 'BG': case 'BG_HOLD': {
      const pid = String(nextPid++)
      const itemId = `call_${t.id}`
      const command = word === 'BG' ? 'make build' : 'make watch'
      notify('item/started', { threadId, turnId: t.id, item: { type: 'commandExecution', id: itemId, command, cwd: '/tmp', processId: pid, status: 'inProgress', commandActions: [] } })
      const b = { itemId, turnId: t.id, command, timer: null }
      bgTerms.set(pid, b)
      if (word === 'BG') b.timer = setTimeout(() => endBackground(pid, 0, 'compiling\nBUILD OK\n'), Number(arg) || 400)
      message(t.id, `started ${pid}`)
      finish('completed')
      return
    }
    case 'BG_READ': {
      // It exits, then the model polls it and reads how it ended, inside this turn.
      endBackground(arg, 0, 'BUILD OK\n')
      notify('item/commandExecution/terminalInteraction', { threadId, turnId: t.id, itemId: `read_${t.id}`, processId: arg, stdin: '' })
      message(t.id, 'read')
      finish('completed')
      return
    }
    case 'BG_PEEK': {
      // The model sees it still running; it fails later in the turn, unread.
      notify('item/commandExecution/terminalInteraction', { threadId, turnId: t.id, itemId: `peek_${t.id}`, processId: arg, stdin: '' })
      message(t.id, 'peeked')
      await sleep(100)
      endBackground(arg, 1, 'BUILD FAILED\n')
      await sleep(50)
      finish('completed')
      return
    }
    case 'PLAN': {
      const item = { type: 'plan', id: `plan_${t.id}`, text: '1. Do it.' }
      notify('item/started', { threadId, turnId: t.id, item: { ...item, text: '' } })
      notify('item/completed', { threadId, turnId: t.id, item })
      finish('completed')
      return
    }
    case 'GHOST': {
      // Ends, then sends events of the ended turn after the next one began.
      message(t.id, 'first')
      finish('completed')
      ghostOf = t.id
      return
    }
    case 'SLOW': case 'DEAF': case 'RACE': case 'RACE_LATE': case 'NOT_STEERABLE': case 'SLOW_ACK': {
      const ms = word === 'SLOW' ? Number(arg) || 1000 : word === 'DEAF' ? 60_000 : 60_000
      let itemId = `msg_${t.id}`
      notify('item/started', { threadId, turnId: t.id, item: { type: 'agentMessage', id: itemId, text: '' } })
      const until = Date.now() + ms
      let seen = 0
      while (!t.done && !t.held && Date.now() < until) {
        await sleep(50)
        if (t.done || t.held) return
        // As Codex does: a steer is read by the next model call, whose answer is a new item.
        while (seen < t.steers.length) {
          notify('item/completed', { threadId, turnId: t.id, item: { type: 'agentMessage', id: itemId, text: '' } })
          itemId = `msg_${t.id}_${seen}`
          notify('item/started', { threadId, turnId: t.id, item: { type: 'agentMessage', id: itemId, text: '' } })
          notify('item/agentMessage/delta', { threadId, turnId: t.id, itemId, delta: `[steered: ${t.steers[seen++]}]` })
        }
        notify('item/agentMessage/delta', { threadId, turnId: t.id, itemId, delta: '.' })
      }
      if (!t.done && !t.held) {
        notify('item/completed', { threadId, turnId: t.id, item: { type: 'agentMessage', id: itemId, text: '' } })
        finish('completed')
      }
      return
    }
    case 'CMD': {
      const itemId = `call_${t.id}`
      notify('item/started', { threadId, turnId: t.id, item: { type: 'commandExecution', id: itemId, command: "/bin/bash -lc 'echo hi'", cwd: '/tmp', status: 'inProgress', commandActions: [] } })
      notify('item/commandExecution/outputDelta', { threadId, turnId: t.id, itemId, delta: 'hi\n' })
      notify('item/completed', { threadId, turnId: t.id, item: { type: 'commandExecution', id: itemId, command: "/bin/bash -lc 'echo hi'", cwd: '/tmp', status: 'completed', exitCode: 0, aggregatedOutput: 'hi\n', commandActions: [] } })
      message(t.id, 'ran it')
      finish('completed')
      return
    }
    case 'ASK_CMD': {
      const itemId = `call_${t.id}`
      notify('item/started', { threadId, turnId: t.id, item: { type: 'commandExecution', id: itemId, command: 'rm -rf build', cwd: '/tmp', status: 'inProgress', commandActions: [] } })
      const answer = await askClient('item/commandExecution/requestApproval', { threadId, turnId: t.id, itemId, command: 'rm -rf build', cwd: '/tmp', reason: 'cleanup' })
      log({ kind: 'approval-answer', method: 'item/commandExecution/requestApproval', answer })
      if (t.done) return
      message(t.id, `decision: ${JSON.stringify(answer.decision)}`)
      finish('completed')
      return
    }
    case 'ASK_FILE': {
      const itemId = `patch_${t.id}`
      notify('item/started', { threadId, turnId: t.id, item: { type: 'fileChange', id: itemId, status: 'inProgress', changes: [{ path: '/tmp/a.txt', kind: { type: 'add' }, diff: 'hello\n' }] } })
      const answer = await askClient('item/fileChange/requestApproval', { threadId, turnId: t.id, itemId, reason: null, grantRoot: null })
      log({ kind: 'approval-answer', method: 'item/fileChange/requestApproval', answer })
      if (t.done) return
      message(t.id, `decision: ${JSON.stringify(answer.decision)}`)
      finish('completed')
      return
    }
    case 'ASK_MCP': {
      const itemId = `mcp_${t.id}`
      notify('item/started', { threadId, turnId: t.id, item: { type: 'mcpToolCall', id: itemId, server: 'docs', tool: 'search', arguments: { q: 'x' }, status: 'inProgress' } })
      const answer = await askClient('mcpServer/elicitation/request', { threadId, turnId: t.id, serverName: 'docs', mode: 'form', message: 'Allow docs.search?', requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] } })
      log({ kind: 'approval-answer', method: 'mcpServer/elicitation/request', answer })
      if (t.done) return
      message(t.id, `elicitation: ${answer.action}`)
      finish('completed')
      return
    }
    default:
      message(t.id, `echo: ${text}`)
      finish('completed')
  }
}

function fail(id, message, data) { send({ id, error: { code: -32600, message, ...(data ? { data } : {}) } }) }

async function handle(msg) {
  const { id, method, params = {} } = msg
  log({ kind: 'request', method, params })
  switch (method) {
    case 'initialize': return send({ id, result: { userAgent: 'mock-codex/0.167.0', codexHome: HOME, platformFamily: 'unix', platformOs: 'linux' } })
    case 'model/list': return send({ id, result: { data: MODELS, nextCursor: null } })
    case 'config/read': return send({ id, result: { config: {
      model_provider: 'mock', mcp_servers: { own_server: { command: 'x' } },
      ...(process.env.MOCK_SANDBOX_WW ? { sandbox_workspace_write: JSON.parse(process.env.MOCK_SANDBOX_WW) } : {}),
    }, origins: {}, layers: [] } })
    case 'mcpServerStatus/list': return send({ id, result: { data: [{ name: 'own_server', tools: { a: {}, b: {} }, resources: [], authStatus: 'unsupported' }], nextCursor: null } })
    case 'skills/list': return send({ id, result: { data: [{ cwd: params.cwds?.[0], skills: [{ name: 'mock-skill', description: 'A mock skill' }], errors: [] }] } })
    case 'thread/compact/start': {
      if (turn) return fail(id, 'a turn is already running')
      const t = { id: `turn_${randomUUID().slice(0, 8)}`, kind: 'COMPACT', steers: [], end: () => {}, done: false }
      turn = t
      send({ id, result: {} })
      setTimeout(() => {
        notify('turn/started', { threadId, turn: { id: t.id, items: [], status: 'inProgress', error: null } })
        const item = { type: 'contextCompaction', id: `cc_${t.id}` }
        notify('item/started', { threadId, turnId: t.id, item })
        notify('item/completed', { threadId, turnId: t.id, item })
        t.done = true
        turn = null
        notify('turn/completed', { threadId, turn: { id: t.id, items: [], status: 'completed', error: null } })
      }, 20)
      return
    }
    case 'review/start': {
      if (turn) return fail(id, 'a turn is already running')
      const root = `turn_${randomUUID().slice(0, 8)}`
      const child = `turn_${randomUUID().slice(0, 8)}`
      const t = { id: root, kind: 'REVIEW', steers: [], end: () => {}, done: false }
      turn = t
      const what = params.target?.type === 'custom' ? params.target.instructions : params.target?.type
      send({ id, result: { turn: { id: root, items: [], status: 'inProgress', error: null }, reviewThreadId: threadId } })
      setTimeout(() => {
        notify('turn/started', { threadId, turn: { id: child, rootTurnId: root, items: [], status: 'inProgress', error: null } })
        userItem(child, String(what))
        message(child, `review: ${what}`)
        t.done = true
        turn = null
        notify('turn/completed', { threadId, turn: { id: root, items: [], status: 'completed', error: null } })
      }, 20)
      return
    }
    case 'thread/start': {
      threadId = randomUUID()
      saveThread(threadId, { cwd: params.cwd, turns: [] })
      return send({ id, result: { thread: { id: threadId, turns: [] }, model: 'gpt-mock', modelProvider: 'mock', reasoningEffort: 'medium', cwd: params.cwd, approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' } } })
    }
    case 'thread/resume': {
      if (String(params.threadId).endsWith('0000locked')) return fail(id, 'failed to load rollout: Permission denied (os error 13)')
      const saved = readThreads()[params.threadId]
      if (!saved) return fail(id, `no rollout found for thread id ${params.threadId}`)
      threadId = params.threadId
      const turns = params.excludeTurns ? [] : saved.turns || []
      return send({ id, result: { thread: { id: threadId, turns }, model: 'gpt-mock', modelProvider: 'mock', reasoningEffort: 'high', cwd: params.cwd } })
    }
    case 'turn/start': {
      if (turn) return fail(id, 'a turn is already running')
      const text = (params.input || []).map((i) => i.text || '').join('')
      const t = { id: `turn_${randomUUID().slice(0, 8)}`, kind: text.split(/\s+/)[0], steers: [], end: () => {}, done: false, clientId: params.clientUserMessageId }
      turn = t
      if (ghostOf) {
        // The ended turn's late events reach the client before this turn's id does.
        const old = ghostOf
        ghostOf = null
        notify('turn/started', { threadId, turn: { id: old, items: [], status: 'inProgress', error: null } })
        notify('item/agentMessage/delta', { threadId, turnId: old, itemId: 'ghost', delta: 'GHOST TEXT' })
        notify('thread/tokenUsage/updated', { threadId, turnId: old, tokenUsage: { last: { totalTokens: 999999, inputTokens: 999999, outputTokens: 0 }, total: {}, modelContextWindow: 200000 } })
      }
      const answer = () => send({ id, result: { turn: { id: t.id, items: [], status: 'inProgress', error: null } } })
      // LATE_ACK_FINAL: the turn's events come first, its answer 400ms later.
      if (t.kind === 'LATE_ACK_FINAL') setTimeout(answer, 400)
      else answer()
      void runTurn(t, text)
      return
    }
    case 'turn/steer': {
      const text = (params.input || []).map((i) => i.text || '').join('')
      const t = turn
      if (t && t.kind === 'NOT_STEERABLE') return fail(id, 'turn is not steerable', { codexErrorInfo: { activeTurnNotSteerable: { turnKind: 'review' } } })
      if (t && t.kind === 'RACE') { t.end('completed'); return fail(id, 'no active turn to steer') }
      if (t && t.kind === 'RACE_LATE') { t.held = true; setTimeout(() => t.end('completed'), 200); return fail(id, 'no active turn to steer') }
      if (!t) return fail(id, 'no active turn to steer')
      if (params.expectedTurnId !== t.id) return fail(id, `expected active turn id ${params.expectedTurnId} but found ${t.id}`)
      t.steers.push(text)
      if (t.kind === 'HOLD_OWN') {
        // The steer is reported first, answered in a new item, then the turn's own input.
        send({ id, result: { turnId: t.id } })
        userItem(t.id, text, params.clientUserMessageId)
        message(t.id, `[steered: ${text}]`)
        userItem(t.id, t.ownText, t.clientId)
        setTimeout(() => t.end('completed'), 20)
        return
      }
      if (t.kind === 'REJECT_SAME') {
        // Only the turn's own input (the same words) is reported; the steer is refused.
        userItem(t.id, t.ownText, t.clientId)
        t.end('completed')
        return fail(id, 'no active turn to steer')
      }
      if (t.kind === 'STEER_AFTER_FINAL' || t.kind === 'LATE_ACK_FINAL') {
        // MOCK_FINAL_STEER_ACK_MS: the steer's answer comes that long after Codex reports it.
        const ackMs = Number(process.env.MOCK_FINAL_STEER_ACK_MS) || 0
        if (ackMs) setTimeout(() => send({ id, result: { turnId: t.id } }), ackMs)
        else send({ id, result: { turnId: t.id } })
        userItem(t.id, text, params.clientUserMessageId)
        setTimeout(() => t.end('completed'), 10)
        return
      }
      if (t.kind === 'STOP_RACE_FINAL') {
        send({ id, result: { turnId: t.id } })
        return userItem(t.id, text, params.clientUserMessageId)
      }
      if (t.kind === 'SLOW_ACK') {
        userItem(t.id, text, params.clientUserMessageId)
        t.held = true
        setTimeout(() => t.end('completed'), 300)
        setTimeout(() => send({ id, result: { turnId: t.id } }), Number(process.env.MOCK_STEER_ACK_MS) || 1500)
        return
      }
      send({ id, result: { turnId: t.id } })
      return userItem(t.id, text, params.clientUserMessageId)
    }
    case 'turn/interrupt': {
      const t = turn
      send({ id, result: {} })
      if (t && t.id === params.turnId && t.kind === 'STOP_RACE_FINAL') setTimeout(() => t.end('completed'), 20)
      else if (t && t.id === params.turnId && t.kind !== 'DEAF' && t.kind !== 'HANG_DEAF') setTimeout(() => t.end('interrupted'), 20)
      return
    }
    case 'thread/backgroundTerminals/list':
      return send({ id, result: { data: [...bgTerms].map(([processId, b]) => ({ itemId: b.itemId, processId, command: b.command, cwd: '/tmp', osPid: null, cpuPercent: null, rssKb: null })), nextCursor: null } })
    case 'thread/backgroundTerminals/terminate':
      endBackground(String(params.processId), 143, 'Terminated\n')
      return send({ id, result: {} })
    default: return send({ id, error: { code: -32601, message: `method not found: ${method}` } })
  }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  if (msg.method && msg.id !== undefined) { void handle(msg); return }
  if (msg.method) { log({ kind: 'notification', method: msg.method }); return }
  const resolve = waiting.get(msg.id)
  if (resolve) { waiting.delete(msg.id); resolve(msg.result ?? {}) }
})
rl.on('close', () => process.exit(0))
