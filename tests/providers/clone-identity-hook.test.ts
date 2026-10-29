/**
 * The PostToolUse hook that gives a session's clone of a local repository that
 * repository's commit identity (src/providers/clone-identity-hook.ts), run for
 * real: the exact command string Walnut puts in `--settings`, through every
 * POSIX shell on this machine, with the JSON a Claude Code PostToolUse hook
 * receives, against real repositories cloned by the test the way the session's
 * command would have.
 *
 * MACHINE SAFETY: every repository lives under one temp dir; git runs with
 * HOME there, a temp global config and no system config, so neither the
 * account's identity nor its includes can leak in or be written.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { guardedPath } from '../setup/exec-guard.js'
import { CLONE_IDENTITY_COMMAND, cloneIdentityHooks } from '../../src/providers/clone-identity-hook.js'
import { sessionSettingsHooks } from '../../src/providers/session-settings-hooks.js'

const SHELLS = ['/bin/sh', '/bin/bash', '/bin/dash', '/usr/bin/dash', '/bin/zsh'].filter((s) => fs.existsSync(s))
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-clone-identity-')))
afterAll(() => { if (tmp.includes('walnut-clone-identity-')) fs.rmSync(tmp, { recursive: true, force: true }) })
const gitconfig = path.join(tmp, 'gitconfig')
fs.writeFileSync(gitconfig, '[user]\n\tname = Global Person\n\temail = global@example.test\n[init]\n\tdefaultBranch = main\n')
const gitBin = path.dirname(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim())
const env = {
  PATH: guardedPath([], `${gitBin}:/usr/bin:/bin`), HOME: tmp, TMPDIR: tmp, LANG: 'C',
  GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1',
}

let n = 0
/** Each test is its own session, so pending clones never cross tests. */
let sessionId = 'sess-0'
function dir(name: string): string {
  sessionId = `sess-${++n}`
  const d = path.join(tmp, `${n}-${name}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, stdio: 'pipe' }).toString('utf8').trim()
const cfg = (repo: string, key: string, scope = '--get') => {
  const r = spawnSync('git', ['-C', repo, 'config', ...(scope === '--local' ? ['--local', '--get'] : ['--get']), key], { env, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : ''
}

/** A repository with one commit and, when given, its own identity. */
function source(root: string, name: string, identity?: { name?: string; email?: string }): string {
  const d = path.join(root, name)
  git(root, 'init', '-q', d)
  git(d, 'commit', '-q', '--allow-empty', '-m', 'first')
  if (identity?.name) git(d, 'config', 'user.name', identity.name)
  if (identity?.email) git(d, 'config', 'user.email', identity.email)
  return d
}

let calls = 0
type Event = 'PreToolUse' | 'PostToolUse'
/** One hook run, with the JSON Claude Code gives a Bash hook. */
function hook(shell: string, event: Event, command: string, cwd: string, opts: { extraEnv?: Record<string, string>; stdout?: string; id?: string; sid?: string } = {}) {
  const input = JSON.stringify({
    session_id: opts.sid ?? sessionId, transcript_path: '/x.jsonl', cwd, permission_mode: 'bypassPermissions',
    hook_event_name: event, tool_name: 'Bash', tool_input: { command, description: 'd' },
    ...(event === 'PostToolUse' ? { tool_response: { stdout: opts.stdout ?? 'ok', stderr: '', interrupted: false, isImage: false } } : {}),
    tool_use_id: opts.id ?? 'toolu_x',
  })
  const r = spawnSync(shell, ['-c', CLONE_IDENTITY_COMMAND], { input, encoding: 'utf8', env: { ...env, ...opts.extraEnv } })
  let note = ''
  if (r.stdout) {
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }
    expect(out.hookSpecificOutput.hookEventName).toBe(event)
    note = out.hookSpecificOutput.additionalContext
  }
  return { status: r.status, note, stderr: r.stderr }
}

/**
 * One Bash tool call the way Claude Code runs it: PreToolUse with the directory the
 * command starts in, the command itself (`run`, done here by the test), then
 * PostToolUse with the directory it ended in, or none when the command failed.
 */
function bash(shell: string, command: string, cwd: string, run: () => void, after: { cwd?: string; failed?: boolean; stdout?: string; extraEnv?: Record<string, string> } = {}) {
  const id = `toolu_${++calls}`
  const pre = hook(shell, 'PreToolUse', command, cwd, { id, extraEnv: after.extraEnv })
  expect(pre.status).toBe(0)
  run()
  const post = after.failed ? null : hook(shell, 'PostToolUse', command, after.cwd ?? cwd, { id, stdout: after.stdout, extraEnv: after.extraEnv })
  if (post) expect(post.status).toBe(0)
  return { pre, post, note: [pre.note, post?.note ?? ''].filter(Boolean).join(' ') }
}

const pendingDir = path.join(tmp, '.local', 'state', 'open-walnut', 'clone-identity')

for (const shell of SHELLS) {
  describe(`clone identity under ${shell}`, () => {
    it('a clone of a repository with its own identity gets that identity, and the session is told', () => {
      const root = dir('basic')
      const src = source(root, 'src', { name: 'Public Name', email: 'public@example.test' })
      const r = bash(shell, `git clone ${src} copy`, root, () => git(root, 'clone', '-q', src, 'copy'))
      expect(r.pre.note).toBe('')
      expect(cfg(path.join(root, 'copy'), 'user.email', '--local')).toBe('public@example.test')
      expect(cfg(path.join(root, 'copy'), 'user.name', '--local')).toBe('Public Name')
      expect(r.post!.note).toContain(`${root}/copy`)
      expect(r.post!.note).toContain('Public Name <public@example.test>')
      expect(r.post!.note).toContain('Global Person <global@example.test>')
      // A commit there now carries it as author and committer.
      git(path.join(root, 'copy'), 'commit', '-q', '--allow-empty', '-m', 'second')
      expect(git(path.join(root, 'copy'), 'log', '-1', '--format=%ae %ce')).toBe('public@example.test public@example.test')
      // Nothing is left pending, and the next command hears nothing more.
      expect(fs.readdirSync(pendingDir).filter((f) => f.startsWith(`${sessionId}.`))).toEqual([])
      expect(bash(shell, 'git status', root, () => {}).note).toBe('')
    })

    it('reads the clone from where the command started, though PostToolUse gets where it ended', () => {
      const root = dir('cd')
      source(root, 'repo', { email: 'cd@example.test' })
      fs.mkdirSync(path.join(root, 'work'))
      // The session's shell keeps the cd, so PostToolUse's cwd is root/work.
      bash(shell, 'cd work && git clone ../repo copy', root, () => git(path.join(root, 'work'), 'clone', '-q', '../repo', 'copy'), { cwd: path.join(root, 'work') })
      expect(cfg(path.join(root, 'work', 'copy'), 'user.email', '--local')).toBe('cd@example.test')
    })

    it('follows a derived destination, file:// and -o, setting only what the source sets', () => {
      const root = dir('forms')
      const src = source(root, 'repo', { email: 'only-email@example.test' })
      const work = path.join(root, 'work')
      fs.mkdirSync(work)
      const r = bash(shell, `cd work && git clone ../repo; git clone file://${src} viaurl && git clone -o upstream --revision main "${src}/.git" named`, root, () => {
        git(work, 'clone', '-q', '../repo')
        git(work, 'clone', '-q', `file://${src}`, 'viaurl')
        git(work, 'clone', '-q', '-o', 'upstream', `${src}/.git`, 'named')
      }, { cwd: work })
      for (const c of ['repo', 'viaurl', 'named']) {
        expect(cfg(path.join(work, c), 'user.email', '--local'), c).toBe('only-email@example.test')
        // Only the field the source sets: the name still comes from the global config.
        expect(cfg(path.join(work, c), 'user.name', '--local'), c).toBe('')
      }
      expect(r.note.match(/Walnut set the commit identity/g)).toHaveLength(3)
    })

    it('a clone whose command failed, or is still running, is set before the next command runs', () => {
      const root = dir('failed')
      const src = source(root, 'src', { email: 'later@example.test' })
      // `git clone … && npm test` with a failing test: no PostToolUse at all.
      bash(shell, `git clone ${src} copy && npm test`, root, () => git(root, 'clone', '-q', src, 'copy'), { failed: true })
      expect(cfg(path.join(root, 'copy'), 'user.email', '--local')).toBe('')
      // The next command: its PreToolUse settles the failed one, before the commit runs.
      const next = hook(shell, 'PreToolUse', 'cd copy && git commit --allow-empty -m x', root, { id: `toolu_${++calls}` })
      expect(next.note).toContain(`${root}/copy`)
      expect(cfg(path.join(root, 'copy'), 'user.email', '--local')).toBe('later@example.test')
      // A background clone: PostToolUse comes while it still runs (no checkout yet), so it waits.
      bash(shell, `git clone ${src} bg`, root, () => git(root, 'clone', '-q', '--no-checkout', src, 'bg'))
      expect(cfg(path.join(root, 'bg'), 'user.email', '--local')).toBe('')
      // Once it has checked out, the next command settles it.
      git(path.join(root, 'bg'), 'checkout', '-q', 'main')
      expect(hook(shell, 'PostToolUse', 'ls', root, { id: `toolu_${++calls}` }).note).toContain(`${root}/bg`)
      expect(cfg(path.join(root, 'bg'), 'user.email', '--local')).toBe('later@example.test')
    })

    it('leaves alone what is not its business', () => {
      const root = dir('alone')
      const own = source(root, 'own', { name: 'Own', email: 'own@example.test' })
      const plain = source(root, 'plain')
      source(root, 'other')
      const r = bash(shell, [
        `git clone ${plain} plain-copy`,
        `git clone ${own} mine`,
        `git clone ${own} other`,
        `git clone --bare ${own}`,
        `git clone --bare ${own} b.git`,
        'git clone https://example.test/acme/app.git app',
        'git clone git@example.test:acme/app.git app2',
        `echo "git clone ${own} mine2"`,
      ].join('\n'), root, () => {
        // 1. The source has no identity of its own: the clone already commits as it does.
        git(root, 'clone', '-q', plain, 'plain-copy')
        // 2. The clone already has its own identity.
        git(root, 'clone', '-q', own, 'mine')
        git(path.join(root, 'mine'), 'config', 'user.email', 'chosen@example.test')
        // 3. `other` is a repository but not a clone of this source (the clone failed).
        // 4. A bare clone lands at own.git, never at the source.
        git(root, 'clone', '-q', '--bare', own)
        git(root, 'clone', '-q', '--bare', own, 'b.git')
        // 5. Clones of a URL: nothing local to read. 6. `echo` clones nothing.
      })
      expect(r.note).toBe('')
      expect(cfg(path.join(root, 'plain-copy'), 'user.email', '--local')).toBe('')
      expect(cfg(path.join(root, 'mine'), 'user.email', '--local')).toBe('chosen@example.test')
      expect(cfg(path.join(root, 'mine'), 'user.name', '--local')).toBe('')
      expect(cfg(path.join(root, 'other'), 'user.email', '--local')).toBe('')
      expect(cfg(own, 'user.email', '--local')).toBe('own@example.test')
      expect(cfg(path.join(root, 'b.git'), 'user.email', '--local')).toBe('')
      // Each was settled for good: nothing of this session is left pending.
      expect(fs.readdirSync(pendingDir).filter((f) => f.startsWith(`${sessionId}.`))).toEqual([])
    })

    it('a clone of an empty repository is settled at once, and a half-set identity is finished', () => {
      const root = dir('empty')
      const empty = path.join(root, 'empty')
      git(root, 'init', '-q', empty)
      git(empty, 'config', 'user.email', 'empty@example.test')
      bash(shell, `git clone ${empty} c`, root, () => git(root, 'clone', '-q', empty, 'c'))
      expect(cfg(path.join(root, 'c'), 'user.email', '--local')).toBe('empty@example.test')
      // A name written here before the email write lost git's config lock.
      const src = source(root, 'src', { name: 'Half', email: 'half@example.test' })
      bash(shell, `git clone ${src} h`, root, () => {
        git(root, 'clone', '-q', src, 'h')
        git(path.join(root, 'h'), 'config', 'user.name', 'Half')
      })
      expect(cfg(path.join(root, 'h'), 'user.email', '--local')).toBe('half@example.test')
    })

    it('a destination that is a plain directory inside another clone never reaches that clone', () => {
      const root = dir('nested')
      const src = source(root, 'src', { email: 'outer@example.test' })
      git(root, 'clone', '-q', src, 'outer')
      fs.mkdirSync(path.join(root, 'outer', 'sub'))
      // The clone into outer/sub failed; outer itself has no identity of its own.
      bash(shell, `git clone ${src} outer/sub`, root, () => {})
      expect(cfg(path.join(root, 'outer'), 'user.email', '--local')).toBe('')
    })

    it('a name with a quote, a backslash, non-ASCII letters or control characters is copied exactly and yields valid JSON', () => {
      const root = dir('quote')
      const name = "Renée O'Brien \\ \"Q\" \r\u001b[1m"
      const src = source(root, 'src', { name, email: 'renee@example.test' })
      const r = bash(shell, `git clone '${src}' "dst"`, root, () => git(root, 'clone', '-q', src, 'dst'))
      expect(cfg(path.join(root, 'dst'), 'user.name', '--local')).toBe(cfg(src, 'user.name'))
      expect(cfg(src, 'user.name')).toContain("Renée O'Brien \\ \"Q\"")
      expect(r.note).toContain("Renée O'Brien \\ \"Q\"")
    })

    it('an inherited GIT_DIR never redirects the write, and a run with no clone is silent', () => {
      const root = dir('gitdir')
      const src = source(root, 'src', { email: 'x@example.test' })
      const decoy = source(root, 'decoy')
      const extraEnv = { GIT_DIR: path.join(decoy, '.git') }
      bash(shell, `git clone ${src} dst`, root, () => git(root, 'clone', '-q', src, 'dst'), { extraEnv })
      expect(cfg(path.join(root, 'dst'), 'user.email', '--local')).toBe('x@example.test')
      expect(cfg(decoy, 'user.email', '--local')).toBe('')
      expect(bash(shell, 'ls -la && git status', root, () => {}).note).toBe('')
    })

    it('a long command is read in linear time; a huge output or command is skipped quickly', () => {
      const root = dir('huge')
      const src = source(root, 'src', { email: 'y@example.test' })
      // 90,000 characters with 6,000 lines: read whole, quickly.
      let t0 = Date.now()
      const long = `git clone ${src} dst\n` + 'echo some line here\n'.repeat(4500)
      bash(shell, long, root, () => git(root, 'clone', '-q', src, 'dst'), { stdout: 'x'.repeat(100_000) })
      expect(Date.now() - t0).toBeLessThan(8000)
      expect(cfg(path.join(root, 'dst'), 'user.email', '--local')).toBe('y@example.test')
      // A command over 100,000 characters (a file written through a heredoc) is never parsed.
      t0 = Date.now()
      const heredoc = `git clone ${src} dst2\ncat > f.txt <<'X'\n${'y'.repeat(300_000)}\nX`
      expect(bash(shell, heredoc, root, () => git(root, 'clone', '-q', src, 'dst2')).note).toBe('')
      expect(Date.now() - t0).toBeLessThan(5000)
      expect(cfg(path.join(root, 'dst2'), 'user.email', '--local')).toBe('')
      // An output past 1 MB is not read; the clone is settled at the next command.
      bash(shell, `git clone ${src} dst3`, root, () => git(root, 'clone', '-q', src, 'dst3'), { stdout: 'x'.repeat(1_100_000) })
      expect(cfg(path.join(root, 'dst3'), 'user.email', '--local')).toBe('')
      expect(hook(shell, 'PreToolUse', 'ls', root, { id: `toolu_${++calls}` }).note).toContain(`${root}/dst3`)
    })

    it('one session never settles another\'s pending clones, and a day-old one is forgotten', () => {
      const root = dir('sessions')
      const src = source(root, 'src', { email: 'z@example.test' })
      // This session's own clone that never appeared (a refused command): kept, then forgotten.
      hook(shell, 'PreToolUse', `git clone ${src} never`, root, { id: 'toolu_own' })
      const own = path.join(pendingDir, `${sessionId}.toolu_own`)
      hook(shell, 'PostToolUse', 'ls', root, { id: `toolu_${++calls}` })
      expect(fs.existsSync(own)).toBe(true)
      const dayOld = new Date(Date.now() - 2 * 86_400_000)
      fs.utimesSync(own, dayOld, dayOld)
      hook(shell, 'PostToolUse', 'ls', root, { id: `toolu_${++calls}` })
      expect(fs.existsSync(own)).toBe(false)
      hook(shell, 'PreToolUse', `git clone ${src} copy`, root, { id: 'toolu_a', sid: 'sess-other' })
      git(root, 'clone', '-q', src, 'copy')
      expect(hook(shell, 'PostToolUse', 'ls', root, { id: `toolu_${++calls}` }).note).toBe('')
      expect(cfg(path.join(root, 'copy'), 'user.email', '--local')).toBe('')
      const f = path.join(pendingDir, 'sess-other.toolu_a')
      expect(fs.existsSync(f)).toBe(true)
      const old = new Date(Date.now() - 2 * 86_400_000)
      fs.utimesSync(f, old, old)
      hook(shell, 'PostToolUse', 'ls', root, { id: `toolu_${++calls}` })
      expect(fs.existsSync(f)).toBe(false)
    })
  })
}

