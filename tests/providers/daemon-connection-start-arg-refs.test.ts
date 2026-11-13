/**
 * DaemonConnection.send('start') names long arguments by hash only for a daemon that takes them
 * (start-arg-refs-v1 with hook-files-v1), never for this machine's own daemon, and an older
 * daemon gets the caller's args exactly as they were (start-arg-refs.ts).
 *
 * Real layer: a real DaemonConnection over a real WebSocket to MockDaemon, which resolves refs and
 * records each start's args as the real daemon's cmdStart reads them, and the bytes on the wire.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { MockDaemon } from '../helpers/mock-daemon.js'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { START_ARG_REFS_CAPABILITY, ARG_REF_TOKEN, _resetStartArgRefsForTesting } from '../../src/providers/start-arg-refs.js'
import { HOOK_FILES_CAPABILITY } from '../../src/providers/hook-files.js'

const TARGET = { hostname: '127.0.0.1', user: undefined, port: undefined }
const SETTINGS = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: 'x'.repeat(30_000) }] }] } })
const PROMPT = 'p'.repeat(20_000)
const argsFor = (sid: string) => ['claude', '--settings', SETTINGS, '--append-system-prompt', PROMPT, '--resume', sid]

describe('DaemonConnection start with argument refs', () => {
  let daemon: MockDaemon
  let conn: DaemonConnection | null = null

  beforeEach(async () => {
    _resetStartArgRefsForTesting()
    daemon = new MockDaemon()
  })

  afterEach(async () => {
    try { conn?.disconnect() } catch { /* best effort */ }
    conn = null
    await daemon.stop()
  })

  async function starts(host: string, omit: string[] = []) {
    daemon.omitCapabilities(omit)
    await daemon.start()
    conn = new DaemonConnection(host, TARGET)
    await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)
    for (const sid of ['s-1', 's-2', 's-3']) {
      const r = await conn.send('start', { sid, cwd: '/tmp', message: '', args: argsFor(sid) })
      expect(r.ok).toBe(true)
    }
    return daemon.getCommandHistory().filter((c) => c.cmd === 'start')
  }

  it('a daemon that takes refs gets the long arguments once, and records the inline args every time', async () => {
    const got = await starts('arg-refs-new')
    expect(got.map((c) => c.payload.args)).toEqual(['s-1', 's-2', 's-3'].map(argsFor))
    expect(got[0].wireBytes).toBeGreaterThan(50_000)
    expect(got[1].wireBytes).toBeLessThan(2_000)
    expect(got[2].wireBytes).toBeLessThan(2_000)
  })

  for (const cap of [START_ARG_REFS_CAPABILITY, HOOK_FILES_CAPABILITY]) {
    it(`a daemon without ${cap} gets the caller's args as they were, every time`, async () => {
      const got = await starts(`arg-refs-old-${cap}`, [cap])
      for (const c of got) {
        expect(c.payload.argRefs).toBeUndefined()
        expect(c.wireBytes).toBeGreaterThan(50_000)
        // On the wire, as the caller gave them: an older daemon would hand a ref or a hook-file flag to the CLI.
        expect(c.wireArgs).toEqual(argsFor(c.payload.sid as string))
        expect(JSON.stringify(c.wireArgs)).not.toContain(ARG_REF_TOKEN)
        expect(JSON.stringify(c.wireArgs)).not.toContain('--walnut-hook-file')
      }
      expect(got.map((c) => c.payload.args)).toEqual(['s-1', 's-2', 's-3'].map(argsFor))
    })
  }

  it("this machine's own daemon gets every start in full", async () => {
    const got = await starts('__local__')
    for (const c of got) {
      expect(c.payload.argRefs).toBeUndefined()
      expect(c.wireBytes).toBeGreaterThan(50_000)
    }
  })
})
