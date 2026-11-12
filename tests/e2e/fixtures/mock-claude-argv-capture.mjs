#!/usr/bin/env node
// Records the argv a session spawn passed (one JSON file per process in
// MOCK_CLAUDE_ARGV_DIR), then runs the shared mock CLI unchanged. Lets a test
// read the exact --append-system-prompt the engine received. The daemons hand
// the CLI its prompts as files (cli-argv-files-core.ts: --append-system-prompt-file,
// --system-prompt-file), so those are recorded as the inline flag with the file's
// text: what the engine reads either way.
import fs from 'node:fs'
import path from 'node:path'

const FROM_FILE = { '--append-system-prompt-file': '--append-system-prompt', '--system-prompt-file': '--system-prompt' }

const dir = process.env.MOCK_CLAUDE_ARGV_DIR
if (dir) {
  const argv = process.argv.slice(2)
  const seen = []
  for (let i = 0; i < argv.length; i++) {
    const inline = FROM_FILE[argv[i]]
    if (inline && i + 1 < argv.length) {
      let text = null
      try { text = fs.readFileSync(argv[i + 1], 'utf8') } catch { /* keep the flag as given */ }
      if (text !== null) { seen.push(inline, text); i++; continue }
    }
    seen.push(argv[i])
  }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify(seen))
}
await import('../../providers/mock-claude.mjs')
