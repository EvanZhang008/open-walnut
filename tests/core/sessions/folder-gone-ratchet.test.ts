/**
 * Every path that can refuse a session's start, resume, Retry or delivery because its
 * working folder is gone records that fact (src/core/sessions/folder-gone.ts), so the
 * session panel, the message row and the toast offer to continue in a new folder.
 *
 * 2026-10-30: the server's pre-flight parked a peer's message on a gone folder, the
 * Retry button spawned into the same folder, and nothing offered a way on. Each path had
 * its own check and none said "the history is still here". This test enumerates, from the
 * source, every place a gone-folder refusal is made or a delivery failure is classified,
 * and fails when a new one appears until it is listed here with how it reports the folder.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { FOLDER_GONE_RE as SERVER_RE, isFolderGoneReason } from '../../../src/core/sessions/folder-gone-words.js'
import { FOLDER_GONE_RE as WEB_RE } from '../../../web/src/utils/folder-gone.js'
import { classifyDeliveryFailure } from '../../../src/providers/delivery-failure.js'
import { parkMeansNeverRan } from '../../../src/core/sessions/undelivered-requests.js'

const ROOT = path.resolve(import.meta.dirname, '../../..')

/** A gone-folder refusal is made, or a failure that may be one is consumed. */
const MARKERS = [
  /new CwdMissingError\(/,
  /cwd does not exist on this host/,
  /Working directory no longer exists/,
  /deps\.cwdExists\(/,
  /classifyDeliveryFailure\(/,
]

/** How each file's members report a gone folder. `records`: the file itself calls the recorder. */
const KNOWN: Record<string, { count: number; how: string; records: boolean }> = {
  'src/providers/cwd-check.ts': { count: 2, how: 'the pre-flight: makes the refusal (CwdMissingError); its callers record it', records: false },
  'src/providers/claude-code-session.ts': { count: 6, how: 'spawn catch, settleResumeFailure, processNextNow catch and the ACP drain all call noteFolderGoneOnce; the ACP drain also classifies a paused budget, which is not a folder', records: true },
  'src/providers/delivery-failure.ts': { count: 3, how: 'the classifier (its words, its definition, its permanent shorthand): reads the words as cwd_missing (permanent)', records: false },
  'src/providers/daemon-source.ts': { count: 1, how: "a daemon's start check: words the classifier reads as cwd_missing", records: false },
  'src/providers/daemon-standalone.ts': { count: 1, how: "a daemon's start check (twin of daemon-source.ts)", records: false },
  'src/core/session-auto-recover.ts': { count: 1, how: 'restart recovery: deps.noteFolderGone on the cwd_missing verdict', records: true },
  'src/core/sessions/undelivered-requests.ts': { count: 1, how: 'reads a gone-folder park as a message that never ran, so its asker is told it was not delivered', records: false },
  'src/core/session-hooks/builtins.ts': { count: 1, how: "the turn-end detector's notification names the way on (Open the session to continue it in a new folder)", records: false },
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(p)
    else if (/\.(ts|tsx|mjs|cjs)$/.test(entry.name)) yield p
  }
}

/** Code lines only: a comment that names the words is not a path. */
function codeLines(text: string): string[] {
  return text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
}

describe('every gone-folder refusal is recorded', () => {
  it('the source has exactly the known members, each reporting the folder', () => {
    const found: Record<string, number> = {}
    for (const file of sourceFiles(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, file)
      if (rel.startsWith('src/core/sessions/folder-gone')) continue
      const n = codeLines(fs.readFileSync(file, 'utf8')).filter((l) => MARKERS.some((m) => m.test(l))).length
      if (n > 0) found[rel] = n
    }
    const unknown = Object.keys(found).filter((f) => !KNOWN[f])
    expect(unknown, `a new path can fail on a gone folder: make it record the folder (noteFolderGone in src/core/sessions/folder-gone.ts) and list it here: ${unknown.join(', ')}`).toEqual([])
    for (const [file, known] of Object.entries(KNOWN)) {
      expect(found[file] ?? 0, `${file}: ${known.how}. The count changed: check the new member records the gone folder, then update this list`).toBe(known.count)
      if (known.records) expect(fs.readFileSync(path.join(ROOT, file), 'utf8')).toMatch(/noteFolderGone/)
    }
  })

  it('the session controls that would spawn into a gone folder ask first', () => {
    const lifecycle = fs.readFileSync(path.join(ROOT, 'src/core/sessions/session-lifecycle.ts'), 'utf8')
    // Retry (both of its spawning branches) and Restart.
    expect(lifecycle.match(/folderGoneForRetry\(sessionId, record\)/g)?.length).toBe(2)
    expect(lifecycle).toMatch(/restartSession[\s\S]*noteFolderGone\(sessionId\)[\s\S]*code: 'folder_gone'/)
  })

  it('the server, the web copy, the classifier and the never-ran test read the same words', () => {
    expect(WEB_RE.source).toBe(SERVER_RE.source)
    expect(WEB_RE.flags).toBe(SERVER_RE.flags)
    const reasons = [
      'Working directory no longer exists: /Users/me/notes/Projects/garden',
      'Working directory no longer exists on devbox: /home/me/gone',
      'start: cwd does not exist on this host (devbox): /home/me/gone',
    ]
    for (const r of reasons) {
      expect(isFolderGoneReason(r)).toBe(true)
      expect(classifyDeliveryFailure(new Error(r))).toMatchObject({ kind: 'permanent', code: 'cwd_missing' })
      expect(parkMeansNeverRan(r)).toBe(true)
    }
    // Not set is a different problem: no folder to be gone.
    expect(isFolderGoneReason('Working directory not set')).toBe(false)
  })
})
