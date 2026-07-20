#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const journalIndex = process.argv.indexOf('--journal')
const journalPath = process.argv[journalIndex + 1]
fs.mkdirSync(path.dirname(journalPath), { recursive: true })
if (!fs.existsSync(journalPath)) fs.writeFileSync(journalPath, '')
let activeCommandId = null

function reply(id, result) {
  process.stdout.write(JSON.stringify({ id, ok: true, result }) + '\n')
}

function append(event) {
  fs.appendFileSync(journalPath, JSON.stringify({ kind: 'meta', ts: Date.now(), event }) + '\n')
  process.stdout.write(JSON.stringify({ ev: 'journal', offset: fs.statSync(journalPath).size }) + '\n')
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line)
  switch (request.op) {
    case 'initialize':
      reply(request.id, {})
      break
    case 'newSession':
      append({ type: 'session-created', providerSessionId: 'hung-provider-session' })
      reply(request.id, { sessionId: 'hung-provider-session' })
      break
    case 'getState':
      reply(request.id, {
        providerSessionId: 'hung-provider-session',
        turnActive: true,
        controlActive: false,
        pendingPermissions: [],
        capabilities: {},
      })
      break
    case 'prompt': {
      const params = request.params
      activeCommandId = params.commandId
      append({
        type: 'prompt-intent',
        commandId: params.commandId,
        walnutMessageId: params.walnutMessageId,
        text: params.text,
      })
      append({ type: 'prompt-dispatched', commandId: params.commandId })
      append({
        type: 'prompt-accepted',
        commandId: params.commandId,
        walnutMessageId: params.walnutMessageId,
        text: params.text,
      })
      append({ type: 'turn-started', commandId: params.commandId })
      reply(request.id, { accepted: true })
      break
    }
    case 'cancel':
      // Deliberately never respond. The daemon must leave this RPC timeout
      // quickly and continue to process-group termination.
      break
    case 'shutdown':
      reply(request.id, { shutdown: true })
      process.exit(0)
      break
  }
})

if (process.env.MOCK_TERMINAL_ON_SIGTERM === '1') {
  process.on('SIGTERM', () => {
    if (activeCommandId) {
      fs.appendFileSync(journalPath, JSON.stringify({
        kind: 'meta',
        ts: Date.now(),
        event: {
          type: 'turn-ended',
          commandId: activeCommandId,
          stopReason: 'cancelled',
        },
      }) + '\n')
    }
    process.exit(0)
  })
}
