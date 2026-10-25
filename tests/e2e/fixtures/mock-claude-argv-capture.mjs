#!/usr/bin/env node
// Records the argv a session spawn passed (one JSON file per process in
// MOCK_CLAUDE_ARGV_DIR), then runs the shared mock CLI unchanged. Lets a test
// read the exact --append-system-prompt the engine received.
import fs from 'node:fs'
import path from 'node:path'

const dir = process.env.MOCK_CLAUDE_ARGV_DIR
if (dir) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify(process.argv.slice(2)))
}
await import('../../providers/mock-claude.mjs')
