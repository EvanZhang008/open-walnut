/**
 * Ratchet: code a dependency patch adds never keeps a file in the OS temp dir.
 *
 * 2026-11-10: the codex-acp patch wrote Codex's model catalog to os.tmpdir() and handed its
 * path to the long-lived app-server, which rereads it on every turn. macOS purged the file
 * from its per-user temp dir, and every Codex turn on the Mac then failed with "failed to load
 * configuration: No such file or directory". A patched package runs inside an engine's
 * process, so a file it writes must outlive the session: a state dir, not the temp dir.
 * A new use fails here until it is moved, or listed below with why it is only read at once.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const PATCHES = path.join(import.meta.dirname, '../../patches')
/** `<patch file>: <added line, trimmed>` uses that only ever read the file at once. */
const ALLOWED: Record<string, string> = {}

describe('dependency patches keep no file in the OS temp dir', () => {
  it('every added line naming tmpdir() is listed with its reason', () => {
    const found: string[] = []
    for (const name of fs.readdirSync(PATCHES).filter((f) => f.endsWith('.patch'))) {
      for (const line of fs.readFileSync(path.join(PATCHES, name), 'utf8').split('\n')) {
        if (!line.startsWith('+') || line.startsWith('+++')) continue
        if (/\btmpdir\s*\(|TMPDIR|\/tmp\//.test(line)) found.push(`${name}: ${line.slice(1).trim()}`)
      }
    }
    expect(found.filter((f) => !(f in ALLOWED))).toEqual([])
  })
})
