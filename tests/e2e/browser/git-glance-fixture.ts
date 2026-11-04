/**
 * Fixture for session-git-glance.spec.ts: one task whose session works in a REAL
 * git repository, so the git glance (branch, uncommitted files, +/- lines,
 * unpushed commits) is read by the server's own git code, not mocked.
 *
 * The repo (projects/git-glance-app, branch feature/git-glance) tracks a bare
 * remote and is one commit ahead of it. Uncommitted: src/app.ts edited (+3 -1)
 * and src/feature.ts new (3 lines). The session's transcript records the
 * Write of src/feature.ts and the Edit of src/app.ts, so its Changed tab lists
 * those two files.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

export const GIT_GLANCE_SESSION = 'pw-git-glance-session'
export const GIT_GLANCE_TASK = 'pw-task-git-glance'
export const GIT_GLANCE_BRANCH = 'feature/git-glance'

const APP_BEFORE = 'export function app(): string {\n  return "v1"\n}\n'
const APP_AFTER = 'export function app(): string {\n  return feature()\n}\n\nimport { feature } from "./feature"\n'
const FEATURE = 'export function feature(): string {\n  return "v2"\n}\n'

export function gitGlanceRepo(tmpBase: string): string {
  return path.join(tmpBase, 'projects', 'git-glance-app')
}

function git(cwd: string, ...args: string[]): void {
  const env = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined }
  execFileSync('git', ['-c', 'user.name=Walnut Test', '-c', 'user.email=walnut-test@example.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd, env, stdio: 'ignore' })
}

/** Builds the repo and its remote; returns the repo path. */
export function writeGitGlanceRepo(tmpBase: string): string {
  const repo = gitGlanceRepo(tmpBase)
  if (!repo.startsWith(os.tmpdir()) && !repo.startsWith(fs.realpathSync(os.tmpdir()))) throw new Error(`git glance fixture outside the temp dir: ${repo}`)
  const remote = path.join(tmpBase, 'projects', 'git-glance-remote.git')
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
  fs.mkdirSync(remote, { recursive: true })
  git(remote, 'init', '-q', '--bare')
  fs.writeFileSync(path.join(repo, 'README.md'), '# app\n')
  fs.writeFileSync(path.join(repo, 'src', 'app.ts'), APP_BEFORE)
  git(repo, 'init', '-q')
  git(repo, 'checkout', '-q', '-b', GIT_GLANCE_BRANCH)
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'init')
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'push', '-q', '-u', 'origin', GIT_GLANCE_BRANCH)
  fs.writeFileSync(path.join(repo, 'README.md'), '# app\n\nA small app.\n')
  git(repo, 'commit', '-qam', 'readme')
  // The session's uncommitted work.
  fs.writeFileSync(path.join(repo, 'src', 'app.ts'), APP_AFTER)
  fs.writeFileSync(path.join(repo, 'src', 'feature.ts'), FEATURE)
  return repo
}

/** The session's transcript: a Write and an Edit inside the repo. */
export function gitGlanceJsonl(now: number, repo: string): string {
  const at = (ms: number) => new Date(now - ms).toISOString()
  return [
    { type: 'user', sessionId: GIT_GLANCE_SESSION, timestamp: at(30_000), message: { role: 'user', content: 'Add the feature module and call it from app.' } },
    {
      type: 'assistant', sessionId: GIT_GLANCE_SESSION, timestamp: at(25_000),
      message: { role: 'assistant', content: [
        { type: 'text', text: 'Adding src/feature.ts.' },
        { type: 'tool_use', id: 'toolu_pw_glance_1', name: 'Write', input: { file_path: path.join(repo, 'src', 'feature.ts'), content: FEATURE } },
      ] },
    },
    {
      type: 'assistant', sessionId: GIT_GLANCE_SESSION, timestamp: at(20_000),
      message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'toolu_pw_glance_2', name: 'Edit', input: { file_path: path.join(repo, 'src', 'app.ts'), old_string: '  return "v1"\n}\n', new_string: '  return feature()\n}\n\nimport { feature } from "./feature"\n' } },
      ] },
    },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n'
}

export function gitGlanceTask(nowIso: string): Record<string, unknown> {
  return {
    id: GIT_GLANCE_TASK,
    title: 'Git glance fixture task',
    status: 'in_progress',
    phase: 'IN_PROGRESS',
    priority: 'none',
    project: 'Walnut',
    source: 'local',
    session_ids: [GIT_GLANCE_SESSION],
    active_session_ids: [],
    session_id: GIT_GLANCE_SESSION,
    session_status: { process_status: 'stopped', mode: 'bypass' },
    created_at: nowIso,
    updated_at: nowIso,
    description: '',
    summary: '',
    note: '',
    subtasks: [],
  }
}

