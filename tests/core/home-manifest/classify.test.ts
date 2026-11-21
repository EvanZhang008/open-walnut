/**
 * classifyHomePath and friends (src/core/home-manifest/): the prefix rules, sqlite
 * siblings, copies beside a file, the leader-data ledger inside cache/, the
 * sensitive flag, the unknown-name default, and the entries' own consistency.
 */
import { describe, expect, it } from 'vitest'
import {
  classifyHomePath, classifyOutsideAbsolute, classifyOutsidePath, homeEntries, homePathClass,
  isUnnamedHomePath, outsideHomeEntries, UNKNOWN_HOME_PATH_CLASS,
} from '../../../src/core/home-manifest/index.js'
import { EXCLUDED_DIRS } from '../../../src/core/backup/scan.js'

const id = (rel: string) => classifyHomePath(rel)?.id
const cls = (rel: string) => homePathClass(rel)

describe('classifyHomePath', () => {
  it('matches an exact entry and inherits a classified dir', () => {
    expect(id('tasks')).toBe('tasks')
    expect(id('tasks/archive/2026-01.json')).toBe('tasks')
    expect(id('memory/daily/2026-11-21.md')).toBe('memory')
  })

  it('prefers the longest path', () => {
    expect(id('tasks/tasks.sqlite')).toBe('tasks.db')
    expect(id('org/threads-backup/x.json')).toBe('org.threads-backup')
    expect(classifyHomePath('org/threads-backup/x.json')?.class).toBe('rebuildable')
    expect(id('org/team-notes.json')).toBe('org')
    expect(id('artifacts/.backup/2026/notes.md')).toBe('artifacts.backup')
  })

  it('matches whole segments only', () => {
    expect(id('tasksx')).toBeUndefined()
    expect(id('tasks.json')).toBeUndefined()
    expect(id('cache-old/x')).toBeUndefined()
  })

  it('owns the -wal, -shm and -journal siblings of a sqlite entry, and only those', () => {
    for (const s of ['', '-wal', '-shm', '-journal']) expect(id(`sessions.sqlite${s}`)).toBe('sessions-db')
    expect(id('sessions.sqlite-other')).toBeUndefined()
    expect(id('cache/applied-ops.sqlite-wal')).toBe('cache.applied-ops')
    expect(id('search.sqlite-shm')).toBe('search-index')
  })

  it('keeps the ledgers and queue state in cache/ as leader data', () => {
    for (const rel of [
      'cache/applied-ops.sqlite', 'cache/status-riding.json', 'cache/status-reconcile.json', 'cache/task-dir-size-notices.json',
      'cache/suggest-accuracy.jsonl', 'cache/engine-split.json', 'cache/work-card.json', 'cache/host-fix-failures.json',
      'cache/agent-actions.json', 'cache/agent-action-salt.json',
    ]) expect(cls(rel), rel).toBe('leader-data')
    expect(cls('cache/history/abc.json')).toBe('rebuildable')
    expect(cls('cache/task-queue/op-1.json')).toBe('machine')
    expect(cls('cache/companion-bases.sqlite')).toBe('machine')
    expect(cls('cache/walnut-activity-v5.srchash')).toBe('machine')
    expect(cls('cache/walnut-extract-v1')).toBe('machine')
    expect(cls('cache/screentime-grant-ok')).toBe('machine')
  })

  it('keeps the only copies in tmp/ as leader data and the rest of it off', () => {
    expect(cls('tmp/file-history/ab12/index.json')).toBe('leader-data')
    expect(cls('tmp/stt-recordings/2026-11-21T10-00-00.webm')).toBe('leader-data')
    expect(cls('tmp/recordings/2026-11-21/chunk-1.wav')).toBe('leader-data')
    expect(cls('tmp/streams/s.jsonl')).toBe('machine')
    expect(cls('tmp/recording-state.json')).toBe('machine')
    expect(cls('tmp/backup-staging-repo/x')).toBe('rebuildable')
    expect(cls('tmp/some-new-scratch')).toBe('rebuildable')
  })

  it('splits sync/ into the leader\'s tokens and cursors and this machine\'s unpairing', () => {
    expect(classifyHomePath('sync/bridge-tokens.json')).toMatchObject({ class: 'leader-data', sensitive: true })
    expect(cls('sync/cloud-unpaired.json')).toBe('machine')
    expect(id('sync/reconcile-tracker.json')).toBe('sync.reconcile')
    expect(cls('sync/reconcile-tracker.json')).toBe('leader-data')
    expect(isUnnamedHomePath('sync/brand-new.json')).toBe(true)
  })

  it('keeps the data repo as leader data: it is the only history without a data remote', () => {
    expect(cls('.git')).toBe('leader-data')
    expect(cls('.git/objects/ab/cdef')).toBe('leader-data')
  })

  it('falls back to a mixed dir only for a child the code does not name', () => {
    expect(id('cache/some-new-thing.json')).toBe('cache')
    expect(isUnnamedHomePath('cache/some-new-thing.json')).toBe(true)
    expect(isUnnamedHomePath('cache')).toBe(false)
    expect(isUnnamedHomePath('cache/history/x')).toBe(false)
    expect(isUnnamedHomePath('My Notes/trip.md')).toBe(true)
    expect(cls('local/unknown.json')).toBe('machine')
  })

  it('separates the machine half of local/backup from the leader half', () => {
    expect(classifyHomePath('local/backup/recovery-key')?.class).toBe('leader-data')
    expect(classifyHomePath('local/backup/machine-id')?.class).toBe('machine')
    expect(classifyHomePath('server.lock.json')?.class).toBe('machine')
  })

  it('classes a copy beside a file like its original', () => {
    expect(id('config.yaml.bak')).toBe('config-yaml')
    expect(id('config.yaml.tmp-123-456')).toBe('config-yaml')
    expect(id('auth.json.unreadable-2026')).toBe('auth')
    expect(id('usage.sqlite.backup-20261101')).toBe('usage-db')
    expect(id('cache/applied-ops.sqlite.backup-1')).toBe('cache.applied-ops')
    expect(id('notes.bak')).toBe('notes')
    expect(id('random.bak')).toBeUndefined()
  })

  it('names only the two dead stores at the top level, so a user\'s x.db stays leader data', () => {
    expect(cls('sessions.db')).toBe('rebuildable')
    expect(cls('tasks.db')).toBe('rebuildable')
    expect(id('recipes.db')).toBeUndefined()
    expect(cls('recipes.db')).toBe('leader-data')
  })

  it('classes Walnut\'s own lock files as machine, and nobody else\'s', () => {
    for (const rel of [
      'tasks/tasks.json.lock', 'tasks/tasks.json.lock/owner/123-ab', 'router/areas/a/items.sqlite.lock/pid',
      'router/areas/a/route.lock/owner', 'artifacts/nodes/t1/skills.lock', 'artifacts/nodes/t1/notes.notes.lock',
      'cron-jobs.json.lock.123-abcd.lock', 'components/.locks/ffmpeg.lock', 'memory/daily/2026-11-21.md.lock',
      'local/backup/run.lock', 'org/x/threads.jsonl.lock',
    ]) {
      expect(id(rel), rel).toMatch(/^(lock-files|local\.backup\.run-lock)$/)
      expect(cls(rel), rel).toBe('machine')
    }
    expect(cls('plugins/x/bun.lock')).toBe('leader-data')
    expect(id('plugins/x/bun.lock')).toBe('plugins')
    expect(id('artifacts/p/Cargo.lock')).toBe('artifacts')
    expect(id('artifacts/p/flake.lock')).toBe('artifacts')
    expect(id('My Notes/yarn.lock')).toBeUndefined()
    expect(cls('My Notes/Gemfile.lock')).toBe('leader-data')
  })

  it('lets a pattern entry win over the dir it sits in', () => {
    expect(id('tasks/tasks.json.lock')).toBe('lock-files')
    expect(id('router/areas/a/items.sqlite.lock/pid')).toBe('lock-files')
    expect(id('memory/.open-walnut-ab12.tmp')).toBe('write-temps')
    expect(id('chat-history-research.json')).toBe('chat-history')
    expect(id('vault/machine-v1-123.json')).toBe('vault-in-home.machine')
  })

  it('flags credentials as sensitive and plain data as not', () => {
    for (const rel of ['auth.json', 'secrets/plugins/x.json', 'config.yaml', 'sync/bridge-tokens.json', 'local/backup/recovery-key', 'vault/vault.json']) {
      expect(classifyHomePath(rel)?.sensitive, rel).toBe(true)
    }
    for (const rel of ['tasks/tasks.sqlite', 'memory/MEMORY.md', 'search.sqlite', 'cache/history/x']) {
      expect(classifyHomePath(rel)?.sensitive, rel).toBe(false)
    }
  })

  it('normalizes slashes and dots', () => {
    expect(id('./tasks/')).toBe('tasks')
    expect(id('cache//task-queue/x')).toBe('cache.task-queue')
    expect(id('tasks///tasks.sqlite')).toBe('tasks.db')
    expect(isUnnamedHomePath('cache//task-queue/x')).toBe(false)
    expect(id('tasks\\tasks.sqlite')).toBe('tasks.db')
    expect(id('')).toBeUndefined()
  })
})

