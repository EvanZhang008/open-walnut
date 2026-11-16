/**
 * subagent_run with `host` end to end (core/subagents/on-host.ts, work-copy.ts): a task's session
 * on this machine runs ONE step on another host as a subagent. Two hosts whose daemons are the real
 * move cores (transfer-pack-core.ts, transfer-core.ts) over two folders of this machine, real git,
 * the real registry, lane-turn runner, host_copy job and session store. Only the CLI is faked: the
 * subagent's session start is caught (it is checked to be a full task-session start), and the fake
 * "session" works in the copy, leaves files, and answers.
 *
 * Guards (2026-11-15, Evan: "it should be the same as create a task have full power"):
 *   - the subagent gets the caller's commits, uncommitted change (still uncommitted) and untracked file;
 *   - the caller's own folder is left exactly as it was;
 *   - its files come back into the caller's task directory;
 *   - nothing of the run is left on the other host, whether it answers, fails or is stopped;
 *   - its session starts like a task session there: no profile (a profile is how a session is cut
 *     down: slim settings, a tool list, a replaced prompt), the caller's full access, Claude Code
 *     with the CLI's own default model.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { gitChildEnv } from '../../../src/lib/git-env.js'

const W = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsx = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osx = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const px = require('node:path') as typeof import('node:path')
  const root = fsx.realpathSync(fsx.mkdtempSync(px.join(osx.tmpdir(), 'walnut-subagent-host-')))
  return {
    root,
    homes: { __local__: px.join(root, 'mac-home'), cloud: px.join(root, 'cloud-home') } as Record<string, string>,
    stops: [] as string[],
    removed: [] as Array<{ host: string; path: string }>,
    /** Its owner does not confirm the CLI ended (terminateSession's 'pending'). */
    stopUnconfirmed: false,
    /** Messages sent into a session after its start (a follow-up turn), and what the fake session does with one. */
    sends: [] as Array<{ sid: string; text: string }>,
    delivered: [] as Array<{ sid: string; text: string; messageId?: string }>,
    onSend: null as null | ((sid: string, text: string) => void),
  }
})

