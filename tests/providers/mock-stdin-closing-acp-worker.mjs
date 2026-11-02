#!/usr/bin/env node
// A scripted ACP worker whose reader goes away mid-RPC: it answers the start
// (initialize, newSession, getState), then on `stall` stops reading its stdin
// and, MOCK_CLOSING_WORKER_EXIT_MS later (default 400), exits without answering.
// MOCK_CLOSING_WORKER_CLOSE_STDIN=1 also closes fd 0 at the stall, so the worker
// lives on with no reader on its stdin. A request the daemon is still writing
// into the full pipe then fails with EPIPE, the way it does for a worker that an
// interrupt is tearing down (tests/providers/acp-daemon-stdin-epipe.test.ts).

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const journalIndex = process.argv.indexOf('--journal')
const journalPath = process.argv[journalIndex + 1]
fs.mkdirSync(path.dirname(journalPath), { recursive: true })
if (!fs.existsSync(journalPath)) fs.writeFileSync(journalPath, '')

function reply(id, result) {
  process.stdout.write(JSON.stringify({ id, ok: true, result }) + '\n')
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const request = JSON.parse(line)
  switch (request.op) {
    case 'initialize':
      reply(request.id, {})
      break
    case 'newSession':
      reply(request.id, { sessionId: 'closing-provider-session' })
      break
    case 'getState':
      reply(request.id, {
        providerSessionId: 'closing-provider-session',
        turnActive: false,
        controlActive: false,
        pendingPermissions: [],
        capabilities: {},
      })
      break
    case 'stall':
      // Stop reading: everything written after this stays in the pipe.
      rl.close()
      process.stdin.pause()
      if (process.env.MOCK_CLOSING_WORKER_CLOSE_STDIN === '1') {
        process.stdin.destroy()
        try { fs.closeSync(0) } catch { /* already closed by destroy() */ }
      }
      setTimeout(() => process.exit(0), Number(process.env.MOCK_CLOSING_WORKER_EXIT_MS ?? 400))
      break
    default:
      reply(request.id, {})
  }
})
