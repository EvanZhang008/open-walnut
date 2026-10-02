/**
 * The `claude` this worker's sessions run: the repo's mock CLI.
 *
 * Loaded inside every vitest worker before any test module (imported by
 * runtime-dir-isolation.ts). Names the stand-in in WALNUT_TEST_CLAUDE_BIN, which
 * src/core/test-claude-guard.ts hands to every daemon the test did not start
 * itself, in place of `claude`.
 *
 * What it protects (2026-10-02)
 * -----------------------------
 * The daemon finds `claude` the way the user's terminal does (the login-shell
 * PATH, then `$SHELL -c "<source rc>; exec claude"`), so a test whose server
 * started a session on its own local daemon ran the user's REAL CLI on a dev
 * machine (a model turn with the user's credentials and tools) and failed with
 * "claude not found" in CI. setCliCommand(MOCK_CLI) never reached that spawn.
 *
 * The stand-in is a tiny sh script (`exec <node> mock-claude.mjs "$@"`), named
 * `claude` so the daemon's checks see the CLI's name. Its directory is keyed by
 * the script's content, so workers share it and a changed node or repo path
 * gets a new one; it is rewritten whenever it is missing (the /tmp janitor).
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

if (!process.env.WALNUT_TEST_CLAUDE_BIN) {
  const script = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(MOCK_CLI)} "$@"\n`
  const key = crypto.createHash('sha256').update(script).digest('hex').slice(0, 16)
  const dir = path.join(os.tmpdir(), 'open-walnut-test-claude', key)
  const bin = path.join(dir, 'claude')
  let current = ''
  try { current = fs.readFileSync(bin, 'utf8') } catch { /* not written yet */ }
  if (current !== script) {
    fs.mkdirSync(dir, { recursive: true })
    // Written aside and renamed, so a concurrent worker never runs half a script.
    const tmp = `${bin}.${process.pid}.tmp`
    fs.writeFileSync(tmp, script, { mode: 0o755 })
    fs.renameSync(tmp, bin)
  }
  process.env.WALNUT_TEST_CLAUDE_BIN = bin
}
