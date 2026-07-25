import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

const daemonMock = vi.hoisted(() => ({
  getDaemonConnection: vi.fn(),
}))

vi.mock('../../../src/constants.js', () => createMockConstants())
vi.mock('../../../src/core/ssh-config-scanner.js', () => ({
  scanSshConfig: async () => new Map(),
}))
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  getDaemonConnection: daemonMock.getDaemonConnection,
}))

import { CONFIG_FILE, WALNUT_HOME } from '../../../src/constants.js'
import { closeDb } from '../../../src/core/session-db.js'
import { _resetSessionTrackerForTesting, importSessionRecord } from '../../../src/core/session-tracker.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { sessionsRouter } from '../../../src/web/routes/sessions.js'

const execFileAsync = promisify(execFile)
let fixtureRoot: string

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/sessions', sessionsRouter)
  app.use(errorHandler)
  return app
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test User',
      GIT_AUTHOR_EMAIL: 'test@example.test',
      GIT_COMMITTER_NAME: 'Test User',
      GIT_COMMITTER_EMAIL: 'test@example.test',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  })
}

async function createRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await git(dir, 'init', '--initial-branch=main')
  await fs.writeFile(path.join(dir, 'README.txt'), 'fixture\n')
  await git(dir, 'add', 'README.txt')
  await git(dir, 'commit', '-m', 'Initial fixture')
}

beforeEach(async () => {
  daemonMock.getDaemonConnection.mockReset()
  closeDb()
  _resetSessionTrackerForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-vscode-uri-'))
})

afterEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.rm(fixtureRoot, { recursive: true, force: true })
})