export function gitGlanceRecord(now: number, repo: string): Record<string, unknown> {
  return {
    claudeSessionId: GIT_GLANCE_SESSION,
    taskId: GIT_GLANCE_TASK,
    project: 'Walnut',
    process_status: 'stopped',
    mode: 'bypass',
    last_status_change: new Date(now).toISOString(),
    startedAt: new Date(now - 35_000).toISOString(),
    lastActiveAt: new Date(now).toISOString(),
    messageCount: 3,
    cwd: repo,
    title: 'Git glance fixture session',
  }
}

// ── A fuller board for a person looking at it (PW_GIT_GLANCE_DEMO=1) ──
// Four more tasks, one git state each: clean and pushed, only commits not
// pushed, a detached HEAD with an edit, and a wide change across many files.
// Off by default: specs that count the board's tasks never see them.

interface DemoCase { slug: string; title: string; build: (repo: string, remote: string) => void; writes: string[] }

function commitAll(repo: string, msg: string): void {
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', msg)
}

const DEMO_CASES: DemoCase[] = [
  {
    slug: 'clean', title: 'Tidy the settings page copy',
    build: (repo) => { fs.writeFileSync(path.join(repo, 'src', 'settings.ts'), 'export const title = "Settings"\n'); commitAll(repo, 'settings copy'); git(repo, 'push', '-q') },
    writes: ['src/settings.ts'],
  },
  {
    slug: 'unpushed', title: 'Ship the release notes',
    build: (repo) => {
      for (let i = 1; i <= 3; i++) { fs.writeFileSync(path.join(repo, `NOTES-${i}.md`), `# Notes ${i}\n`); commitAll(repo, `notes ${i}`) }
    },
    writes: ['NOTES-1.md', 'NOTES-2.md', 'NOTES-3.md'],
  },
  {
    slug: 'detached', title: 'Bisect the slow start',
    build: (repo) => {
      git(repo, 'checkout', '-q', '--detach', 'HEAD')
      fs.writeFileSync(path.join(repo, 'src', 'app.ts'), APP_BEFORE + 'console.time("start")\n')
    },
    writes: ['src/app.ts'],
  },
  {
    slug: 'wide', title: 'Rename the storage layer',
    build: (repo) => {
      fs.mkdirSync(path.join(repo, 'src', 'storage'), { recursive: true })
      for (let i = 0; i < 42; i++) fs.writeFileSync(path.join(repo, 'src', 'storage', `table-${i}.ts`), Array.from({ length: 30 }, (_, j) => `export const c${j} = ${i * j}`).join('\n') + '\n')
    },
    writes: Array.from({ length: 42 }, (_, i) => `src/storage/table-${i}.ts`),
  },
]

export interface DemoSession { task: Record<string, unknown>; record: Record<string, unknown>; repo: string; jsonl: string; sessionId: string }

/** Builds the demo repos; returns each task, session record and transcript to seed. */
export function writeGitGlanceDemo(tmpBase: string, now: number): DemoSession[] {
  if (process.env.PW_GIT_GLANCE_DEMO !== '1') return []
  return DEMO_CASES.map((c, k) => {
    const repo = path.join(tmpBase, 'projects', `git-glance-${c.slug}`)
    const remote = path.join(tmpBase, 'projects', `git-glance-${c.slug}-remote.git`)
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
    fs.mkdirSync(remote, { recursive: true })
    git(remote, 'init', '-q', '--bare')
    fs.writeFileSync(path.join(repo, 'README.md'), `# ${c.slug}\n`)
    fs.writeFileSync(path.join(repo, 'src', 'app.ts'), APP_BEFORE)
    git(repo, 'init', '-q')
    commitAll(repo, 'init')
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-q', '-u', 'origin', 'main')
    c.build(repo, remote)
    const sessionId = `pw-git-glance-${c.slug}-session`
    const taskId = `pw-task-git-glance-${c.slug}`
    const at = (ms: number) => new Date(now - ms).toISOString()
    const jsonl = [
      { type: 'user', sessionId, timestamp: at(60_000), message: { role: 'user', content: c.title } },
      ...c.writes.map((rel, i) => ({
        type: 'assistant', sessionId, timestamp: at(50_000 - i),
        message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${c.slug}_${i}`, name: 'Write', input: { file_path: path.join(repo, rel), content: fs.readFileSync(path.join(repo, rel), 'utf8') } }] },
      })),
    ].map((l) => JSON.stringify(l)).join('\n') + '\n'
    const nowIso = new Date(now).toISOString()
    return {
      sessionId, repo, jsonl,
      task: { ...gitGlanceTask(nowIso), id: taskId, title: c.title, session_ids: [sessionId], session_id: sessionId },
      record: { ...gitGlanceRecord(now - (k + 1) * 60_000, repo), claudeSessionId: sessionId, taskId, title: c.title, messageCount: c.writes.length + 1 },
    }
  })
}
