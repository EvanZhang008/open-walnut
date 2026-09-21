/**
 * Project-scoped engine settings, end to end through the fixture server: a real
 * session (mock CLI) in a real git checkout, the real daemon binary doing the
 * file I/O and the git exclude, and every assertion made against the disk.
 *
 * Request-level on purpose: the composer popover's own specs cover the UI; this
 * one pins the contract the UI is built on, so a regression in the daemon or the
 * service is named as such instead of as "the popover broke".
 */
import { test, expect, type APIRequestContext } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { discoverBrowserFixture } from './codex-test-audit'
import { fixtureHome, readClaudeSettings } from './engine-settings-helpers'

const TEST_PORT = 3457

test.describe.configure({ mode: 'serial' })
test.setTimeout(90_000)

type Row = { key: string; value: unknown; source: string; overlay?: { file: string }; writeTarget: { file: string; path: string; holds: boolean } }
type View = { cwd?: string; scope: string; projectScopeAvailable: boolean; files: Array<{ id: string; path: string; exists: boolean; scope: string; readOnly: boolean }>; groups: Array<{ items: Row[] }>; gitExclude?: { path: string; outcome: string } }

const rowOf = (view: View, key: string): Row => {
  const hit = view.groups.flatMap((g) => g.items).find((i) => i.key === key)
  expect(hit, `row ${key}`).toBeTruthy()
  return hit!
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const gitIgnores = (cwd: string, rel: string): boolean => {
  try { execFileSync('git', ['check-ignore', '-q', '--', rel], { cwd, stdio: 'ignore' }); return true } catch { return false }
}

/** A real session whose cwd is a fresh git checkout under the fixture's projects dir. */
async function startSessionInRepo(request: APIRequestContext): Promise<{ sessionId: string; repo: string }> {
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  const repo = path.join(fixtureRoot, 'projects', `scope-probe-${Date.now().toString(36)}`)
  await fs.mkdir(repo, { recursive: true })
  git(repo, 'init', '-q')
  // The verdicts must come from THIS repo, not from whatever the developer's
  // global excludes happen to ignore.
  git(repo, 'config', 'core.excludesFile', path.join(repo, '.no-global-excludes'))
  const res = await request.post('/api/sessions/quick-start', { data: { cwd: repo, message: '' } })
  expect(res.ok(), await res.text()).toBeTruthy()
  const { sessionId } = await res.json() as { sessionId?: string }
  expect(sessionId).toBeTruthy()
  return { sessionId: sessionId!, repo }
}

test.describe('engine settings: project scope for a session', () => {
  test("a session's view unlocks the project layers; 'this project only' creates the local file and keeps it out of git", async ({ request }) => {
    const home = await fixtureHome(request)
    const userBefore = await readClaudeSettings(home)
    expect(userBefore.verbose).toBe(false)
    expect(userBefore.outputStyle).toBe('Explanatory')

    const { sessionId, repo } = await startSessionInRepo(request)
    const localFile = path.join(repo, '.claude', 'settings.local.json')

    // Host and cwd come from the session; the project files are declared but absent.
    const initial = await request.get(`/api/engines/claude/settings?sessionId=${sessionId}`)
    expect(initial.status(), await initial.text()).toBe(200)
    const view0 = await initial.json() as View
    expect(view0).toMatchObject({ cwd: repo, scope: 'default', projectScopeAvailable: true })
    expect(view0.files.map((f) => [f.id, f.scope, f.readOnly, f.exists])).toEqual([
      ['user', 'user', false, true], ['global', 'user', false, false],
      ['project', 'project', true, false], ['project-local', 'project', false, false],
    ])
    expect(rowOf(view0, 'verbose')).toMatchObject({ value: false, source: 'file', writeTarget: { file: 'user', holds: true } })
    // The CLI's own screen keeps output style per project; the default scope follows it once a cwd is known.
    expect(rowOf(view0, 'outputStyle')).toMatchObject({ value: 'Explanatory', source: 'file', writeTarget: { file: 'project-local', path: localFile, holds: false } })

    // Project scope: the write creates the local file, the user file is untouched, git ignores the new file.
    const saved = await request.patch(`/api/engines/claude/settings?sessionId=${sessionId}&scope=project`, { data: { set: { verbose: true } } })
    expect(saved.status(), await saved.text()).toBe(200)
    const view1 = await saved.json() as View
    expect(JSON.parse(await fs.readFile(localFile, 'utf-8'))).toEqual({ verbose: true })
    expect((await readClaudeSettings(home)).verbose).toBe(false)
    expect(view1.gitExclude).toEqual({ path: localFile, outcome: 'added' })
    expect(await fs.readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf-8')).toContain('/.claude/settings.local.json\n')
    expect(gitIgnores(repo, '.claude/settings.local.json')).toBe(true)
    expect(git(repo, 'status', '--porcelain')).toBe('')
    expect(rowOf(view1, 'verbose')).toMatchObject({
      value: true, source: 'overlay', overlay: { file: 'project-local' }, writeTarget: { file: 'project-local', holds: true },
    })

    // Default scope on the same session: a per-project key lands in the local file
    // next to the first one, a user-wide key still goes to the user file.
    const mixed = await request.patch(`/api/engines/claude/settings?sessionId=${sessionId}`, { data: { set: { outputStyle: 'Learning', alwaysThinkingEnabled: false } } })
    expect(mixed.status(), await mixed.text()).toBe(200)
    const view2 = await mixed.json() as View
    expect(JSON.parse(await fs.readFile(localFile, 'utf-8'))).toEqual({ verbose: true, outputStyle: 'Learning' })
    const userAfter = await readClaudeSettings(home)
    expect(userAfter.outputStyle).toBe('Explanatory')
    expect(userAfter.alwaysThinkingEnabled).toBe(false)
    expect(view2.gitExclude).toBeUndefined()
    expect(rowOf(view2, 'outputStyle')).toMatchObject({ value: 'Learning', source: 'overlay' })
    // A second exclude line is never appended: the file was already ignored.
    const excludeText = await fs.readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf-8')
    expect(excludeText.split('/.claude/settings.local.json').length - 1).toBe(1)

    // Reset under project scope removes the key from the local file only; the user value shows through again.
    const reset = await request.patch(`/api/engines/claude/settings?sessionId=${sessionId}&scope=project`, { data: { unset: ['verbose'] } })
    expect(reset.status(), await reset.text()).toBe(200)
    const view3 = await reset.json() as View
    expect(JSON.parse(await fs.readFile(localFile, 'utf-8'))).toEqual({ outputStyle: 'Learning' })
    expect(rowOf(view3, 'verbose')).toMatchObject({ value: false, source: 'file', writeTarget: { file: 'project-local', holds: false } })

    // Restore the user file for the neighbouring specs.
    const restore = await request.patch('/api/engines/claude/settings', { data: { set: { alwaysThinkingEnabled: true } } })
    expect(restore.status()).toBe(200)
  })

  test('the project scope is refused without a working directory, and a bad cwd never reaches the disk', async ({ request }) => {
    const noCwd = await request.patch('/api/engines/claude/settings?scope=project', { data: { set: { verbose: true } } })
    expect(noCwd.status()).toBe(400)
    expect(await noCwd.json()).toMatchObject({ outcome: 'not-written' })
    const traversal = await request.get('/api/engines/claude/settings?cwd=/tmp/../etc')
    expect(traversal.status()).toBe(400)
    const unknownSession = await request.get('/api/engines/claude/settings?sessionId=no-such-session')
    expect(unknownSession.status()).toBe(400)
    expect((await unknownSession.json()).error).toContain('no-such-session')
  })
})
