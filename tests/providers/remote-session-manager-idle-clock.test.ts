/**
 * The session manager's side of the idle clock: which stream lines move
 * `lastEventAt`, and the CLI's own turn state the memory-pressure tier reads
 * (src/providers/stream-activity.ts, session-health-monitor.ts checkIdleTimeout).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
})

afterEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})

function attached(sid: string): RemoteSessionManager {
  const mgr = new RemoteSessionManager(`idle-clock-${sid}`, 'testhost', { hostname: 'testhost.example.com', use_daemon: true })
  const internal = mgr as unknown as { _sid: string | null; _onOutput: (line: string) => void }
  internal._sid = sid
  internal._onOutput = () => {}
  return mgr
}

const feed = (mgr: RemoteSessionManager, sid: string, line: string) =>
  (mgr as unknown as { handleDaemonEvent(e: unknown): void }).handleDaemonEvent({ ev: 'jsonl', sid, line })

describe('RemoteSessionManager idle clock', () => {
  it('Walnut\'s own control traffic leaves the clock alone; conversation moves it', () => {
    const mgr = attached('s1')
    feed(mgr, 's1', '{"type":"control_response","response":{"subtype":"success","request_id":"sq-1"}}')
    feed(mgr, 's1', '{"type":"system","subtype":"commands_changed","commands":[]}')
    expect(mgr.lastEventAt).toBe(0)

    feed(mgr, 's1', '{"type":"tool_progress","tool_use_id":"t-heartbeat-1"}')
    expect(mgr.lastEventAt).toBeGreaterThan(Date.now() - 1000)
  })

  it('remembers what the CLI last said about its turn', () => {
    const mgr = attached('s2')
    expect(mgr.cliState).toBeNull()
    feed(mgr, 's2', '{"type":"system","subtype":"session_state_changed","state":"running","uuid":"a"}')
    expect(mgr.cliState).toBe('running')
    feed(mgr, 's2', '{"type":"system","subtype":"session_state_changed","state":"requires_action","uuid":"b"}')
    expect(mgr.cliState).toBe('requires_action')
    feed(mgr, 's2', '{"type":"system","subtype":"session_state_changed","state":"idle","uuid":"c"}')
    expect(mgr.cliState).toBe('idle')
    // A replayed old line (its offset already passed, or its uuid seen) changes nothing.
    const fed = mgr as unknown as { handleDaemonEvent(e: unknown): void }
    fed.handleDaemonEvent({ ev: 'jsonl', sid: 's2', v: 500, line: '{"type":"system","subtype":"session_state_changed","state":"running","uuid":"e"}' })
    expect(mgr.cliState).toBe('running')
    fed.handleDaemonEvent({ ev: 'jsonl', sid: 's2', v: 400, line: '{"type":"system","subtype":"session_state_changed","state":"idle","uuid":"f"}' })
    feed(mgr, 's2', '{"type":"system","subtype":"session_state_changed","state":"idle","uuid":"c"}')
    expect(mgr.cliState).toBe('running')
    fed.handleDaemonEvent({ ev: 'jsonl', sid: 's2', v: 600, line: '{"type":"system","subtype":"session_state_changed","state":"idle","uuid":"g"}' })
    expect(mgr.cliState).toBe('idle')
    // A line for another session says nothing about this one.
    feed(mgr, 'other', '{"type":"system","subtype":"session_state_changed","state":"running","uuid":"d"}')
    expect(mgr.cliState).toBe('idle')
  })
})
