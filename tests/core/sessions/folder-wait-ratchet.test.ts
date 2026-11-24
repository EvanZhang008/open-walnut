/**
 * A message parked because its session's folder was gone is sent once the folder is back, whichever
 * way it came back (src/core/sessions/folder-wait.ts). 2026-11-24: a host's rows parked on a
 * released workspace stayed parked for hours after the workspace was made again, because only the
 * one remake path that asked the host sent them; every other way back (Continue in a new folder, a
 * restored task directory, a folder made again by hand, a host restart, the CLI simply resuming in
 * that folder) left them behind.
 *
 * The release therefore sits where every way back ends, not on each way back:
 *  1. every delivery take (a row leaves the queue for a CLI) is preceded by unparkRowsAhead, so the
 *     rows that waited on the folder ride ahead of the row going out. A new take fails here until it
 *     calls it or is listed with why it needs none;
 *  2. every way a folder comes back (or a session moves to another one) is listed with the release
 *     that covers it. A new caller of one of those fails here until it is listed;
 *  3. only a person's press releases rows Walnut did not mark: `pick: 'all'` comes from one place.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../..')

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(p)
    else if (/\.(ts|tsx|mjs)$/.test(entry.name)) yield p
  }
}

const codeLines = (text: string) => text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))

function callsOf(re: RegExp, defs: RegExp): Record<string, number> {
  const found: Record<string, number> = {}
  for (const file of sourceFiles(path.join(ROOT, 'src'))) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/')
    const n = codeLines(fs.readFileSync(file, 'utf8')).filter((l) => re.test(l) && !defs.test(l)).length
    if (n > 0) found[rel] = n
  }
  return found
}

/** A row leaves the queue for a CLI (or for the host that runs the CLI). */
const TAKE = /\b(markProcessing|markNextProcessing|takeLinesForHost)\(/
const TAKE_DEF = /function (markProcessing|markNextProcessing|takeLinesForHost)\b/

/** Each file's takes, and how the rows that waited on the folder ride ahead of each. */
const TAKES: Record<string, { count: number; how: string }> = {
  'src/providers/claude-code-session.ts': { count: 4, how: 'processNextNow and the mid-turn write call unparkRowsAhead right before markProcessing; drainAcpQueue calls it before the ACP drain and the steer (both markNextProcessing)' },
  'src/providers/host-judged-send.ts': { count: 1, how: 'deliver calls unparkRowsAhead before takeLinesForHost when the send wakes the CLI' },
  'src/providers/host-resume.ts': { count: 1, how: 'takes by id the lines it peeked after unparkWaiting (the runner\'s unparkRowsAhead)' },
}

/** A folder made again, or a session or task pointed at a folder. */
const RETURN = /\b(remakeForGoneFolder|restoreOwnTaskDir|ensureTaskDirOnHost|adoptNewCwd|continueInNewFolder|moveTaskCwd)\(/
const RETURN_DEF = /function (remakeForGoneFolder|restoreOwnTaskDir|ensureTaskDirOnHost|adoptNewCwd|continueInNewFolder|moveTaskCwd)\b/

const RIDES = 'the next delivery takes the waiting rows with it (unparkRowsAhead), and the delivery clock sends them once the folder is there (folderIsBackFor)'
/** Each file's ways back, and what releases the rows that waited when one ends. */
const RETURNS: Record<string, { count: number; how: string }> = {
  'src/providers/claude-code-session.ts': { count: 1, how: `adoptNewCwd's definition site is a method; ${RIDES}` },
  'src/providers/session-folder-prep.ts': { count: 2, how: `a spawn's own preparation: the delivery it prepares is a take; ${RIDES}` },
  'src/web/routes/sessions.ts': { count: 1, how: "the person's button: continueInNewFolder sends every row on the folder (pick 'all')" },
  'src/web/routes/api-v1.ts': { count: 1, how: `makes the caller's own task directory; ${RIDES}` },
  'src/core/sessions/start-placement.ts': { count: 2, how: `a start's folder: a new session has no row parked on it; ${RIDES}` },
  'src/core/sessions/task-dir-place.ts': { count: 2, how: `restores or makes the task directory; ${RIDES}` },
  'src/core/sessions/engine-switch.ts': { count: 1, how: `a new session's folder; ${RIDES}` },
  'src/core/sessions/quick-start.ts': { count: 3, how: `a start's folder; ${RIDES}` },
  'src/core/sessions/task-start.ts': { count: 2, how: `a start's folder; ${RIDES}` },
  'src/core/sessions/folder-gone.ts': { count: 5, how: 'the button itself: it sends what waited (folderIsBack / sendWaiting), with the pick of who pressed it' },
  'src/core/sessions/org-own-folder.ts': { count: 1, how: `a VP's move into its own folder; ${RIDES}` },
  'src/core/transfer/task-work.ts': { count: 1, how: `a task moved to another host starts there; ${RIDES}` },
  'src/core/workspaces/remake.ts': { count: 2, how: "a remake's end calls continueInNewFolder as Walnut (pick 'waited'); kickRemake's remake ends there too" },
  'src/core/hosts/host-mcp-images.ts': { count: 1, how: 'a folder for images, no session moves; nothing waits on it' },
}

describe('a message that waited on a gone folder goes once the folder is back, whichever way', () => {
  it('every delivery take lets the rows that waited on the folder ride ahead', () => {
    const found = callsOf(TAKE, TAKE_DEF)
    expect(found, 'a new delivery take must call unparkRowsAhead first (core/session-queue-park.ts), or be listed here with why it needs none').toEqual(
      Object.fromEntries(Object.entries(TAKES).map(([f, k]) => [f, k.count])),
    )
    for (const file of Object.keys(TAKES)) {
      if (file === 'src/providers/host-resume.ts') continue
      expect(fs.readFileSync(path.join(ROOT, file), 'utf8'), file).toMatch(/unparkRowsAhead\(/)
    }
    expect(fs.readFileSync(path.join(ROOT, 'src/providers/host-resume.ts'), 'utf8')).toMatch(/unparkWaiting\(sid\)/)
    expect(fs.readFileSync(path.join(ROOT, 'src/providers/claude-code-session.ts'), 'utf8')).toMatch(/unparkWaiting: \(sid\) => unparkRowsAhead\(sid, stopFence\)/)
  })

  it('every way a folder comes back is listed with the release that covers it', () => {
    const found = callsOf(RETURN, RETURN_DEF)
    expect(found, 'a new way a folder comes back (or a session moves) must be listed here with what sends the rows that waited').toEqual(
      Object.fromEntries(Object.entries(RETURNS).map(([f, k]) => [f, k.count])),
    )
  })

  it("only a person's press sends rows Walnut did not mark", () => {
    const all: string[] = []
    for (const file of sourceFiles(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/')
      codeLines(fs.readFileSync(file, 'utf8')).forEach((l) => { if (/'all'/.test(l) && /pick|FolderWaitPick/.test(l)) all.push(rel) })
    }
    // folder-gone.ts derives it from who pressed (and passes a host's own 'all' on); folder-wait.ts
    // defines the type and reads it.
    expect([...new Set(all)].sort()).toEqual(['src/core/sessions/folder-gone.ts', 'src/core/sessions/folder-wait.ts'])
    const gone = fs.readFileSync(path.join(ROOT, 'src/core/sessions/folder-gone.ts'), 'utf8')
    expect(gone).toMatch(/const pick: FolderWaitPick = by\.startsWith\('walnut:'\) \? 'waited' : 'all'/)
  })
})