vi.mock('../../../src/constants.js', () => createMockConstants('subagent-on-host'))
vi.mock('../../../src/core/config-manager.js', async (orig) => {
  const real = await orig<typeof import('../../../src/core/config-manager.js')>()
  return { ...real, getConfig: async () => ({ ...(await real.getConfig()), hosts: { cloud: { hostname: 'cloud', enabled: true } } }) }
})
vi.mock('../../../src/core/sessions/task-dir-place.js', () => ({
  taskDirForHost: async (taskId: string, host?: string | null) => `${W.homes[host && host !== 'local' ? host : '__local__']}/tasks/${taskId}`,
  ensureTaskDirOnHost: async (taskId: string, host?: string | null) => {
    const h = host && host !== 'local' ? host : '__local__'
    const dir = `${W.homes[h]}/tasks/${taskId}`;
    (await import('node:fs')).mkdirSync(dir, { recursive: true })
    return { path: dir, host: h }
  },
  localTaskDirRoot: () => `${W.homes.__local__}/tasks`,
}))
vi.mock('../../../src/core/daemon-file-reader.js', () => {
  const expand = (host: string, p: string) => (p.startsWith('~/') ? `${W.homes[host]}${p.slice(1)}` : p)
  // The test root, and this server's own transfers folder beside its data (workspace.ts transfersDir).
  const inRoot = (f: string) => { if (!f.startsWith(W.root) && !/-transfers\/xf-[0-9a-f-]{36}(?:\/|$)/.test(f)) throw new Error('outside the test root: ' + f) }
  return {
    DaemonNeedsUpgradeError: class extends Error {},
    DaemonFileReader: class {
      constructor(private host: string) {}
      async ensureDir(p: string) { const f = expand(this.host, p); inRoot(f); (await import('node:fs')).mkdirSync(f, { recursive: true }) }
      async listDir(p: string) { return (await import('node:fs')).readdirSync(expand(this.host, p)) }
      async listDirStrict(p: string) { return (await import('node:fs')).readdirSync(expand(this.host, p)) }
      async listDirDetailed(p: string) {
        const nfs = await import('node:fs')
        const f = expand(this.host, p)
        if (!nfs.existsSync(f)) return []
        return nfs.readdirSync(f, { withFileTypes: true }).map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other' }))
      }
      async stat(p: string) {
        const nfs = await import('node:fs')
        const f = expand(this.host, p)
        return nfs.existsSync(f) ? { mtimeMs: nfs.statSync(f).mtimeMs, size: nfs.statSync(f).size } : null
      }
      async removePath(p: string) {
        const f = expand(this.host, p)
        inRoot(f)
        W.removed.push({ host: this.host, path: f });
        (await import('node:fs')).rmSync(f, { recursive: true, force: true })
      }
    },
  }
})
// Every host call goes through the test daemons (the transfer resolver): never a real link or ssh.
vi.mock('../../../src/core/hosts/link.js', async (orig) => {
  const real = await orig<Record<string, unknown>>()
  return { ...real, link: async (h: string) => { throw new Error(`no real link to ${h} in this test`) } }
})
// A message into a live session (a follow-up turn): the fake session answers it.
vi.mock('../../../src/core/session-message-queue.js', async (orig) => {
  const real = await orig<Record<string, unknown>>()
  return {
    ...real,
    sendMessageToSession: async (sid: string, text: string) => {
      W.sends.push({ sid, text })
      setTimeout(() => W.onSend?.(sid, text), 20)
      return { id: null }
    },
  }
})
// The caller's session as the end notice reaches it (registry.ts tellParent).
vi.mock('../../../src/core/sessions/session-send-core.js', async (orig) => {
  const real = await orig<Record<string, unknown>>()
  return {
    ...real,
    // As the message queue does: a row whose id is queued already is that row (a second notice under the same id is lost).
    deliverToSession: async (target: { claudeSessionId: string }, o: { busText: string; messageId?: string }) => {
      if (!o.messageId || !W.delivered.some((d) => d.messageId === o.messageId)) W.delivered.push({ sid: target.claudeSessionId, text: o.busText, messageId: o.messageId })
      return { delivery: 'queued' }
    },
  }
})
vi.mock('../../../src/core/sessions/session-lifecycle.js', () => ({
  terminateSession: async (sid: string) => { W.stops.push(sid); return { status: W.stopUnconfirmed ? 'pending' : 'terminated', sessionId: sid } },
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { addTask } from '../../../src/core/task-manager.js'
import { closeDb as closeTaskDb } from '../../../src/core/task-db.js'
import { closeDb as closeSessionDb } from '../../../src/core/session-db.js'
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../../src/core/session-tracker.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import { __setTransferConnectionResolverForTesting, type TransferConn } from '../../../src/core/transfer/daemon-transfer-client.js'
import { createTransferPack, type TransferPackDeps } from '../../../src/providers/transfer-pack-core.js'
import { createTransferCore, type TransferCoreDeps } from '../../../src/providers/transfer-core.js'
import { recordRepoPath, repoKey } from '../../../src/core/hosts/host-profile.js'
import { _closeOrphansForTest, _resetLightSubagentsForTest, _setKeepIdleMsForTest, _setLightRunnerForTest, _skipEngineCheckForTest, lightSubagentRows, lightSubagentSettled, markTold, sendLightSubagent, startLightSubagent, waitLightSubagent, stopLightSubagent, getLightSubagent } from '../../../src/core/subagents/registry.js'
import { _setSubagentStarterForTest, _setLateStopCheckMsForTest, SUBAGENT_LANE_PREFIX } from '../../../src/core/subagents/on-host.js'
import { canonicalCallerSid } from '../../../src/core/sessions/acp-caller-sid.js'
import { grant, revokeGrant, findGrant } from '../../../src/core/hosts/exec-grants.js'
import { listLeftRuns, noteLeft, sweepLeftRuns } from '../../../src/core/subagents/left-runs.js'

const gitconfig = path.join(W.root, 'gitconfig')
fs.writeFileSync(gitconfig, '[user]\n\tname = Caller\n\temail = caller@example.com\n[init]\n\tdefaultBranch = main\n')
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: W.root, TMPDIR: W.root, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' }
const URL = 'https://example.invalid/acme/marina.git'
const guardedSpawn = ((cmd: string, args: string[], o: Record<string, unknown>) => {
  if (o.cwd && !String(o.cwd).startsWith(W.root)) throw new Error('spawn outside the test root: ' + String(o.cwd))
  return spawn(cmd, args, o)
})

/** One host's daemon: the real move cores over that host's home, plus the file reads host_copy makes. */
function daemonFor(host: string): TransferConn {
  const home = W.homes[host]!
  const pack = createTransferPack({ fs, path, crypto, spawn: guardedSpawn as unknown as TransferPackDeps['spawn'], env, home })
  const core = createTransferCore({ fs, path, crypto, spawn: guardedSpawn as unknown as TransferCoreDeps['spawn'], env, home })
  const expand = (p: string) => (p.startsWith('~/') ? `${home}${p.slice(1)}` : p)
  const answer = async (fn: () => Promise<unknown>) => {
    try { return { ok: true, ...(await fn() as Record<string, unknown>) } } catch (err) {
      const e = err as Error & { code?: string; data?: Record<string, unknown> }
      return { ok: false, error: e.message, code: e.code ?? 'failed', ...(e.data ?? {}) }
    }
  }
  return {
    hasCapability: () => true,
    send: async (cmd, p) => {
      switch (cmd) {
        case 'transfer.pack': return answer(() => pack.pack(p))
        case 'transfer.scan': return answer(() => pack.scan(p))
        case 'transfer.apply': return answer(() => pack.apply(p))
        case 'transfer.recent': return answer(() => pack.recent(p))
        case 'fs.writePart': return answer(() => core.writePart(p, { boundHome: null, origin: null }))
        case 'fs.find': {
          // ~/.claude/projects/<slug>/<sid>.jsonl, as Claude Code keeps a transcript.
          const root = expand(String(p.path))
          const files = fs.existsSync(root) ? fs.readdirSync(root).map((d) => path.join(root, d, String(p.name))).filter((f) => fs.existsSync(f)) : []
          return { ok: true, files }
        }
        case 'fs.rm': { fs.rmSync(expand(String(p.path)), { force: true }); return { ok: true } }
        case 'fs.readRange': {
          const f = expand(String(p.path))
          if (!fs.existsSync(f)) return { ok: false, error: `fs.readRange failed: ENOENT ${f}` }
          if (!fs.statSync(f).isFile()) return { ok: false, error: `fs.readRange failed: ENOTFILE ${f}` }
          const buf = fs.readFileSync(f)
          const start = Number(p.start); const len = Number(p.length)
          const part = buf.subarray(start, start + len)
          return { ok: true, data: part.toString('base64'), bytesRead: part.length, fileSize: buf.length }
        }
        default: return { ok: false, error: `${cmd} is not in this test daemon`, code: 'unknown' }
      }
    },
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitChildEnv(env), stdio: 'pipe' }).toString('utf8').trim()
}
function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
/** Every file under `dir`, relative, sorted (`.git` left out). */
function tree(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(path.relative(dir, p))
    }
  }
  walk(dir)
  return out.sort()
}

