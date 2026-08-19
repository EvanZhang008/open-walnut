/**
 * POST /api/sessions/:sessionId/vscode-embed — route-level tests.
 *
 * The daemon and the local code-server core are mocked (the real lifecycle is
 * covered by tests/providers/vscode-server-core.test.ts with a fake
 * code-server binary); these tests pin the route's contract: local vs remote
 * dispatch, capability gating, tunnel wiring, and the error taxonomy
 * (400 no-cwd / 404 unknown / 502 start-failure / 503 not-installed).
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

const daemonMock = vi.hoisted(() => ({
  getDaemonConnection: vi.fn(),
}))
const coreMock = vi.hoisted(() => ({
  ensureCodeServer: vi.fn(),
  resolveOpenTarget: vi.fn(),
}))

vi.mock('../../../src/constants.js', () => createMockConstants())
vi.mock('../../../src/core/ssh-config-scanner.js', () => ({
  scanSshConfig: async () => new Map(),
}))
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  getDaemonConnection: daemonMock.getDaemonConnection,
}))
vi.mock('../../../src/providers/vscode-server-core.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/providers/vscode-server-core.js')>()
  return {
    ...original,
    ensureCodeServer: coreMock.ensureCodeServer,
    resolveOpenTarget: coreMock.resolveOpenTarget,
  }
})

import { CONFIG_FILE, WALNUT_HOME } from '../../../src/constants.js'
import { closeDb } from '../../../src/core/session-db.js'
import { _resetSessionTrackerForTesting, importSessionRecord } from '../../../src/core/session-tracker.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { sessionsRouter } from '../../../src/web/routes/sessions.js'

let fixtureRoot: string

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/sessions', sessionsRouter)
  app.use(errorHandler)
  return app
}

async function writeHostsConfig(): Promise<void> {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.writeFile(CONFIG_FILE, [
    'version: 1',
    'hosts:',
    '  studio:',
    '    hostname: dev.example.test',
    '    user: developer',
    '',
  ].join('\n'))
}

beforeEach(async () => {
  daemonMock.getDaemonConnection.mockReset()
  coreMock.ensureCodeServer.mockReset()
  coreMock.resolveOpenTarget.mockReset()
  closeDb()
  _resetSessionTrackerForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-vscode-embed-'))
})

afterEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.rm(fixtureRoot, { recursive: true, force: true })
})

describe('POST /api/sessions/:sessionId/vscode-embed (local sessions)', () => {
  it('ensures the local code-server and returns a folder URL', async () => {
    const cwd = path.join(fixtureRoot, 'project')
    await fs.mkdir(cwd, { recursive: true })
    await importSessionRecord({ claudeSessionId: 'local-1', taskId: '', project: 'Fixture', cwd })
    coreMock.ensureCodeServer.mockResolvedValue({
      ok: true, running: true, installed: true, port: 41234, token: 'tok-1', version: '4.98.2',
    })
    coreMock.resolveOpenTarget.mockResolvedValue({ kind: 'folder', path: cwd })

    const res = await request(createApp()).post('/api/sessions/local-1/vscode-embed')

    expect(res.status).toBe(200)
    expect(res.body.url).toBe(`http://127.0.0.1:41234/?folder=${encodeURIComponent(cwd)}`)
    expect(res.body.token).toBe('tok-1')
    expect(res.body.host).toBe('__local__')
    expect(res.body.open).toEqual({ kind: 'folder', path: cwd })
    expect(daemonMock.getDaemonConnection).not.toHaveBeenCalled()
  })

  it('uses ?workspace= when the target is a workspace file', async () => {
    const cwd = path.join(fixtureRoot, 'ws-project')
    await fs.mkdir(cwd, { recursive: true })
    const wsFile = path.join(cwd, 'proj.code-workspace')
    await importSessionRecord({ claudeSessionId: 'local-ws', taskId: '', project: 'Fixture', cwd })
    coreMock.ensureCodeServer.mockResolvedValue({
      ok: true, running: true, installed: true, port: 41235, token: 'tok-ws',
    })
    coreMock.resolveOpenTarget.mockResolvedValue({ kind: 'workspace', path: wsFile })

    const res = await request(createApp()).post('/api/sessions/local-ws/vscode-embed')

    expect(res.status).toBe(200)
    expect(res.body.url).toBe(`http://127.0.0.1:41235/?workspace=${encodeURIComponent(wsFile)}`)
  })

  it('503 + hint when code-server is not installed', async () => {
    await importSessionRecord({ claudeSessionId: 'local-uninst', taskId: '', project: 'Fixture', cwd: fixtureRoot })
    coreMock.ensureCodeServer.mockResolvedValue({
      ok: false, running: false, installed: false, installHint: 'download code-server 4.98.2 into ~/.local/lib/',
    })

    const res = await request(createApp()).post('/api/sessions/local-uninst/vscode-embed')

    expect(res.status).toBe(503)
    expect(res.body.hint).toContain('code-server')
  })

  it('502 when code-server fails to start', async () => {
    await importSessionRecord({ claudeSessionId: 'local-fail', taskId: '', project: 'Fixture', cwd: fixtureRoot })
    coreMock.ensureCodeServer.mockResolvedValue({
      ok: false, running: false, installed: true, error: 'did not become healthy',
    })

    const res = await request(createApp()).post('/api/sessions/local-fail/vscode-embed')

    expect(res.status).toBe(502)
    expect(res.body.error).toContain('healthy')
  })

  it('propagates install=false as a noInstall probe', async () => {
    await importSessionRecord({ claudeSessionId: 'local-probe', taskId: '', project: 'Fixture', cwd: fixtureRoot })
    coreMock.ensureCodeServer.mockResolvedValue({
      ok: false, running: false, installed: false, installHint: 'x',
    })

    await request(createApp()).post('/api/sessions/local-probe/vscode-embed?install=false')

    expect(coreMock.ensureCodeServer).toHaveBeenCalledWith({ noInstall: true })
  })
})

describe('POST /api/sessions/:sessionId/vscode-embed (remote sessions)', () => {
  it('asks the daemon, forwards the port, and answers the tunnel-local URL', async () => {
    await writeHostsConfig()
    await importSessionRecord({
      claudeSessionId: 'remote-1', taskId: '', project: 'Fixture',
      cwd: '~/work/repo', host: 'studio',
    })
    const send = vi.fn().mockResolvedValue({
      ok: true, running: true, installed: true, port: 39000, token: 'tok-r', version: '4.98.2',
      open: { kind: 'folder', path: '/home/developer/work/repo' },
    })
    const ensurePortForward = vi.fn().mockResolvedValue(51888)
    daemonMock.getDaemonConnection.mockResolvedValue({
      send, ensurePortForward, hasCapability: (c: string) => c === 'vscode-v1',
    })

    const res = await request(createApp()).post('/api/sessions/remote-1/vscode-embed')

    expect(res.status).toBe(200)
    expect(send).toHaveBeenCalledWith(
      'vscode.ensure',
      { cwd: '~/work/repo', noInstall: false },
      expect.any(Number),
    )
    expect(ensurePortForward).toHaveBeenCalledWith(39000)
    expect(res.body.url).toBe(
      `http://127.0.0.1:51888/?folder=${encodeURIComponent('/home/developer/work/repo')}`,
    )
    expect(res.body.host).toBe('studio')
    expect(res.body.token).toBe('tok-r')
  })

  it('503 upgrade hint when the daemon lacks vscode-v1', async () => {
    await writeHostsConfig()
    await importSessionRecord({
      claudeSessionId: 'remote-old', taskId: '', project: 'Fixture',
      cwd: '~/work', host: 'studio',
    })
    daemonMock.getDaemonConnection.mockResolvedValue({
      send: vi.fn(), ensurePortForward: vi.fn(), hasCapability: () => false,
    })

    const res = await request(createApp()).post('/api/sessions/remote-old/vscode-embed')

    expect(res.status).toBe(503)
    expect(res.body.error).toContain('upgrade')
  })

  it('503 + remote install hint when the host has no code-server', async () => {
    await writeHostsConfig()
    await importSessionRecord({
      claudeSessionId: 'remote-uninst', taskId: '', project: 'Fixture',
      cwd: '~/work', host: 'studio',
    })
    const send = vi.fn().mockResolvedValue({
      ok: false, running: false, installed: false, installHint: 'download code-server into ~/.local/lib/',
    })
    daemonMock.getDaemonConnection.mockResolvedValue({
      send, ensurePortForward: vi.fn(), hasCapability: (c: string) => c === 'vscode-v1',
    })

    const res = await request(createApp()).post('/api/sessions/remote-uninst/vscode-embed')

    expect(res.status).toBe(503)
    expect(res.body.error).toContain('studio')
    expect(res.body.hint).toContain('code-server')
  })

  it('400 for an unknown host alias', async () => {
    // No hosts config written — alias can't resolve.
    await importSessionRecord({
      claudeSessionId: 'remote-alias', taskId: '', project: 'Fixture',
      cwd: '~/work', host: 'ghost',
    })

    const res = await request(createApp()).post('/api/sessions/remote-alias/vscode-embed')

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('ghost')
  })
})

describe('POST /api/sessions/:sessionId/vscode-embed (error taxonomy)', () => {
  it('404 for an unknown session', async () => {
    const res = await request(createApp()).post('/api/sessions/nope/vscode-embed')
    expect(res.status).toBe(404)
  })

  it('400 for a session without a cwd', async () => {
    await importSessionRecord({ claudeSessionId: 'no-cwd', taskId: '', project: 'Fixture', cwd: '' })
    const res = await request(createApp()).post('/api/sessions/no-cwd/vscode-embed')
    expect(res.status).toBe(400)
  })
})
