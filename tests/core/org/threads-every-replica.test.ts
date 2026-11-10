/**
 * Only the leader keeps Threads, and every replica knows it, not only the companion (2026-11-10,
 * the user: "cloud companion is just walnut replica server with some special capability"; a host
 * replica read and wrote its own empty Threads files while the companion refused).
 *
 *   1. The real store and the real server role, not in cloud mode: a host replica (either env a
 *      replica is started with) reads none of a threads file on its disk, lists no node, writes
 *      nothing and files no message; the leader reads the same file.
 *   2. The class: every source file that reads or writes Threads, the files that import the store
 *      and the Threads route, keys "only the leader keeps them" on the replica role (isFollower),
 *      never on the companion alone (isCompanion, CLOUD_MODE).
 *   3. The phone's sentence is the replica's own, never a fixed "cloud companion" one.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-threads-every-replica'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { fileThreadMessage, listThreadNodes, readThreads, setThreadAnswers, sweepClosedThreads } from '../../../src/core/org/threads-store.js'
import { runThreadFollowPass } from '../../../src/core/org/thread-follow.js'
import { staleSummariesAtStop } from '../../../src/core/org/thread-summary-stop.js'
import { isFollower } from '../../../src/core/server-role.js'

const ROOT = path.resolve(__dirname, '../../..')
const NODE = 'node-every-replica'
const REPLICA_ENVS = [
  ['a host replica program (walnut web --replica)', { WALNUT_ROLE: 'replica' }],
  ['a plain host server', { WALNUT_HOST_SERVER: '1' }],
] as const

let fileHash = ''
const threadsFile = () => path.join(WALNUT_HOME, 'org', 'threads', `${NODE}.json`)
const hashOf = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

function asReplica(env: Record<string, string>): () => void {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
  Object.assign(process.env, env)
  return () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}

let restore: (() => void) | null = null
afterEach(() => { restore?.(); restore = null })

beforeAll(async () => {
  // Written as the leader: one real thread on this server's disk.
  await fileThreadMessage(NODE, { text: 'please look at the deploy', via: 'chat', at: new Date().toISOString() })
  fileHash = hashOf(threadsFile())
})

describe('the store, with the real server role and no cloud mode', () => {
  it('the leader reads the threads file it keeps', async () => {
    expect(isFollower()).toBe(false)
    expect((await readThreads(NODE)).threads).toHaveLength(1)
    expect(await listThreadNodes()).toContain(NODE)
  })

  it.each(REPLICA_ENVS)('%s keeps no Threads: reads none, lists none, writes nothing', async (_name, env) => {
    restore = asReplica(env)
    expect(isFollower()).toBe(true)
    expect((await readThreads(NODE)).threads).toEqual([])
    expect(await listThreadNodes()).toEqual([])
    await expect(fileThreadMessage(NODE, { text: 'a second ask', via: 'chat', at: new Date().toISOString() })).rejects.toMatchObject({ status: 501 })
    expect(await setThreadAnswers(NODE, new Map([['tm-x', { text: 'an answer', at: new Date().toISOString() }]]))).toBe(0)
    expect(await sweepClosedThreads()).toBe(0)
    expect(await runThreadFollowPass()).toBe(0)
    expect(await staleSummariesAtStop('any-session')).toBeNull()
    expect(hashOf(threadsFile())).toBe(fileHash)
  })
})

/** Every file under src/ that reaches the Threads store, plus the Threads route. */
function threadSources(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (p.endsWith('.ts') && /threads-store(\.js)?['"]/.test(fs.readFileSync(p, 'utf8'))) out.push(path.relative(ROOT, p))
    }
  }
  walk(path.join(ROOT, 'src'))
  return [...new Set([...out, 'src/core/org/threads-store.ts', 'src/web/routes/org-threads-v1.ts'])].sort()
}

describe('the class: "only the leader keeps Threads" is a replica rule', () => {
  it('every Threads source keys it on the replica role, never on the companion alone', async () => {
    const files = threadSources()
    // The store itself, the route, the capture, the follow rule, and the rest that import it.
    expect(files.length).toBeGreaterThanOrEqual(10)
    const offenders: string[] = []
    for (const f of files) {
      const src = await fsp.readFile(path.join(ROOT, f), 'utf8')
      src.split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '')
        if (/\bisCompanion\s*\(|\bCLOUD_MODE\b/.test(code)) offenders.push(`${f}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders, 'use isFollower() (core/server-role.ts): a host replica keeps no Threads either').toEqual([])
  })

  it('the phone shows the replica\'s own sentence, never a fixed "cloud companion" one', async () => {
    const swift = await fsp.readFile(path.join(ROOT, 'ios-native/Walnut/Views/Org/OrgThreadsStore.swift'), 'utf8')
    const literals = swift.split('\n').filter((l) => !l.trim().startsWith('//') && /"[^"]*companion[^"]*"/i.test(l))
    expect(literals).toEqual([])
  })
})