let checkout = ''
/** The caller's checkout on this machine (a commit the remote lacks, an edit, an untracked file), and the cloud's own checkout. */
function world(): { checkout: string; cloudCheckout: string } {
  const base = path.join(W.root, 'world')
  fs.rmSync(base, { recursive: true, force: true })
  const bare = path.join(base, 'remote.git')
  checkout = path.join(base, 'mac-workplace', 'marina')
  const cloudCheckout = path.join(base, 'cloud-workplace', 'marina')
  fs.mkdirSync(path.dirname(checkout), { recursive: true })
  fs.mkdirSync(path.dirname(cloudCheckout), { recursive: true })
  execFileSync('git', ['init', '-q', '--bare', bare], { env: gitChildEnv(env) })
  git(path.dirname(checkout), ['clone', '-q', bare, checkout])
  write(path.join(checkout, 'a.txt'), 'a1\n')
  write(path.join(checkout, 'src', 'b.txt'), 'b1\n')
  git(checkout, ['add', '-A'])
  git(checkout, ['commit', '-q', '-m', 'base'])
  git(checkout, ['push', '-q', 'origin', 'main'])
  git(path.dirname(cloudCheckout), ['clone', '-q', bare, cloudCheckout])
  git(checkout, ['remote', 'set-url', 'origin', URL])
  git(checkout, ['checkout', '-q', '-b', 'wt/ui-fix'])
  write(path.join(checkout, 'feature.txt'), 'f1\n')
  git(checkout, ['add', '-A'])
  git(checkout, ['commit', '-q', '-m', 'the caller\'s commit'])
  // Not committed, not staged: the change the UI test is about.
  write(path.join(checkout, 'src', 'b.txt'), 'b edited, not committed\n')
  write(path.join(checkout, 'notes', 'scratch.txt'), 'untracked\n')
  return { checkout, cloudCheckout }
}

const SID = '5ab0a6e1-aaaa-4bbb-8ccc-dddddddddd01'
let taskId = ''
/** What each fake subagent session does once started; returns its answer (null: it dies). */
let behave: (start: Record<string, unknown>) => Promise<string | null> = async () => 'done'
const starts: Array<Record<string, unknown>> = []
/** What the copy held when the subagent "ran" (its cwd's files, git status there). */
let seen: { cwd: string; files: string[]; status: string; branch: string; log: string; b: string } | null = null

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  for (const h of Object.values(W.homes)) { fs.rmSync(h, { recursive: true, force: true }); fs.mkdirSync(h, { recursive: true }) }
  W.stops.length = 0; W.removed.length = 0; starts.length = 0; seen = null; W.stopUnconfirmed = false; W.sends.length = 0; W.delivered.length = 0
  behave = async () => 'done'
  // A follow-up into the fake session: it answers with what it was told.
  W.onSend = (sid, text) => bus.emit(EventNames.SESSION_RESULT, { sessionId: sid, result: `heard: ${text}`, isError: false }, ['main-ai'], { source: 'test' })
  __setTransferConnectionResolverForTesting(async (host) => (W.homes[host] ? [daemonFor(host)] : []))
  _skipEngineCheckForTest(true)
  _setLateStopCheckMsForTest(50)
  const { cloudCheckout } = world()
  await recordRepoPath('cloud', repoKey(URL, 'marina'), cloudCheckout)
  taskId = (await addTask({ title: 'Fix the panel', project: 'Marina' } as never)).task.id
  // The task's grant on the other host (host_exec's), as the user gives it once per task and host.
  await grant(taskId, 'cloud', 'settings')
  await createSessionRecord(SID, taskId, 'Marina', checkout, { mode: 'bypass' })
  _setSubagentStarterForTest((start) => {
    starts.push(start)
    void (async () => {
      const cwd = String(start.cwd)
      seen = {
        cwd, files: tree(cwd), status: execFileSync('git', ['status', '--porcelain'], { cwd, env: gitChildEnv(env) }).toString('utf8'), branch: git(cwd, ['branch', '--show-current']),
        log: git(cwd, ['log', '--format=%s']), b: fs.readFileSync(path.join(cwd, 'src', 'b.txt'), 'utf8'),
      }
      const home = W.homes[start.host ? String(start.host) : '__local__']!
      let sessionId = String(start.preassignedSessionId ?? '')
      if (start.engine === 'claude') {
        // What Claude Code keeps of a session in a folder: its project folder (slug of the path), file history, session env.
        const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-')
        write(path.join(home, '.claude', 'projects', slug, `${sessionId}.jsonl`), '{}\n')
        write(path.join(home, '.claude', 'projects', slug, sessionId, 'subagents', 'agent-1.jsonl'), '{}\n')
        write(path.join(home, '.claude', 'file-history', sessionId, 'f1'), 'x')
        write(path.join(home, '.claude', 'session-env', sessionId, 'env'), 'x')
      } else {
        // An ACP engine names its own session at establish, under the lane it was started in (acp-session.ts).
        sessionId = `acp-provider-${crypto.randomUUID()}`
        await createSessionRecord(sessionId, '', '', cwd, { lane: String(start.lane), mode: start.mode as never, ...(start.host ? { host: String(start.host) } : {}) })
        await updateSessionRecord(sessionId, { acpRuntimeId: `acp-rt-${sessionId}` } as never)
      }
      const text = await behave(start)
      if (text === null) bus.emit(EventNames.SESSION_ERROR, { sessionId, error: 'the CLI died' }, ['main-ai'], { source: 'test' })
      else bus.emit(EventNames.SESSION_RESULT, { sessionId, result: text, isError: false }, ['main-ai'], { source: 'test' })
    })()
  })
})