describe('GET /api/sessions/:sessionId/vscode-uri', () => {
  it('returns the nearest local git root', async () => {
    const repo = path.join(fixtureRoot, 'project')
    const cwd = path.join(repo, 'packages', 'app')
    await createRepo(repo)
    await fs.mkdir(cwd, { recursive: true })
    await importSessionRecord({ claudeSessionId: 'local-git', taskId: '', project: 'Fixture', cwd })

    const res = await request(createApp()).get('/api/sessions/local-git/vscode-uri')

    expect(res.status).toBe(200)
    const canonicalRepo = await fs.realpath(repo)
    expect(res.body).toEqual({ uri: `vscode://file/${canonicalRepo.replace(/^\/+/, '')}` })
  })

  it('uses a real git submodule root instead of its outer repository', async () => {
    const innerSource = path.join(fixtureRoot, 'inner-source')
    const outer = path.join(fixtureRoot, 'outer')
    await createRepo(innerSource)
    await createRepo(outer)
    await execFileAsync('git', [
      '-c', 'protocol.file.allow=always', '-C', outer,
      'submodule', 'add', innerSource, 'modules/inner',
    ])
    await git(outer, 'commit', '-am', 'Add fixture submodule')
    const submoduleRoot = path.join(outer, 'modules', 'inner')
    const cwd = path.join(submoduleRoot, 'src', 'nested')
    await fs.mkdir(cwd, { recursive: true })
    await importSessionRecord({ claudeSessionId: 'local-submodule', taskId: '', project: 'Fixture', cwd })

    const res = await request(createApp()).get('/api/sessions/local-submodule/vscode-uri')

    expect(res.status).toBe(200)
    const canonicalSubmoduleRoot = await fs.realpath(submoduleRoot)
    expect(res.body.uri).toBe(`vscode://file/${canonicalSubmoduleRoot.replace(/^\/+/, '')}`)
  })

  it('falls back to a non-git working directory', async () => {
    const cwd = path.join(fixtureRoot, 'plain directory')
    await fs.mkdir(cwd, { recursive: true })
    await importSessionRecord({ claudeSessionId: 'local-plain', taskId: '', project: 'Fixture', cwd })

    const res = await request(createApp()).get('/api/sessions/local-plain/vscode-uri')

    expect(res.status).toBe(200)
    expect(res.body.uri).toBe(`vscode://file/${cwd.replace(/^\/+/, '').replace(' ', '%20')}`)
  })

  it('resolves a remote alias and expands a tilde cwd through the daemon', async () => {
    await fs.mkdir(WALNUT_HOME, { recursive: true })
    await fs.writeFile(CONFIG_FILE, [
      'version: 1',
      'hosts:',
      '  studio:',
      '    hostname: dev.example.test',
      '    user: developer',
      '',
    ].join('\n'))
    const send = vi.fn()
      .mockResolvedValueOnce({ ok: true, resolvedPath: '/home/developer/work/repo/src', entries: [] })
      .mockResolvedValueOnce({ ok: true, resolvedPath: '/home/developer/work/repo/src', entries: [] })
      .mockResolvedValueOnce({ ok: true, resolvedPath: '/home/developer/work/repo', entries: [{ name: '.git', type: 'dir' }] })
    daemonMock.getDaemonConnection.mockResolvedValue({ send })
    await importSessionRecord({
      claudeSessionId: 'remote-git', taskId: '', project: 'Fixture', cwd: '~/work/repo/src', host: 'studio',
    })

    const res = await request(createApp()).get('/api/sessions/remote-git/vscode-uri')

    expect(res.status).toBe(200)
    expect(res.body.uri).toBe('vscode://vscode-remote/ssh-remote+developer@dev.example.test/home/developer/work/repo')
    expect(send).toHaveBeenCalledTimes(3)
    expect(daemonMock.getDaemonConnection).toHaveBeenCalledWith('studio', {
      hostname: 'dev.example.test', user: 'developer', port: undefined,
    })
  })

  it('falls back to the resolved remote cwd when git-root lookup fails', async () => {
    await fs.mkdir(WALNUT_HOME, { recursive: true })
    await fs.writeFile(CONFIG_FILE, 'version: 1\nhosts:\n  studio:\n    hostname: dev.example.test\n')
    const send = vi.fn()
      .mockResolvedValueOnce({ ok: true, resolvedPath: '/srv/work', entries: [] })
      .mockRejectedValueOnce(new Error('remote lookup failed'))
    daemonMock.getDaemonConnection.mockResolvedValue({ send })
    await importSessionRecord({
      claudeSessionId: 'remote-fallback', taskId: '', project: 'Fixture', cwd: '~/work', host: 'studio',
    })

    const res = await request(createApp()).get('/api/sessions/remote-fallback/vscode-uri')

    expect(res.status).toBe(200)
    expect(res.body.uri).toBe('vscode://vscode-remote/ssh-remote+dev.example.test/srv/work')
  })

  it('rejects an unresolved tilde cwd instead of returning a relative remote URI', async () => {
    await fs.mkdir(WALNUT_HOME, { recursive: true })
    await fs.writeFile(CONFIG_FILE, 'version: 1\nhosts:\n  studio:\n    hostname: dev.example.test\n')
    daemonMock.getDaemonConnection.mockRejectedValue(new Error('daemon unavailable'))
    await importSessionRecord({
      claudeSessionId: 'remote-unresolved', taskId: '', project: 'Fixture', cwd: '~/work', host: 'studio',
    })

    const res = await request(createApp()).get('/api/sessions/remote-unresolved/vscode-uri')

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Could not resolve remote working directory for host alias: studio')
  })

  it('returns 400 for an unknown remote alias', async () => {
    await importSessionRecord({
      claudeSessionId: 'remote-unknown', taskId: '', project: 'Fixture', cwd: '/srv/work', host: 'missing',
    })

    const res = await request(createApp()).get('/api/sessions/remote-unknown/vscode-uri')

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('Unknown session host alias: missing')
  })

  it('returns 400 when cwd is missing and 404 for an unknown session', async () => {
    await importSessionRecord({ claudeSessionId: 'no-cwd', taskId: '', project: 'Fixture' })

    const noCwd = await request(createApp()).get('/api/sessions/no-cwd/vscode-uri')
    const missing = await request(createApp()).get('/api/sessions/does-not-exist/vscode-uri')

    expect(noCwd.status).toBe(400)
    expect(noCwd.body.error).toBe('session has no working directory')
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe('session not found')
  })
})
