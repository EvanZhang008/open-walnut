import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'
vi.mock('../../src/constants.js', () => createMockConstants('credential-ask-e2e', { IS_EPHEMERAL: true }))
import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sendLetterOnce, listLetters, setArchived } from '../../src/core/human-inbox/store.js'
import { saveConfig, getConfig } from '../../src/core/config-manager.js'
import path from 'node:path'
import { addTask } from '../../src/core/task-manager.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'

let server: Server
let root: string
beforeAll(async () => {
  server = await startServer({ port: 0, dev: true })
  root = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => { await stopServer(); await fs.rm(WALNUT_HOME, { recursive: true, force: true }) })

const ask = (host: string, kind = 'ssh-certificate') => ({
  subject: `Renew ${kind} on ${host}`, type: 'review', markdown: `Please renew ${kind} on ${host}.`,
  credential_ask: { host, kind, expiresAt: 3000 },
})
const send = (body: unknown, sid: string) => fetch(`${root}/api/v1/human-inbox`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-walnut-caller-sid': sid }, body: JSON.stringify(body),
})

describe('credential identity through the real letter API', () => {
  it('a legacy remote cookie decision cannot block a local certificate request', async () => {
    await saveConfig({ ...await getConfig(), ssh_login_hint: 'run acmelogin on the Mac', hosts: {
      'remote-box': { hostname: 'box.example.test', user: 'dev', label: 'Remote workstation' },
    } } as never)
    const prior = await sendLetterOnce({ subject: 'Renew remote cookie', type: 'action_required', markdown: 'Please run acmelogin on remote-box to refresh the cookie.',
      actions: [{ id: 'done', label: 'Done' }], sender: { sessionId: 'legacy-task', host: 'remote-box', taskId: 'legacy-remote-task', taskTitle: 'Legacy remote operation' } })
    // Reproduce an already-open letter from the published old version with no identity field.
    const index = path.join(WALNUT_HOME, 'human-inbox', 'index.json')
    const data = JSON.parse(await fs.readFile(index, 'utf8'))
    delete data.letters.find((letter: { id: string }) => letter.id === prior.letter.id).credentialAsk
    await fs.writeFile(index, JSON.stringify(data))
    const task = (await addTask({ title: 'Local credential operation' })).task
    const sid = `local-${task.id}`
    await createSessionRecord(sid, task.id, '', WALNUT_HOME)
    const response = await send({ ...ask('__local__'), credential_ask: { host: '__local__', kind: 'ssh-certificate', expiresAt: 2000 }, subject: 'Please renew the SSH certificate on the Mac' }, sid)
    expect(response.status).toBe(201)
    const id = (await response.json() as { id: string }).id
    expect(id).not.toBe(prior.letter.id)
    await setArchived(prior.letter.id, true)
    await setArchived(id, true)
  })

  it('a core warning and two unrelated task sends share one letter, another owner gets its own, and another part of that owner\'s sign-in folds into it', async () => {
    const core = await sendLetterOnce({ subject: 'Certificate on this computer expires', type: 'review', markdown: 'Renew the local certificate.',
      credentialAsk: { host: '__local__', kind: 'ssh-certificate', expiresAt: 3000 }, sender: { sessionId: 'external', host: 'local' } }, { opKey: 'core-cert:2000' })
    const tasks = await Promise.all(['Operations', 'Build checks'].map(async title => {
      const task = (await addTask({ title })).task
      const sid = `credential-${task.id}`
      await createSessionRecord(sid, task.id, '', WALNUT_HOME)
      return sid
    }))
    const repeated = await Promise.all(tasks.map(sid => send(ask('__local__'), sid)))
    for (const res of repeated) {
      expect(res.status).toBe(201)
      expect((await res.json() as { id: string }).id).toBe(core.letter.id)
    }
    const other = await send(ask('remote-box'), tasks[0]!)
    expect(other.status).toBe(201)
    const otherId = (await other.json() as { id: string }).id
    expect(otherId).not.toBe(core.letter.id)
    const cookie = await send(ask('remote-box', 'login-cookie'), tasks[1]!)
    expect(cookie.status).toBe(201)
    expect((await cookie.json() as { id: string }).id).toBe(otherId)
    expect((await listLetters()).letters).toHaveLength(2)
    const detail = await fetch(`${root}/api/v1/human-inbox/${core.letter.id}`).then(r => r.json()) as { letter: { credentialAsk: unknown; body: string } }
    expect(detail.letter.credentialAsk).toEqual({ host: '__local__', kind: 'ssh-certificate', expiresAt: 3000 })
    expect(detail.letter.body).toContain('local certificate')
  })
})