afterEach(async () => {
  _setSubagentStarterForTest(null)
  _setKeepIdleMsForTest(null)
  _skipEngineCheckForTest(false)
  _resetLightSubagentsForTest()
  __setTransferConnectionResolverForTesting(null)
  await new Promise((r) => setTimeout(r, 30))
  closeTaskDb(); closeSessionDb()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
})
afterAll(() => { if (W.root.includes('walnut-subagent-host-')) fs.rmSync(W.root, { recursive: true, force: true }) })

/** What a host holds of runs now: the transfers folder's entries, and Claude Code's own per-session files. */
function cloudRunDirs(host = 'cloud'): string[] {
  const dir = path.join(W.homes[host]!, '.open-walnut-transfers')
  const claude = ['projects', 'file-history', 'session-env'].flatMap((d) => {
    const f = path.join(W.homes[host]!, '.claude', d)
    return fs.existsSync(f) ? fs.readdirSync(f).map((e) => `.claude/${d}/${e}`) : []
  })
  return [...(fs.existsSync(dir) ? fs.readdirSync(dir) : []), ...claude]
}
/** The caller's host's transfers folder (beside this server's data). */
function localRunDirs(): string[] {
  const dir = `${WALNUT_HOME.replace(/\/+$/, '')}-transfers`
  return fs.existsSync(dir) ? fs.readdirSync(dir) : []
}

/** Run one prompt to its answer, then close the subagent (it would stay open for more messages). */
async function runToEnd(prompt: string, more: { cwd?: string } = {}): Promise<ReturnType<typeof getLightSubagent>> {
  const run = await startLightSubagent(SID, { host: 'cloud', prompt, ...more })
  await waitLightSubagent(run, 60_000)
  if (!getLightSubagent(SID, run.id).closed) stopLightSubagent(SID, run.id, 'the test')
  await lightSubagentSettled(run.id)
  // Its end reached its caller here: no notification goes into the session after the test.
  markTold(getLightSubagent(SID, run.id))
  return getLightSubagent(SID, run.id)
}

