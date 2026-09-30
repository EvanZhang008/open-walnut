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
 * These tests verify the invariant at the source level (grep assertions),
 * mirroring the existing daemon-standalone-vs-source-parity.test.ts style.
 * Behavior-level tests of the invariant live in the live E2E suite
 * (tests/e2e/daemon-live-*.test.ts), where we can actually drop the
 * WebSocket and assert zero byte loss on the other side.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const sourcePath = path.join(ROOT, 'src/providers/daemon-source.ts')
const standalonePath = path.join(ROOT, 'src/providers/daemon-standalone.ts')

function readFile(p: string) { return fs.readFileSync(p, 'utf-8') }

describe('L1 daemon watcher lifecycle: session-bound, not ws-bound', () => {
  const sourceSrc = readFile(sourcePath)
  const standaloneSrc = readFile(standalonePath)

  describe('Data structure — session has ONE watcher + a Set of subscribers', () => {
    it('source: SessionData has session.watcher (object or null) and session.subscribers (Set)', () => {
      // Must NOT have the old Map<ws, watcher> pattern.
      expect(sourceSrc).not.toMatch(/watchers:\s*new\s+Map\(\)/)
      // Must have the new pair.
      expect(sourceSrc).toMatch(/watcher:\s*null/)
      expect(sourceSrc).toMatch(/subscribers:\s*new\s+Set\(\)/)
    })

    it('standalone: SessionData has session.watcher (object or null) and session.subscribers (Set)', () => {
      expect(standaloneSrc).not.toMatch(/watchers:\s*new\s+Map\(\)/)
      expect(standaloneSrc).toMatch(/watcher:\s*null/)
      expect(standaloneSrc).toMatch(/subscribers:\s*new\s+Set\(\)/)
    })
  })

  describe('ws.on("close") removes subscriber but does NOT touch watcher', () => {
    it('source: close handler calls session.subscribers.delete(ws), not stopWatching', () => {
      // Locate the close handler and verify contents.
      const closeBlock = sourceSrc.match(/ws\.on\('close',\s*\(\)\s*=>\s*\{[\s\S]*?logMsg\('info',\s*'client disconnected'/)
      expect(closeBlock, 'ws.on("close") block should exist').toBeTruthy()
      if (closeBlock) {
        const body = closeBlock[0]
        expect(body).toMatch(/subscribers\.delete\(ws\)/)
        // Must NOT call the removed stopWatching(ws, sid) helper.
        expect(body).not.toMatch(/stopWatching\(ws,\s*sid\)/)
      }
    })

    it('standalone: handleDisconnect removes ws from subscribers, not the watcher', () => {
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
    it('source: ensureWatcher guards on existing watcher to avoid duplicates', () => {
      const fn = sourceSrc.match(/function\s+ensureWatcher\([\s\S]*?\n\}/)
      expect(fn, 'ensureWatcher function must exist').toBeTruthy()
      if (fn) {
        const body = fn[0]
        // Guard: if already running, return without work.
        expect(body).toMatch(/if\s*\(\s*session\.watcher\s*\)\s*return/)
        // Fan out to all subscribers, not a single ws.
        expect(body).toMatch(/for\s*\(\s*const\s+ws\s+of\s+s\.subscribers\s*\)/)
      }
    })

    it('standalone: ensureWatcher guards on existing watcher to avoid duplicates', () => {
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
    it('source: cmdStart calls addSubscriber (not startWatching) after spawn', () => {
      // The legacy startWatching helper must be gone.
      expect(sourceSrc).not.toMatch(/function\s+startWatching\b/)
      // cmdStart must now use addSubscriber.
      const cmdStart = sourceSrc.match(/function\s+cmdStart\([\s\S]*?\n\}/)
      expect(cmdStart).toBeTruthy()
      if (cmdStart) {
        expect(cmdStart[0]).toMatch(/addSubscriber\(ws,\s*sid,/)
      }
    })

    it('source: cmdAttach calls addSubscriber (not startWatching)', () => {
      const cmdAttach = sourceSrc.match(/function\s+cmdAttach\([\s\S]*?\n\}\n/)
      expect(cmdAttach).toBeTruthy()
      if (cmdAttach) {
        expect(cmdAttach[0]).toMatch(/addSubscriber\(ws,\s*sid,/)
      }
    })

    it('standalone: cmdStart and cmdAttach both use addSubscriber', () => {
      expect(standaloneSrc).not.toMatch(/function\s+startWatching\b/)
      // Two call sites (start + attach)
      const matches = standaloneSrc.match(/addSubscriber\(ws,\s*sid,/g) || []
      expect(matches.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('reapSession closes watcher + notifies all subscribers', () => {
    it('source: reapSession iterates subscribers (not watchers.keys) for exit fan-out', () => {
      // Find the reapSession body and verify it fans to subscribers, not watchers.
      const reap = sourceSrc.match(/function\s+reapSession\([\s\S]*?broadcastSessionState\(sid,\s*'dead'/)
      expect(reap).toBeTruthy()
      if (reap) {
        const body = reap[0]
        expect(body).toMatch(/for\s*\(\s*const\s+client\s+of\s+session\.subscribers\s*\)/)
        // Must close the session-bound watcher.
        expect(body).toMatch(/stopSessionWatcher\(sid\)/)
      }
    })

    it('standalone: broadcastExitToWatchersFn iterates subscribers + closes watcher', () => {
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
    it('source: idle scan short-circuits when subscribers.size > 0', () => {
      expect(sourceSrc).toMatch(/if\s*\(\s*session\.subscribers\.size\s*>\s*0\s*\)\s*continue/)
      // Old path (watchers.size) must be gone.
      expect(sourceSrc).not.toMatch(/session\.watchers\.size\s*>\s*0/)
    })

    it('standalone: idle scan short-circuits when subscribers.size > 0', () => {
      expect(standaloneSrc).toMatch(/if\s*\(\s*session\.subscribers\.size\s*>\s*0\s*\)\s*continue/)
      expect(standaloneSrc).not.toMatch(/session\.watchers\.size\s*>\s*0/)
    })
  })

  describe('Catch-up push on attach — reconnecting client sees no gap', () => {
    it('source: addSubscriber replays bytes [fromOffset, currentOffset)', () => {
      const fn = sourceSrc.match(/function\s+addSubscriber\([\s\S]*?\n\}/)
      expect(fn).toBeTruthy()
      if (fn) {
        const body = fn[0]
        // Read bytes from fromOffset (or the capped window's start) to the
        // watcher's current offset and push.
        expect(body).toMatch(/start\s*<\s*currentOffset/)
        expect(body).toMatch(/const readFrom = capped \? currentOffset - REPLAY_BACKFILL_MAX_BYTES - 1 : start/)
        expect(body).toMatch(/fs\.readSync\(fd,\s*buf,\s*0,\s*buf\.length,\s*readFrom\)/)
        expect(body).toMatch(/sendEvent\(ws,\s*'jsonl'/)
      }
    })

    it('standalone: addSubscriber replays bytes [fromOffset, currentOffset)', () => {
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
    it('source: cmdRename stops old watcher and re-creates one for newSid', () => {
      const fn = sourceSrc.match(/function\s+cmdRename\([\s\S]*?\n\}/)
      expect(fn, 'cmdRename function must exist').toBeTruthy()
      if (fn) {
        const body = fn[0]
        expect(body).toMatch(/stopSessionWatcher\(oldSid\)/)
        expect(body).toMatch(/ensureWatcher\(newSid\)/)
      }
    })

    it('standalone: cmdRename stops old watcher and re-creates one for newSid', () => {
      const fn = standaloneSrc.match(/function\s+cmdRename\([\s\S]*?\n\}/)
      expect(fn).toBeTruthy()
      if (fn) {
        const body = fn[0]
        expect(body).toMatch(/stopSessionWatcher\(oldSid\)/)
        expect(body).toMatch(/ensureWatcher\(newSid\)/)
      }
    })

    it('source: stopSessionWatcher saves watcher.offset back to session.offset', () => {
      // Without this, ensureWatcher() after rename re-streams the whole file
      // from byte 0 (the UUID dedup layer in walnut catches the dup, but it's
      // wasteful and masks real gaps).
      const fn = sourceSrc.match(/function\s+stopSessionWatcher\([\s\S]*?\n\}/)
      expect(fn).toBeTruthy()
      if (fn) {
        expect(fn[0]).toMatch(/session\.offset\s*=\s*session\.watcher\.offset/)
      }
    })

    it('standalone: stopSessionWatcher saves watcher.offset back to session.offset', () => {
      const fn = standaloneSrc.match(/function\s+stopSessionWatcher\([\s\S]*?\n\}/)
      expect(fn).toBeTruthy()
      if (fn) {
        expect(fn[0]).toMatch(/session\.offset\s*=\s*session\.watcher\.offset/)
      }
    })
  })

  describe('Dead-subscriber garbage collection in poll loop', () => {
    it('source: poll loop drops ws from subscribers when ws.readyState !== OPEN', () => {
      const ensureFn = sourceSrc.match(/function\s+ensureWatcher\([\s\S]*?\n\}/)
      expect(ensureFn).toBeTruthy()
      if (ensureFn) {
        // When readyState is NOT 1 (OPEN), the ws should be evicted.
        expect(ensureFn[0]).toMatch(/s\.subscribers\.delete\(ws\)/)
      }
    })

    it('standalone: poll loop drops ws from subscribers when ws.readyState !== OPEN', () => {
      const ensureFn = standaloneSrc.match(/function\s+ensureWatcher\([\s\S]*?\n\}/)
      expect(ensureFn).toBeTruthy()
      if (ensureFn) {
        expect(ensureFn[0]).toMatch(/s\.subscribers\.delete\(ws\)/)
      }
    })
  })
})
