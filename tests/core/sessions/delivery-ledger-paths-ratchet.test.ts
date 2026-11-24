/**
 * Every way a message gets into a session leaves its row in the delivery ledger
 * (src/core/sessions/delivery-ledger.ts).
 *
 * 2026-11-24 daily audit: two of the user's messages that reached their task had no row (each was
 * a task's first message, carried by the session's start, which never was a queue row), a raw
 * enqueue (a send held behind a permission prompt, a letter's answer) emitted no event the ledger
 * read, and a Threads reply its task read there stayed `queued` for 20 hours.
 *
 * The ways in, enumerated from the source, each recorded where it cannot be skipped:
 *  - a queue row: minted only by enqueueMessage (the one `nextEnqueueSeq()` call), which records it;
 *  - a session's first line: every start entry runs prepareStartHints, and each one wraps it in
 *    withStartLine, which records the line once the start has its session id; the runner is the
 *    only consumer of SESSION_START;
 *  - a SESSION_MESSAGE_QUEUED that no queue stored here (a host's forwarded fact, an embedded send):
 *    recorded from the event; every emitter is listed below with which it is;
 *  - a Threads reply read by pull: its row reads `read` (org/thread-reply.ts).
 * A new way in fails here until it records its row.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8')

/** `file:line: text` of every match of an ERE in src/ (comments included; each site is checked by hand below). */
function sites(pattern: string): Array<{ file: string; line: number; text: string }> {
  let out = ''
  try {
    out = execFileSync('git', ['grep', '-nE', pattern, '--', 'src/'], { cwd: ROOT, encoding: 'utf-8' })
  } catch (err) {
    if ((err as { status?: number }).status === 1) return []
    throw err
  }
  return out.split('\n').filter(Boolean).map((l) => {
    const m = /^([^:]+):(\d+):(.*)$/.exec(l)!
    return { file: m[1]!, line: Number(m[2]), text: m[3]! }
  }).filter((s) => !/^\s*(\/\/|\*|\/\*)/.test(s.text))
}

/** SESSION_MESSAGE_QUEUED emitters: `ledgered` (its queue recorded the row) or `event` (recorded from the event). */
const QUEUED_EMITTERS: Record<string, 'ledgered' | 'event'> = {
  'src/core/session-message-queue.ts': 'ledgered', // sendMessageToSession, after enqueueMessage stored the row
  'src/providers/claude-code-session.ts': 'ledgered', // an ACP start's first line, enqueued just before
  'src/web/routes/session-chat.ts': 'event', // an embedded session's send: no queue holds it
}

describe('every way into a session records its row in the delivery ledger', () => {
  it('a queue row is minted only by enqueueMessage, which records it once stored', () => {
    const minted = sites('nextEnqueueSeq\\(\\)').filter((s) => !s.text.includes('export function nextEnqueueSeq'))
    expect(minted.map((s) => s.file)).toEqual(['src/core/session-message-queue.ts'])
    const queue = read('src/core/session-message-queue.ts')
    const body = queue.slice(queue.indexOf('export async function enqueueMessage('), queue.indexOf('type EnqueueOutcome ='))
    expect(body).toContain('seq: nextEnqueueSeq()')
    // After the dedupe and the once-only returns (a row stored anew), never before them.
    expect(body).toMatch(/return outcome\.existing;[\s\S]*void recordQueuedRow\(\{ id: msg\.id, sessionId/)
  })

  it('every start entry wraps its start in withStartLine, and the runner is the only SESSION_START consumer', () => {
    const entries = sites('prepareStartHints\\(').filter((s) => s.file !== 'src/core/hints/hint-send.ts')
    // The host port only passes the call through to the local one (session-channel/host-port.ts).
    const starts = entries.filter((s) => s.file !== 'src/core/session-channel/host-port.ts')
    expect(starts.length).toBeGreaterThanOrEqual(2)
    for (const s of starts) expect(s.text, `${s.file}:${s.line} starts a session without withStartLine`).toMatch(/withStartLine\(await prepareStartHints\(/)
    expect(sites('case EventNames\\.SESSION_START:').map((s) => s.file)).toEqual(['src/providers/claude-code-session.ts'])
  })

  it('every SESSION_MESSAGE_QUEUED emitter is listed: its queue recorded the row, or the event is recorded', () => {
    const emitters = sites('bus\\.emit\\(EventNames\\.SESSION_MESSAGE_QUEUED')
    const files = [...new Set(emitters.map((s) => s.file))].sort()
    expect(files, 'a new SESSION_MESSAGE_QUEUED emitter: list it in QUEUED_EMITTERS').toEqual(Object.keys(QUEUED_EMITTERS).sort())
    for (const s of emitters) {
      const after = read(s.file).split('\n').slice(s.line - 1, s.line + 12).join('\n')
      if (QUEUED_EMITTERS[s.file] === 'ledgered') expect(after, `${s.file}:${s.line}`).toMatch(/ledgered: true/)
      else expect(after, `${s.file}:${s.line}`).not.toMatch(/ledgered: true/)
    }
  })

  it('a Threads reply its task read there is read in the ledger', () => {
    const reply = read('src/core/org/thread-reply.ts')
    const body = reply.slice(reply.indexOf('export async function repliesReadByOwner('))
    expect(body).toMatch(/recordDelivery\(\{\s*step: 'read', ids: \[qm\], via: 'threads', taskId: owner/)
  })
})
