/**
 * A boot's recovery write survives the lock a dead server left behind.
 *
 * 2026-10-08, on the cloud companion, twice in a row: the deploy's old server was
 * writing its "SERVER EXIT" card when it exited, and left notifications.json.lock
 * with an EMPTY pid file. Waiters can only age such a lock out after 30s and each
 * gives up at 10s, so the new server's boot-time 'web-assets' recovery failed
 * ("File lock timeout after 10000ms"), and publishRecovery dropped it: the
 * VANISHED card that recovery existed to retire stayed up.
 *
 * Reproduced here as it was on disk: an unresolved card, then the dead holder's
 * lock dir with an empty pid file, then a real boot. The card must still retire
 * (publishRecovery retries a failed write).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { Server } from 'node:http'
import { WALNUT_HOME } from '../../src/constants.js'

let tmp: string
let staticDir: string
let server: Server | undefined
let previousDisableSearch: string | undefined

const LOCK = path.join(WALNUT_HOME, 'notifications.json.lock')

function writeBuild(): void {
  fs.mkdirSync(path.join(staticDir, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(staticDir, 'index.html'),
    '<!doctype html><script type="module" src="/assets/index-DEF456.js"></script>')
  fs.writeFileSync(path.join(staticDir, 'assets', 'index-DEF456.js'), 'entry\n')
}

async function cardState(dedupKey: string) {
  const { listNotifications } = await import('../../src/core/notifications/store.js')
  return (await listNotifications()).feed.find((n) => n.dedupKey === dedupKey)?.resolved
}

beforeAll(() => {
  previousDisableSearch = process.env.WALNUT_DISABLE_SEARCH
  process.env.WALNUT_DISABLE_SEARCH = '1'
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-dead-lock-'))
  staticDir = path.join(tmp, 'stage', 'dist', 'web', 'static')
  process.env.WALNUT_WEB_STATIC_DIR = staticDir
  process.env.WALNUT_WEB_STATIC_MIRROR = path.join(tmp, 'mirror')
  writeBuild()
})

afterAll(async () => {
  if (server) await (await import('../../src/web/server.js')).stopServer()
  fs.rmSync(LOCK, { recursive: true, force: true })
  delete process.env.WALNUT_WEB_STATIC_MIRROR
  delete process.env.WALNUT_WEB_STATIC_DIR
  if (previousDisableSearch === undefined) delete process.env.WALNUT_DISABLE_SEARCH
  else process.env.WALNUT_DISABLE_SEARCH = previousDisableSearch
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('boot after a server that died holding the notifications lock', () => {
  it('still retires the web-assets card', async () => {
    const { upsertNotification } = await import('../../src/core/notifications/store.js')
    await upsertNotification({
      kind: 'operation-error', severity: 'error',
      title: 'Web assets VANISHED from under the running server',
      dedupKey: 'logerr:web:dead-lock', recoveryKey: 'web-assets',
    })
    // The dead server's lock: made, pid never written.
    fs.mkdirSync(LOCK)
    fs.writeFileSync(path.join(LOCK, 'pid'), '')

    const { startServer } = await import('../../src/web/server.js')
    server = await startServer({ port: 0, dev: false })

    const deadline = Date.now() + 90_000
    let state = await cardState('logerr:web:dead-lock')
    while (state !== 'recovered' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500))
      state = await cardState('logerr:web:dead-lock')
    }
    expect(state).toBe('recovered')
  }, 150_000)
})