describe('subagent_run on another host', () => {
  it('works in a copy of the caller\'s work there, brings its files back, and leaves nothing behind', async () => {
    // A file on the host the run did not make (written a day before it).
    write(path.join(W.root, 'elsewhere', 'secret.txt'), 'not the run\'s')
    fs.utimesSync(path.join(W.root, 'elsewhere', 'secret.txt'), new Date(Date.now() - 86_400_000), new Date(Date.now() - 86_400_000))
    const before = { files: tree(checkout), status: git(checkout, ['status', '--porcelain']), head: git(checkout, ['rev-parse', 'HEAD']) }
    behave = async (start) => {
      const cwd = String(start.cwd)
      const out = /put .* in (\S+?), or name/i.exec(String(start.message))?.[1]
      expect(out).toBeTruthy()
      write(path.join(out!, 'video.mp4'), 'mp4 bytes')
      write(path.join(out!, 'shots', 'video.mp4'), 'a second video of the same name')
      write(path.join(cwd, 'test-results', 'report.txt'), 'all green')
      return `Passed. The report is ${path.join(cwd, 'test-results', 'report.txt')}. I also read ${path.join(W.root, 'elsewhere', 'secret.txt')}.`
    }
    const run = await runToEnd('Run the panel spec in WebKit and return the video.')
    expect(run.status, run.error).toBe('completed')

    // The copy held the caller's branch and commit, its uncommitted edit (still uncommitted) and its untracked file.
    expect(seen!.cwd.startsWith(path.join(W.homes.cloud, '.open-walnut-transfers'))).toBe(true)
    expect(seen!.branch).toBe('wt/ui-fix')
    expect(seen!.log.split('\n')[0]).toBe('the caller\'s commit')
    expect(seen!.b).toBe('b edited, not committed\n')
    expect(seen!.status).toContain(' M src/b.txt')
    expect(seen!.files).toEqual(expect.arrayContaining(['a.txt', 'feature.txt', 'notes/scratch.txt', 'src/b.txt']))

    // Its files are in the caller's task directory, two of one name kept apart.
    const back = path.join(W.homes.__local__, 'tasks', taskId, 'subagents', run.id)
    expect(tree(back)).toEqual(['report.txt', 'video-2.mp4', 'video.mp4'])
    expect(run.files.map((f) => path.basename(f.to)).sort()).toEqual(['report.txt', 'video-2.mp4', 'video.mp4'])
    expect(run.answer).toContain('Files copied back to this machine')
    expect(run.answer).toContain(path.join(back, 'report.txt'))
    // A file the answer names outside the run's own folder stays where it is, named.
    expect(run.answer).toContain('Not copied back (outside the run\'s own folder, and not written by it)')

    // Nothing of the run is left on the other host (its copy, Claude Code's files of its session), nor its packs here.
    expect(cloudRunDirs()).toEqual([])
    expect(localRunDirs()).toEqual([])
    expect(listLeftRuns()).toEqual([])
    expect(W.stops).toEqual([starts[0]!.preassignedSessionId])
    expect((await getSessionByClaudeId(String(starts[0]!.preassignedSessionId)))?.archived).toBe(true)
    // The caller's own folder is exactly as it was.
    expect({ files: tree(checkout), status: git(checkout, ['status', '--porcelain']), head: git(checkout, ['rev-parse', 'HEAD']) }).toEqual(before)
  }, 90_000)

  it('copies the folder `cwd` names, not the session\'s start folder, and brings a file named by two spellings back once', async () => {
    // The session started in its task folder; its work (with the uncommitted edit) is a clone elsewhere.
    const started = path.join(W.homes.__local__, 'tasks', taskId)
    fs.mkdirSync(started, { recursive: true })
    await updateSessionRecord(SID, { cwd: started } as never)
    // The other host reaches its home by a second path too (clouddev: /home is a link to /local/home).
    const alias = path.join(W.root, 'cloud-home-link')
    fs.rmSync(alias, { force: true })
    fs.symlinkSync(W.homes.cloud, alias)
    behave = async (start) => {
      const out = /put .* in (\S+?), or name/i.exec(String(start.message))?.[1]!
      write(path.join(out, 'video.mp4'), 'mp4 bytes')
      const viaLink = out.replace(W.homes.cloud, alias)
      return `Video: ${path.join(out, 'video.mp4')} (also ${path.join(viaLink, 'video.mp4')}).`
    }
    const run = await runToEnd('Run the spec.', { cwd: checkout })
    expect(run.status, run.error).toBe('completed')
    expect(seen!.b).toBe('b edited, not committed\n')
    expect(seen!.status).toContain(' M src/b.txt')
    const back = path.join(W.homes.__local__, 'tasks', taskId, 'subagents', run.id)
    expect(tree(back)).toEqual(['video.mp4'])
    expect(cloudRunDirs()).toEqual([])
    expect(listLeftRuns()).toEqual([])
  }, 90_000)

  it('refuses a cwd that is not an absolute path', async () => {
    await expect(startLightSubagent(SID, { host: 'cloud', prompt: 'x', cwd: 'relative/dir' })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(startLightSubagent(SID, { host: 'cloud', prompt: 'x', cwd: '/a/../b' })).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('starts a full task session there: no profile, the caller\'s full access, the CLI\'s own model', async () => {
    const run = await runToEnd('Check it.')
    expect(run.status, run.error).toBe('completed')
    const start = starts[0]!
    // A profile is the only way a session is cut down (slim settings, --tools, --allowedTools, a replaced prompt).
    expect(start).not.toHaveProperty('profile')
    expect(start).not.toHaveProperty('appendSystemPromptExact')
    expect(start).not.toHaveProperty('model')
    expect(start).toMatchObject({ taskId: '', host: 'cloud', engine: 'claude', mode: 'bypass' })
    expect(String(start.lane).startsWith(SUBAGENT_LANE_PREFIX)).toBe(true)
    // Its own record is a hidden lane on that host, in the caller's mode.
    const rec = await getSessionByClaudeId(String(start.preassignedSessionId))
    expect(rec).toMatchObject({ host: 'cloud', mode: 'bypass', lane: start.lane })
    expect(rec?.taskId ?? '').toBe('')
  }, 90_000)

  it('its walnut calls act for the caller while it runs, and stop doing so when it ends', async () => {
    let during = ''
    behave = async (start) => { during = canonicalCallerSid(String(start.preassignedSessionId)); return 'ok' }
    const run = await runToEnd('Who am I?')
    expect(run.status, run.error).toBe('completed')
    expect(during).toBe(SID)
    const sid = String(starts[0]!.preassignedSessionId)
    expect(canonicalCallerSid(sid)).toBe(sid)
  }, 90_000)

  it('leaves nothing behind when its session dies', async () => {
    behave = async () => null
    const run = await runToEnd('Crash.')
    expect(run.status).toBe('failed')
    expect(cloudRunDirs()).toEqual([])
    expect(W.stops.length).toBe(1)
  }, 90_000)

  it('leaves nothing behind when it is stopped mid-run', async () => {
    let release!: () => void
    behave = () => new Promise<string>((resolve) => { release = () => resolve('late') })
    const run = await startLightSubagent(SID, { host: 'cloud', prompt: 'Hold.' })
    for (let i = 0; i < 400 && starts.length === 0; i++) await new Promise((r) => setTimeout(r, 50))
    expect(starts.length).toBe(1)
    expect(cloudRunDirs().filter((d) => d.startsWith('xf-')).length).toBe(1)
    stopLightSubagent(SID, run.id, 'the user')
    release()
    await lightSubagentSettled(run.id)
    markTold(getLightSubagent(SID, run.id))
    expect(getLightSubagent(SID, run.id).status).toBe('stopped')
    expect(cloudRunDirs()).toEqual([])
    expect(W.stops).toContain(starts[0]!.preassignedSessionId)
  }, 90_000)

  it('leaves nothing behind when it is stopped while the work is still being copied', async () => {
    const run = await startLightSubagent(SID, { host: 'cloud', prompt: 'Too late.' })
    stopLightSubagent(SID, run.id, 'the user')
    await lightSubagentSettled(run.id)
    markTold(getLightSubagent(SID, run.id))
    expect(starts).toEqual([])
    expect(cloudRunDirs()).toEqual([])
    expect(localRunDirs()).toEqual([])
    expect(listLeftRuns()).toEqual([])
  }, 90_000)

  it('keeps its session for the sweep when its host does not confirm the stop, and still answers', async () => {
    W.stopUnconfirmed = true
    behave = async () => 'answered'
    const run = await runToEnd('Answer.')
    expect(run.status, run.error).toBe('completed')
    expect(run.answer).toBe('answered')
    // The copy is gone; the session stays named for the sweep.
    expect(cloudRunDirs().filter((d) => d.startsWith('xf-'))).toEqual([])
    expect(listLeftRuns().map((r) => r.sessionId)).toEqual([starts[0]!.preassignedSessionId])
    W.stopUnconfirmed = false
    expect(await sweepLeftRuns(() => false)).toBe(1)
    expect(listLeftRuns()).toEqual([])
  }, 90_000)

  it('starts nothing there when the user revokes the grant while the work is being copied', async () => {
    const run = await startLightSubagent(SID, { host: 'cloud', prompt: 'Revoked.' })
    await revokeGrant(findGrant(taskId, 'cloud')!.id)
    await lightSubagentSettled(run.id)
    const ended = getLightSubagent(SID, run.id)
    markTold(ended)
    expect(ended.status).toBe('failed')
    expect(ended.errorCode).toBe('exec_grant_revoked')
    expect(starts).toEqual([])
    expect(cloudRunDirs()).toEqual([])
    expect(listLeftRuns()).toEqual([])
  }, 90_000)

  it('cleans up after a run this server never finished (a restart): its session, its copy, its packs', async () => {
    // What a run held when the server stopped mid-run: its copy there, its packs here, its live session.
    const entry = `xf-${crypto.randomUUID()}`
    const copyDir = path.join(W.homes.cloud, '.open-walnut-transfers', entry)
    write(path.join(copyDir, 'work', 'marina', 'a.txt'), 'x')
    const packDir = `${WALNUT_HOME.replace(/\/+$/, '')}-transfers/${entry}`
    write(path.join(packDir, '0', 'pack', 'meta.json'), '{}')
    const sid = crypto.randomUUID()
    await createSessionRecord(sid, '', '', path.join(copyDir, 'work', 'marina'), { lane: `${SUBAGENT_LANE_PREFIX}lsa-x`, host: 'cloud', mode: 'bypass' })
    await noteLeft('sa-gone00001', { dir: { host: 'cloud', dir: `~/.open-walnut-transfers/${entry}` } })
    await noteLeft('sa-gone00001', { dir: { host: '__local__', dir: packDir } })
    await noteLeft('sa-gone00001', { sessionId: sid, sessionCwd: path.join(copyDir, 'work', 'marina') })
    // A run still live is left alone.
    await noteLeft('sa-live00001', { dir: { host: 'cloud', dir: '~/.open-walnut-transfers/xf-00000000-0000-4000-8000-000000000000' } })
    expect(await sweepLeftRuns((id) => id === 'sa-live00001')).toBe(1)
    expect(fs.existsSync(copyDir)).toBe(false)
    expect(fs.existsSync(packDir)).toBe(false)
    expect(W.stops).toEqual([sid])
    expect((await getSessionByClaudeId(sid))?.archived).toBe(true)
    expect(listLeftRuns().map((r) => r.id)).toEqual(['sa-live00001'])
  }, 30_000)

  it('runs on the caller\'s own host as without one when host names it', async () => {
    _setLightRunnerForTest(async (spec) => ({ answer: `ran in ${spec.cwd} on ${spec.host}${spec.away ? ' away' : ''}`, warnings: [] }))
    try {
      const run = await startLightSubagent(SID, { host: '__local__', prompt: 'Here.', engine: 'codex' })
      await waitLightSubagent(run, 10_000)
      expect(run.fromHost).toBeUndefined()
      expect(getLightSubagent(SID, run.id).answer).toBe(`ran in ${checkout} on __local__`)
      stopLightSubagent(SID, run.id, 'the test')
      await lightSubagentSettled(run.id)
      markTold(getLightSubagent(SID, run.id))
    } finally { _setLightRunnerForTest(null) }
  })

  it('stays open after its answer: a follow-up goes into the same session, keeps the copy, and answers; closing it then leaves nothing', async () => {
    behave = async (start) => {
      const out = /put .* in (\S+?), or name/i.exec(String(start.message))?.[1]!
      write(path.join(out, 'first.txt'), 'turn 1')
      return 'first answer'
    }
    const run = await startLightSubagent(SID, { host: 'cloud', prompt: 'Start.' })
    await waitLightSubagent(run, 60_000)
    expect(run.status, run.error).toBe('completed')
    expect(run.answer).toContain('first answer')
    const sid = String(starts[0]!.preassignedSessionId)
    // Still open: its session lives (no stop yet), its copy is still there, the panel row names its session.
    expect(W.stops).toEqual([])
    expect(cloudRunDirs().filter((d) => d.startsWith('xf-')).length).toBe(1)
    expect(lightSubagentRows(SID)[0]).toMatchObject({ walnutSessionId: sid, host: 'cloud', engine: 'claude', taskType: 'walnut_subagent' })
    expect(canonicalCallerSid(sid)).toBe(SID)
    // The follow-up: a message into the SAME session (no second start), with its answer back.
    const { turn } = sendLightSubagent(SID, run.id, { message: 'And now the second part.' })
    expect(turn).toBe(2)
    await waitLightSubagent(run, 60_000, turn)
    expect(run.status, run.error).toBe('completed')
    expect(run.answer).toBe('heard: And now the second part.')
    expect(starts.length).toBe(1)
    expect(W.sends.filter((m) => m.sid === sid).map((m) => m.text)).toEqual(['And now the second part.'])
    // The file of turn 1 came back once, not again with turn 2.
    expect(tree(path.join(W.homes.__local__, 'tasks', taskId, 'subagents', run.id))).toEqual(['first.txt'])
    markTold(run)
    // Closing it removes everything, and its calls no longer act for the caller.
    stopLightSubagent(SID, run.id, 'the test')
    await lightSubagentSettled(run.id)
    expect(getLightSubagent(SID, run.id).closed).toBe(true)
    expect(W.stops).toEqual([sid])
    expect(cloudRunDirs()).toEqual([])
    expect(listLeftRuns()).toEqual([])
    expect(canonicalCallerSid(sid)).toBe(sid)
    expect(lightSubagentRows(SID)[0]).toMatchObject({ closed: true })
    expect(lightSubagentRows(SID)[0]).not.toHaveProperty('walnutSessionId')
    // A closed subagent takes no more messages.
    expect(() => sendLightSubagent(SID, run.id, { message: 'Still there?' })).toThrow(expect.objectContaining({ code: 'closed' }))
  }, 90_000)

  it('a message sent while it is still answering waits for that answer, and each answer reaches the caller as it was', async () => {
    await updateSessionRecord(SID, { process_status: 'idle' } as never)
    let release!: () => void
    behave = () => new Promise<string>((resolve) => { release = () => resolve('first, late') })
    const run = await startLightSubagent(SID, { host: 'cloud', prompt: 'Long one.', background: true })
    for (let i = 0; i < 400 && starts.length === 0; i++) await new Promise((r) => setTimeout(r, 50))
    const { turn } = sendLightSubagent(SID, run.id, { message: 'Then this.' })
    // Not sent: the first turn still runs (the message goes only after its answer, checked below).
    expect(run.status).toBe('running')
    expect(W.sends).toEqual([])
    release()
    await waitLightSubagent(run, 60_000, 1)
    await waitLightSubagent(run, 60_000, turn)
    expect(run.answer).toBe('heard: Then this.')
    expect(W.sends.map((m) => m.text)).toEqual(['Then this.'])
    // Nothing returned either answer: each came to the caller by itself, as it was when its turn ended
    // (never the next turn's state), each under its own id.
    const mine = () => W.delivered.filter((d) => d.messageId?.startsWith(`sa-end-${run.id}-`))
    for (let i = 0; i < 300 && mine().length < 2; i++) await new Promise((r) => setTimeout(r, 50))
    expect(mine().map((d) => d.messageId)).toEqual([`sa-end-${run.id}-1`, `sa-end-${run.id}-2`])
    expect(mine()[0]!.text).toContain('first, late')
    expect(mine()[0]!.text).not.toMatch(/failed|closed/i)
    expect(mine()[1]!.text).toContain('heard: Then this.')
    stopLightSubagent(SID, run.id, 'the test')
    await lightSubagentSettled(run.id)
    expect(cloudRunDirs()).toEqual([])
  }, 90_000)

  it('a read while a later turn runs never takes an earlier turn\'s answer from the caller', async () => {
    await updateSessionRecord(SID, { process_status: 'idle' } as never)
    let releaseThird!: () => void
    W.onSend = (sid, text) => {
      const answer = () => bus.emit(EventNames.SESSION_RESULT, { sessionId: sid, result: `heard: ${text}`, isError: false }, ['main-ai'], { source: 'test' })
      if (text === 'Third.') releaseThird = answer
      else answer()
    }
    const run = await startLightSubagent(SID, { host: 'cloud', prompt: 'First.', background: true })
    await waitLightSubagent(run, 60_000, 1)
    sendLightSubagent(SID, run.id, { message: 'Second.' })
    sendLightSubagent(SID, run.id, { message: 'Third.' })
    await waitLightSubagent(run, 60_000, 2)
    for (let i = 0; i < 100 && run.status !== 'running'; i++) await new Promise((r) => setTimeout(r, 10))
    // Turn 3 runs now: a look at the run (as subagent_read does) marks nothing of turn 2.
    expect(run.status).toBe('running')
    markTold(run)
    const mine = () => W.delivered.filter((d) => d.messageId?.startsWith(`sa-end-${run.id}-`))
    for (let i = 0; i < 300 && mine().length < 2; i++) await new Promise((r) => setTimeout(r, 50))
    expect(mine().map((d) => d.messageId)).toEqual([`sa-end-${run.id}-1`, `sa-end-${run.id}-2`])
    expect(mine()[1]!.text).toContain('heard: Second.')
    for (let i = 0; i < 100 && !releaseThird; i++) await new Promise((r) => setTimeout(r, 50))
    releaseThird()
    await waitLightSubagent(run, 60_000, 3)
    stopLightSubagent(SID, run.id, 'the test')
    await lightSubagentSettled(run.id)
    expect(cloudRunDirs()).toEqual([])
  }, 90_000)

  it('is closed by itself after its idle time, and when its caller\'s session is gone', async () => {
    _setKeepIdleMsForTest(300)
    const idle = await startLightSubagent(SID, { host: 'cloud', prompt: 'Idle.' })
    await waitLightSubagent(idle, 60_000)
    markTold(idle)
    await lightSubagentSettled(idle.id)
    expect(getLightSubagent(SID, idle.id).closed).toBe(true)
    expect(cloudRunDirs()).toEqual([])
    _setKeepIdleMsForTest(null)
    const orphan = await startLightSubagent(SID, { host: 'cloud', prompt: 'Orphan.' })
    await waitLightSubagent(orphan, 60_000)
    markTold(orphan)
    await _closeOrphansForTest()
    expect(getLightSubagent(SID, orphan.id).closed).toBe(false)
    await updateSessionRecord(SID, { archived: true } as never)
    await _closeOrphansForTest()
    await lightSubagentSettled(orphan.id)
    expect(getLightSubagent(SID, orphan.id).closed).toBe(true)
    expect(cloudRunDirs()).toEqual([])
    expect(listLeftRuns()).toEqual([])
  }, 90_000)

  it('without host: a session of its own on the caller\'s host, in the caller\'s folder, with nothing copied', async () => {
    const run = await startLightSubagent(SID, { prompt: 'Here.' })
    await waitLightSubagent(run, 60_000)
    expect(run.status, run.error).toBe('completed')
    expect(starts[0]).toMatchObject({ taskId: '', engine: 'claude', cwd: checkout, mode: 'bypass' })
    expect(starts[0]).not.toHaveProperty('host')
    expect(cloudRunDirs()).toEqual([])
    expect(localRunDirs()).toEqual([])
    markTold(run)
    stopLightSubagent(SID, run.id, 'the test')
    await lightSubagentSettled(run.id)
    const sid = String(starts[0]!.preassignedSessionId)
    expect(W.stops).toEqual([sid])
    // Its own files are gone; the caller's folder's project folder (its own sessions') stays.
    const left = execFileSync('find', [path.join(W.homes.__local__, '.claude')], { encoding: 'utf8' }).split('\n').filter((f) => f.includes(sid))
    expect(left).toEqual([])
  }, 90_000)

  it('on another engine: the same hidden session, started on that engine, its own session id taken from its record', async () => {
    const run = await startLightSubagent(SID, { host: 'cloud', engine: 'codex', prompt: 'On Codex.' })
    await waitLightSubagent(run, 60_000)
    expect(run.status, run.error).toBe('completed')
    expect(starts[0]).toMatchObject({ engine: 'codex', host: 'cloud', taskId: '' })
    expect(starts[0]).not.toHaveProperty('preassignedSessionId')
    const sid = String(lightSubagentRows(SID)[0]!.walnutSessionId)
    expect(sid.startsWith('acp-provider-')).toBe(true)
    // Its calls act for the caller, by its record id and by the runtime id the daemon knows it by.
    expect(canonicalCallerSid(sid)).toBe(SID)
    expect(canonicalCallerSid(`acp-rt-${sid}`)).toBe(SID)
    const { turn } = sendLightSubagent(SID, run.id, { message: 'More.' })
    await waitLightSubagent(run, 60_000, turn)
    expect(run.answer).toBe('heard: More.')
    markTold(run)
    stopLightSubagent(SID, run.id, 'the test')
    await lightSubagentSettled(run.id)
    expect(W.stops).toEqual([sid])
    expect(cloudRunDirs()).toEqual([])
  }, 90_000)

  it('NO POLLING: a background run\'s answer reaches the idle caller by itself, and nothing tells it to read or wait', async () => {
    await updateSessionRecord(SID, { process_status: 'idle' } as never)
    const run = await startLightSubagent(SID, { host: 'cloud', prompt: 'In the background.', background: true })
    expect(run.status).toBe('running')
    const mine = () => W.delivered.filter((d) => d.messageId?.startsWith(`sa-end-${run.id}-`))
    for (let i = 0; i < 300 && mine().length === 0; i++) await new Promise((r) => setTimeout(r, 50))
    // Its answer went into the caller's session with no read of it: the only way it learns of it.
    expect(mine().map((d) => d.sid)).toEqual([SID])
    expect(mine()[0]!.text).toContain('done')
    expect(mine()[0]!.text).toContain('subagent_send')
    expect(mine()[0]!.text).not.toMatch(/subagent_read|wait_ms/)
    // And a follow-up's answer comes back the same way.
    const { turn } = sendLightSubagent(SID, run.id, { message: 'Again.' })
    for (let i = 0; i < 300 && mine().length < 2; i++) await new Promise((r) => setTimeout(r, 50))
    expect(turn).toBe(2)
    expect(mine()[1]!.text).toContain('heard: Again.')
    stopLightSubagent(SID, run.id, 'the test')
    await lightSubagentSettled(run.id)
  }, 90_000)

  it('refuses a host Walnut does not know before anything moves', async () => {
    await expect(startLightSubagent(SID, { host: 'nowhere', prompt: 'x' })).rejects.toMatchObject({ code: 'unknown_host' })
    expect(cloudRunDirs()).toEqual([])
  })
})
