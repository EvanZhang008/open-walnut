/**
 * L1 tests for the session-bound watcher lifecycle refactor.
 *
 * Background: the daemon's JSONL file tailer used to be stored as a
 * Map<ws, watcher> on each session, which bound its lifetime to a single
 * WebSocket connection. When the ws dropped (SSH tunnel flap, network
 * blip), the watcher was destroyed and the daemon stopped pushing JSONL
 * events to walnut. Walnut's auto-reconnect restored the ws but did not
 * rebuild the watcher, so sessions went "deaf" for the rest of their
 * lifetime — producing the user-reported "UI stuck at 'Walnut is
 * working...', refresh to recover" bug (observed session 9bef7be5,
 * 25-minute watcher gap on 2026-04-29).
 *
 * Fix: split the watcher from the ws. Each session has exactly one
 * watcher (`session.watcher`) whose lifecycle equals the session process
 * lifecycle. WebSockets are just `session.subscribers: Set<ws>` entries —
 * joining on cmdAttach/cmdStart, leaving on ws.close. The watcher never
 * dies because a ws drops.
 *
 * These tests verify the invariant at the source level (grep assertions).
 * Behavior-level tests of the invariant live in the live E2E suite
 * (tests/e2e/daemon*.live.test.ts), where we can actually drop the
 * WebSocket and assert zero byte loss on the other side.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const standalonePath = path.join(ROOT, 'src/providers/daemon-standalone.ts')

function readFile(p: string) { return fs.readFileSync(p, 'utf-8') }

describe('L1 daemon watcher lifecycle: session-bound, not ws-bound', () => {
  const standaloneSrc = readFile(standalonePath)

  describe('Data structure — session has ONE watcher + a Set of subscribers', () => {
    // subscribers is a Subscribers: a Set that remembers when it was last watched (daemon-idle-scan-watched.test.ts).

    it('SessionData has session.watcher (object or null) and session.subscribers (Set)', () => {
      expect(standaloneSrc).not.toMatch(/watchers:\s*new\s+Map\(\)/)
      expect(standaloneSrc).toMatch(/watcher:\s*null/)
      expect(standaloneSrc).toMatch(/subscribers:\s*new\s+Subscribers\(\)/)
      expect(standaloneSrc).toMatch(/class Subscribers<T> extends Set<T>/)
    })
  })

  describe('ws.on("close") removes subscriber but does NOT touch watcher', () => {

    it('handleDisconnect removes ws from subscribers, not the watcher', () => {
      const handler = standaloneSrc.match(/function\s+handleDisconnect[\s\S]*?\n\}/)
      expect(handler).toBeTruthy()
      if (handler) {
        const body = handler[0]
        expect(body).toMatch(/subscribers\.delete\(ws\)/)
        expect(body).not.toMatch(/stopWatching\(ws,\s*sid\)/)
      }
    })
  })

  describe('ensureWatcher is idempotent + session-bound', () => {

    it('ensureWatcher guards on existing watcher to avoid duplicates', () => {
      const fn = standaloneSrc.match(/function\s+ensureWatcher\([\s\S]*?\n\}/)
      expect(fn).toBeTruthy()
      if (fn) {
        const body = fn[0]
        expect(body).toMatch(/if\s*\(\s*session\.watcher\s*\)\s*return/)
        expect(body).toMatch(/for\s*\(\s*const\s+ws\s+of\s+s\.subscribers\s*\)/)
      }
    })
  })

  describe('addSubscriber is the single entry to cmdStart/cmdAttach push setup', () => {

    it('cmdStart and cmdAttach both use addSubscriber', () => {
      expect(standaloneSrc).not.toMatch(/function\s+startWatching\b/)
      // Two call sites (start + attach)
      const matches = standaloneSrc.match(/addSubscriber\(ws,\s*sid,/g) || []
      expect(matches.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('reapSession closes watcher + notifies all subscribers', () => {

    it('broadcastExitToWatchersFn iterates subscribers + closes watcher', () => {
      const fnBlock = standaloneSrc.match(/broadcastExitToWatchersFn:\s*\([\s\S]*?\},/)
      expect(fnBlock).toBeTruthy()
      if (fnBlock) {
        const body = fnBlock[0]
        expect(body).toMatch(/for\s*\(\s*const\s+client\s+of\s+session\.subscribers\s*\)/)
        expect(body).toMatch(/stopSessionWatcher\(/)
      }
    })
  })

  describe('Idle scan skips sessions with active subscribers', () => {

    it('idle scan short-circuits when subscribers.size > 0', () => {
      expect(standaloneSrc).toMatch(/if\s*\(\s*session\.subscribers\.size\s*>\s*0\s*\)\s*continue/)
      expect(standaloneSrc).not.toMatch(/session\.watchers\.size\s*>\s*0/)
    })
  })

  describe('Catch-up push on attach — reconnecting client sees no gap', () => {

    it('addSubscriber replays bytes [fromOffset, currentOffset)', () => {
      const fn = standaloneSrc.match(/function\s+addSubscriber\([\s\S]*?\n\}/)
      expect(fn).toBeTruthy()
      if (fn) {
        const body = fn[0]
        expect(body).toMatch(/start\s*<\s*currentOffset/)
        expect(body).toMatch(/const readFrom = capped \? currentOffset - REPLAY_BACKFILL_MAX_BYTES - 1 : start/)
        expect(body).toMatch(/fs\.readSync\(fd,\s*buf,\s*0,\s*buf\.length,\s*readFrom\)/)
        expect(body).toMatch(/sendEvent\(ws,\s*'jsonl'/)
      }
    })
  })

  describe('cmdRename recreates the watcher (closure captures new sid)', () => {
    // Regression: the pollTimer closure captures `sid` by value. When cmdRename
    // re-keys sessions map (delete oldSid + set newSid), the old watcher's
    // sessions.get(oldSid) returns undefined every tick and silently stops
    // fanning out jsonl lines. Fix: cmdRename must stopSessionWatcher(oldSid)
    // before re-keying and ensureWatcher(newSid) after. Observed bug: remote
    // sessions went deaf the moment Claude emitted its real session_id.
    it('cmdRename stops old watcher and re-creates one for newSid', () => {
      const fn = standaloneSrc.match(/function\s+cmdRename\([\s\S]*?\n\}/)
      expect(fn).toBeTruthy()
      if (fn) {
        const body = fn[0]
        expect(body).toMatch(/stopSessionWatcher\(oldSid\)/)
        expect(body).toMatch(/ensureWatcher\(newSid\)/)
      }
    })

    // Without this, ensureWatcher() after rename re-streams the whole file
    // from byte 0 (the UUID dedup layer in walnut catches the dup, but it's
    // wasteful and masks real gaps).
    it('stopSessionWatcher saves watcher.offset back to session.offset', () => {
      const fn = standaloneSrc.match(/function\s+stopSessionWatcher\([\s\S]*?\n\}/)
      expect(fn).toBeTruthy()
      if (fn) {
        expect(fn[0]).toMatch(/session\.offset\s*=\s*session\.watcher\.offset/)
      }
    })
  })

  describe('Dead-subscriber garbage collection in poll loop', () => {
    it('poll loop drops ws from subscribers when ws.readyState !== OPEN', () => {
      const ensureFn = standaloneSrc.match(/function\s+ensureWatcher\([\s\S]*?\n\}/)
      expect(ensureFn).toBeTruthy()
      if (ensureFn) {
        expect(ensureFn[0]).toMatch(/s\.subscribers\.delete\(ws\)/)
      }
    })
  })
})