describe('unknown names', () => {
  it('gives a name no entry knows the leader-data default', () => {
    expect(UNKNOWN_HOME_PATH_CLASS).toBe('leader-data')
    expect(homePathClass('My Notes/trip.md')).toBe('leader-data')
    expect(['tasks', 'My Notes', 'cache', 'Untitled 1.md', 'usage.sqlite.backup-1'].filter((n) => !classifyHomePath(n))).toEqual(['My Notes', 'Untitled 1.md'])
  })
})

describe('outside the home', () => {
  const ctx = { env: {}, userHome: '/home/u', daemonDir: '/tmp/open-walnut', claudeHome: '/home/u/.claude' }

  it('splits the vault into the leader\'s vault and this machine\'s key', () => {
    expect(classifyOutsidePath('xdg-state', 'open-walnut/vault/vault.json')?.class).toBe('leader-data')
    expect(classifyOutsidePath('xdg-state', 'open-walnut/vault/machine.json')?.class).toBe('machine')
    // A retired key of an earlier vault (src/core/vault/state.ts setAsideMachine), like the in-home one.
    expect(classifyOutsidePath('xdg-state', 'open-walnut/vault/machine-v_1-1732000000000.json')?.id).toBe('state.vault.machine')
    expect(id('vault/machine-v_1-1732000000000.json')).toBe('vault-in-home.machine')
    expect(classifyOutsidePath('xdg-state', 'open-walnut/vault/backups/vault-2026-11-21.json')?.class).toBe('leader-data')
    expect(classifyOutsidePath('xdg-state', 'open-walnut/secrets-master/x')?.class).toBe('leader-data')
    expect(classifyOutsidePath('xdg-state', 'other-app/x')).toBeUndefined()
  })

  it('resolves absolute paths through the roots, XDG_STATE_HOME included', () => {
    expect(classifyOutsideAbsolute('/home/u/.local/state/open-walnut/tasks/t1/x', ctx)?.id).toBe('state.tasks')
    expect(classifyOutsideAbsolute('/xdg/open-walnut/vault/vault.json', { ...ctx, env: { XDG_STATE_HOME: '/xdg' } })?.id).toBe('state.vault')
    expect(classifyOutsideAbsolute('/home/u/.claude/projects/p/s.jsonl', ctx)?.id).toBe('claude.projects')
    expect(classifyOutsideAbsolute('/tmp/open-walnut/open-walnut-2026-11-21.log', ctx)?.id).toBe('daemon-dir.logs')
    expect(classifyOutsideAbsolute('/tmp/open-walnut/daemon.pid', ctx)?.id).toBe('daemon-dir')
    expect(classifyOutsideAbsolute('/tmp/open-walnut/streams/s.jsonl', ctx)?.id).toBe('daemon-dir.streams')
    expect(classifyOutsideAbsolute('/home/u/Documents/x', ctx)).toBeUndefined()
  })
})