describe('cloneIdentityHooks', () => {
  it('rides every session on Bash before and after each command, beside the temp-dir guard and the /tmp write note; WALNUT_CLONE_IDENTITY=0 turns it off', () => {
    type Groups = Array<{ matcher: string; hooks: Array<{ command: string; timeout: number }> }>
    const hooks = cloneIdentityHooks({}) as { PreToolUse: Groups; PostToolUse: Groups }
    for (const g of [hooks.PreToolUse[0], hooks.PostToolUse[0]]) {
      expect(g.matcher).toBe('Bash')
      expect(g.hooks[0]).toMatchObject({ command: CLONE_IDENTITY_COMMAND, timeout: 10 })
    }
    expect(cloneIdentityHooks({ WALNUT_CLONE_IDENTITY: '0' })).toBeNull()
    const all = sessionSettingsHooks({}) as Record<string, Groups>
    expect(all.PreToolUse.map((g) => g.hooks[0].command === CLONE_IDENTITY_COMMAND)).toEqual([false, true])
    expect(all.PostToolUse.map((g) => g.matcher)).toEqual(['Write', 'Bash'])
    const off = sessionSettingsHooks({ WALNUT_CLONE_IDENTITY: '0' }) as Record<string, Groups>
    expect(off.PreToolUse).toHaveLength(1)
    expect(off.PostToolUse.map((g) => g.matcher)).toEqual(['Write'])
  })
})
