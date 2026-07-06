/**
 * Tests for isLocalJsonlFresh — the ground-truth freshness veto that orphan
 * sweepers consult before a destructive kill.
 *
 * This is the load-bearing guard introduced after the false-zombie incident:
 * a stale process_status='stopped' flag (mis-set by the server-restart reconciler)
 * plus a still-alive pid used to SIGTERM a healthy CLI. The veto vetoes that kill
 * whenever the session's JSONL was written recently (process visibly still working).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

// Controllable daemon-connection surface for the remote-fallback tests below.
const daemonMock = {
  connected: false,
  probeResult: null as { alive: boolean } | null,
  disconnectedSince: null as number | null,
  probeCalls: 0,
}
vi.mock('../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => daemonMock.connected,
  getDaemonDisconnectedSince: () => daemonMock.disconnectedSince,
  probeDaemonSession: async () => { daemonMock.probeCalls++; return daemonMock.probeResult },
}))

import { isLocalJsonlFresh, isSessionProcessAlive } from '../../src/utils/session-liveness.js'
import { SESSION_STREAMS_DIR } from '../../src/constants.js'
import type { SessionRecord } from '../../src/core/types.js'

const WINDOW_MS = 2 * 60 * 1000

function localSession(sid: string): SessionRecord {
  // Only the fields isLocalJsonlFresh reads.
  return { claudeSessionId: sid, host: undefined } as unknown as SessionRecord
}

async function writeJsonl(sid: string, ageMs: number): Promise<void> {
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
  const p = path.join(SESSION_STREAMS_DIR, `${sid}.jsonl`)
  await fsp.writeFile(p, '{"type":"assistant"}\n', 'utf-8')
  if (ageMs > 0) {
    const t = (Date.now() - ageMs) / 1000
    await fsp.utimes(p, t, t)
  }
}

beforeEach(async () => {
  await fsp.rm(SESSION_STREAMS_DIR, { recursive: true, force: true })
})

afterEach(async () => {
  await fsp.rm(SESSION_STREAMS_DIR, { recursive: true, force: true })
})

describe('isLocalJsonlFresh', () => {
  it('returns true when the JSONL was written within the window (process alive)', async () => {
    await writeJsonl('fresh', 0) // mtime = now
    expect(isLocalJsonlFresh(localSession('fresh'), WINDOW_MS)).toBe(true)
  })

  it('returns false when the JSONL is older than the window (process plausibly dead)', async () => {
    await writeJsonl('stale', 10 * 60 * 1000) // 10 min old
    expect(isLocalJsonlFresh(localSession('stale'), WINDOW_MS)).toBe(false)
  })

  it("returns 'unknown' when the local JSONL does not exist (never kill on doubt)", () => {
    expect(isLocalJsonlFresh(localSession('missing'), WINDOW_MS)).toBe('unknown')
  })

  it("returns 'unknown' for a remote session regardless of any file (daemon owns liveness)", async () => {
    // Even if a same-named file exists locally, a remote session must not be judged
    // by a local mtime — it has no local streams file in production.
    await writeJsonl('remote-sid', 0)
    const remote = { claudeSessionId: 'remote-sid', host: 'clouddev' } as unknown as SessionRecord
    expect(isLocalJsonlFresh(remote, WINDOW_MS)).toBe('unknown')
  })

  it('boundary: a file exactly at the window edge is treated as not-fresh', async () => {
    await writeJsonl('edge', WINDOW_MS + 1000) // just past the window
    expect(isLocalJsonlFresh(localSession('edge'), WINDOW_MS)).toBe(false)
  })

  it('only "true" vetoes a kill — false and unknown must NOT block it (corrected contract)', async () => {
    // Encodes the caller contract: `if (isLocalJsonlFresh(...) === true) skipKill`.
    // Vetoing on 'unknown' would leak remote orphans (always 'unknown') and local
    // PID-recycled orphans whose JSONL was archived — so only positive proof of life
    // (a fresh JSONL) may suppress a kill.
    await writeJsonl('alive', 0)
    const aliveVerdict = isLocalJsonlFresh(localSession('alive'), WINDOW_MS)
    const unknownVerdict = isLocalJsonlFresh(localSession('absent'), WINDOW_MS)
    expect(aliveVerdict === true).toBe(true)    // vetoes the kill (process alive)
    expect(unknownVerdict === true).toBe(false) // does NOT veto (no proof of life → kill proceeds)
  })
})

/**
 * REGRESSION (2026-07-06 audit): the remote fallback of isSessionProcessAlive
 * used to return `true` on the mere fact the daemon CONNECTION was up —
 * connection-liveness ≠ session-liveness. A remote CLI that died while no
 * SessionManager was registered (typical right after a Walnut restart) was
 * badged "running" forever. The daemon's status RPC knows the truth; ask it.
 */
describe('isSessionProcessAlive — remote fallback probes the daemon', () => {
  function remoteSession(): SessionRecord {
    return {
      claudeSessionId: 'remote-fallback-sid',
      host: 'clouddev',
      provider: 'cli',
      process_status: 'running',
      pid: null,
    } as unknown as SessionRecord
  }

  beforeEach(() => {
    daemonMock.connected = false
    daemonMock.probeResult = null
    daemonMock.disconnectedSince = null
    daemonMock.probeCalls = 0
  })

  it('daemon connected + probe says dead → NOT alive (the regression)', async () => {
    daemonMock.connected = true
    daemonMock.probeResult = { alive: false }
    expect(await isSessionProcessAlive(remoteSession())).toBe(false)
    expect(daemonMock.probeCalls).toBe(1)
  })

  it('daemon connected + probe says alive → alive', async () => {
    daemonMock.connected = true
    daemonMock.probeResult = { alive: true }
    expect(await isSessionProcessAlive(remoteSession())).toBe(true)
  })

  it('daemon connected + probe fails (null) → grace-period path, assume alive', async () => {
    // Connection flapped mid-probe: no verdict either way — same treatment as a
    // short disconnect (never flip a session dead on a transient RPC failure).
    daemonMock.connected = true
    daemonMock.probeResult = null
    expect(await isSessionProcessAlive(remoteSession())).toBe(true)
  })

  it('daemon disconnected beyond the 5min grace → NOT alive', async () => {
    daemonMock.connected = false
    daemonMock.disconnectedSince = Date.now() - 6 * 60 * 1000
    expect(await isSessionProcessAlive(remoteSession())).toBe(false)
    expect(daemonMock.probeCalls).toBe(0) // no probe without a connection
  })

  it('daemon disconnected within the grace window → assume alive', async () => {
    daemonMock.connected = false
    daemonMock.disconnectedSince = Date.now() - 60 * 1000
    expect(await isSessionProcessAlive(remoteSession())).toBe(true)
  })
})