describe('the entries themselves', () => {
  const all = [...homeEntries(), ...outsideHomeEntries()]

  it('have unique ids and unique places', () => {
    const ids = all.map((e) => e.id)
    expect(ids.length).toBe(new Set(ids).size)
    const homePlaces = homeEntries().filter((e) => e.path).map((e) => e.path)
    expect(homePlaces.length).toBe(new Set(homePlaces).size)
    const outsidePlaces = outsideHomeEntries().filter((e) => !e.match).map((e) => `${e.root}:${e.path}`)
    expect(outsidePlaces.length).toBe(new Set(outsidePlaces).size)
  })

  it('are well formed: clean paths, one English line, no dashes as clause separators', () => {
    for (const e of all) {
      expect(e.path, e.id).not.toMatch(/^\/|\/$|\\/)
      expect(e.what.length, e.id).toBeGreaterThan(5)
      expect(e.what, e.id).not.toMatch(/[\u2013\u2014]| - /)
      expect(e.what, e.id).toMatch(/^[\x20-\x7e]+$/)
      if (!e.path) expect(e.match ?? (e.kind === 'dir' ? true : undefined), e.id).toBeTruthy()
    }
  })

  it('nest every nested entry under a classified parent', () => {
    for (const e of homeEntries().filter((x) => x.path.includes('/'))) {
      const parent = classifyHomePath(e.path.split('/').slice(0, -1).join('/'))
      expect(parent, e.id).toBeDefined()
    }
  })
})

describe('the manifest against the backup\'s excluded dirs (src/core/backup/scan.ts)', () => {
  /**
   * The leader data that sits in a dir the backup leaves out, each with why. A backup is not
   * a standby copy: it leaves out what it rebuilds or ships some other way, and a few ledgers
   * live in those dirs only so git sync skips them. A new disagreement turns this red until it
   * is either a fix of the class or a line here. Backup and git sync behaviour stay as they are.
   */
  const KNOWN: Record<string, string> = {
    'cache.applied-ops': 'the offline-merge ledger: in cache/ so git sync skips it',
    'cache.status-riding': 'queue state of what rides the next message: in cache/ so git sync skips it',
    'cache.status-reconcile': 'the asks already made: in cache/ so git sync skips it',
    'cache.task-dir-size-notices': 'notices already given: in cache/ so git sync skips it',
    'cache.suggest-accuracy': 'an append-only ledger: in cache/ so git sync skips it',
    'cache.engine-split': 'the picks the shares are counted from: in cache/ so git sync skips it',
    'cache.work-card': 'when the phone card stretch began: in cache/ so git sync skips it',
    'cache.host-fix-failures': 'fixes that failed, so a restart does not rerun them: in cache/ so git sync skips it',
    'cache.agent-actions': 'what agents did in the browser: in cache/ so git sync skips it',
    'cache.agent-action-salt': 'the salt those records are keyed by: it goes with them',
    'tmp.file-history': 'the only copy of the opened files\' snapshots: in tmp/ so git sync skips it',
    'tmp.stt-recordings': 'voice input audio and text: in tmp/ for its size',
    'tmp.recordings': 'audio capture chunks and transcripts: in tmp/ for its size',
    'stt-debug-legacy': 'the same recordings at their older place',
    'data-repo': 'the backup leaves git sync\'s history out; without a data remote it is the only history',
    'browser-replays': 'replays are large; the backup leaves them out, a standby keeps them',
    'browser-replays.index': 'the replays\' step logs, inside browser/ (the same choice as browser-replays)',
    'config-history': 'the backup keeps its own dated history of config.yaml',
  }

  it('classes every excluded dir as not leader data, but the known disagreements', () => {
    const found: string[] = []
    for (const dir of EXCLUDED_DIRS) {
      expect(classifyHomePath(dir), `${dir} has an entry`).toBeDefined()
      for (const e of homeEntries()) {
        if ((e.path === dir || e.path.startsWith(`${dir}/`)) && e.class === 'leader-data') found.push(e.id)
      }
    }
    expect(found.sort()).toEqual(Object.keys(KNOWN).sort())
  })
})
