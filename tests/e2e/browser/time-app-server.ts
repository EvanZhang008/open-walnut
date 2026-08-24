/**
 * Fixture server for the walnut-time plugin App.
 *
 * Its own server, not the shared :3457 fixture, for one reason: the shared fixture
 * installs no plugins by design (a spec there asserts a stock install has zero app
 * entries), and this app only exists once a plugin is linked. So this file provisions
 * a throwaway data home, LINKS the example plugin into it exactly the way
 * `walnut-plugin link` does, seeds a dense day of time records, and starts the real
 * server with Vite in front.
 *
 * Never :3456 and never the developer's data: OPEN_WALNUT_HOME, HOME and the daemon
 * dirs all point inside one temp directory that is removed on shutdown.
 *
 * Run: ./node_modules/.bin/tsx tests/e2e/browser/time-app-server.ts
 * Reads PW_TIME_APP_PORT; prints `TIME_APP_READY <json>` when it is serving.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const port = Number(process.env.PW_TIME_APP_PORT ?? 3459)
const tmpBase = path.join(os.tmpdir(), `walnut-time-app-${port}-${Date.now()}`)

// Set the data home BEFORE importing any server module: constants.ts resolves it at
// import time. `--_ephemeral-child` on argv is what stops the leaked-tmpdir guard
// from pulling it back to ~/.open-walnut, and nothing can inherit it.
process.env.OPEN_WALNUT_HOME = tmpBase
process.env.WALNUT_DAEMON_DIR = path.join(tmpBase, 'daemon')
process.env.WALNUT_STREAMS_DIR = path.join(tmpBase, 'daemon-streams')
process.env.WALNUT_DISABLE_SEARCH = '1'
process.env.WALNUT_DISABLE_BACKGROUND_AI = '1'
process.env.HOME = tmpBase
process.env.USERPROFILE = tmpBase
process.argv.push('--_ephemeral-child')

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

/**
 * One realistic day: eighteen tasks in a first stretch, a real break, then a deep
 * stretch. Mixed scripts and long titles on purpose, because that is what broke the
 * first cut of these views.
 */
const DENSE_TASKS: Array<{
  title: string
  project: string
  focus?: boolean
  slices: Array<[offsetMin: number, seconds: number]>
}> = [
  { title: '重构会话时间轴渲染管线 timeline rendering pipeline refactor', project: 'Console', focus: true, slices: [[0, 1500], [30, 900]] },
  { title: 'Investigate flaky provider reconnect under load 排查重连抖动', project: 'Infra', focus: true, slices: [[6, 1200]] },
  { title: '写周报与季度目标对齐文档 quarterly planning writeup', project: 'Planning', focus: true, slices: [[26, 780]] },
  { title: 'Review pull request for the search indexing worker', project: 'Infra', slices: [[14, 420]] },
  { title: '修复移动端消息回执丢失的问题 mobile receipt loss', project: 'Mobile', slices: [[20, 300]] },
  { title: 'Pair on the daemon capability gate 与队友结对', project: 'Infra', slices: [[44, 260]] },
  { title: 'Triage inbox and reschedule blocked items 收件箱清理', project: '', slices: [[10, 150]] },
  { title: 'Answer questions in the release thread 回复发布讨论', project: 'Planning', slices: [[13, 200]] },
  { title: 'Check overnight cron output 检查夜间任务输出', project: 'Infra', slices: [[16, 190]] },
  { title: 'Update the onboarding checklist for new hosts', project: 'Console', slices: [[18, 175]] },
  { title: 'Skim the incident report from yesterday 事故回顾', project: 'Infra', slices: [[22, 165]] },
  { title: 'Reply to the design review comment 设计评审回复', project: 'Console', slices: [[24, 48]] },
  { title: 'Rename a project and fix its stale references', project: 'Console', slices: [[34, 44]] },
  { title: 'Look at the cache hit-rate panel 缓存命中率', project: 'Infra', slices: [[36, 40]] },
  { title: 'Bump a dependency and read its changelog', project: 'Console', slices: [[38, 36]] },
  { title: 'File a follow-up task for the parser edge case', project: 'Console', slices: [[40, 33]] },
  { title: 'Glance at the notification centre 通知中心', project: '', slices: [[42, 31]] },
  { title: 'Confirm the backup finished 确认备份完成', project: 'Infra', slices: [[46, 30]] },
  // After a 17-minute break: the second chapter of the day.
  { title: '深度调试守护进程重连 deep debugging session', project: 'Infra', focus: true, slices: [[66, 360], [74, 540]] },
]

const SPAN_MS = 160 * 60_000

function localDate(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Where the seeded day sits. Two constraints collide: every record must land inside
 * ONE local day (blocks clip at midnight) and none may be in the future. Just after
 * local midnight neither holds, so fall back to yesterday afternoon and let the spec
 * step one day back.
 */
function seedAnchor(): { startMs: number; date: string } {
  const now = Date.now()
  const start = now - SPAN_MS
  if (localDate(start) === localDate(now)) return { startMs: start, date: localDate(now) }
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  const yesterdayAfternoon = midnight.getTime() - 8 * 60 * 60_000
  return { startMs: yesterdayAfternoon, date: localDate(yesterdayAfternoon) }
}

const anchor = seedAnchor()
const now = new Date().toISOString()

await fs.rm(tmpBase, { recursive: true, force: true })
await fs.mkdir(path.join(tmpBase, 'tasks'), { recursive: true })
await fs.mkdir(path.join(tmpBase, 'plugins'), { recursive: true })
await fs.mkdir(path.join(tmpBase, 'time-tracking'), { recursive: true })

// No live model calls from a fixture: the main agent points at the repo's mock CLI.
const mockMainAgent = path.join(repoRoot, 'tests/providers/mock-main-agent.mjs')
await fs.writeFile(path.join(tmpBase, 'config.yaml'), JSON.stringify({
  version: 1,
  defaults: { priority: 'none', platform: 'local' },
  provider: { type: 'claude-code' },
  agent: {
    main_provider: 'time-app-cli',
    main_model: 'time-app-mock',
    triage: { debounce_minutes: 0 },
  },
  providers: { 'time-app-cli': { api: 'claude-cli', claude_cli_command: mockMainAgent } },
}, null, 2))

const taskIds = DENSE_TASKS.map((_, i) => `t-time-${String(i + 1).padStart(2, '0')}`)
await fs.writeFile(path.join(tmpBase, 'tasks', 'tasks.json'), JSON.stringify({
  version: 1,
  tasks: DENSE_TASKS.map((spec, i) => ({
    id: taskIds[i],
    title: spec.title,
    status: 'in_progress',
    phase: 'IN_PROGRESS',
    priority: 'none',
    project: spec.project,
    source: 'local',
    ...(spec.focus ? { pinned: true, focus_tier: 'focus', pin_order: i } : {}),
    session_ids: [],
    active_session_ids: [],
    created_at: now,
    updated_at: now,
    description: '',
    summary: '',
    note: '',
    subtasks: [],
  })),
}, null, 2))

/**
 * The day's records, written straight to the store's own day file. The heartbeat
 * route would clamp a long window to ten minutes; a fixture wants the real shape of
 * a 25-minute stretch, and `hydrate()` reads this file at boot either way.
 */
const records: Array<Record<string, unknown>> = []
DENSE_TASKS.forEach((spec, i) => {
  for (const [offsetMin, seconds] of spec.slices) {
    records.push({
      date: anchor.date,
      // Bursts collide across tasks on purpose: the serial fold has to RESOLVE that
      // rather than draw two things at once.
      ts: new Date(anchor.startMs + offsetMin * 60_000 + (i % 3) * 20_000).toISOString(),
      durationMs: seconds * 1000,
      kind: i % 4 === 0 ? 'session' : i % 4 === 1 ? 'triage' : 'chat',
      taskId: taskIds[i],
    })
  }
})
// A late run of touches UNDER the 30s draw floor, one per task so none of them merges
// into anything: what a real day is mostly made of, and what the "not drawn" note has
// to account for.
for (let i = 0; i < 10; i += 1) {
  records.push({
    date: anchor.date,
    ts: new Date(anchor.startMs + (84 + i) * 60_000).toISOString(),
    durationMs: 22_000,
    kind: 'chat',
    taskId: taskIds[i + 2],
  })
}
// One long agent run, so the swimlanes' agent row has hatched bars to draw.
records.push({
  date: anchor.date,
  ts: new Date(anchor.startMs + 5 * 60_000).toISOString(),
  durationMs: 55 * 60_000,
  kind: 'agent',
  taskId: taskIds[0],
  sessionId: 'sess-time-app-fixture',
})
// A previous day, so the 7-day trend has more than one bar.
const previous = localDate(anchor.startMs - 24 * 60 * 60_000)
for (let i = 0; i < 4; i += 1) {
  records.push({
    date: previous,
    ts: new Date(anchor.startMs - 24 * 60 * 60_000 + (60 + i * 25) * 60_000).toISOString(),
    durationMs: (12 + i * 6) * 60_000,
    kind: 'session',
    taskId: taskIds[i],
  })
}

const byDate = new Map<string, string[]>()
for (const record of records) {
  const date = String(record.date)
  const lines = byDate.get(date) ?? []
  lines.push(JSON.stringify(record))
  byDate.set(date, lines)
}
for (const [date, lines] of byDate) {
  await fs.writeFile(path.join(tmpBase, 'time-tracking', `${date}.jsonl`), `${lines.join('\n')}\n`)
}

// Install the plugin the documented author way: a symlink in the data home's
// plugins/ directory, which is exactly what `walnut-plugin link` writes.
const pluginSource = path.join(repoRoot, 'examples/plugins/walnut-time')
await fs.access(path.join(pluginSource, 'dist', 'web.mjs'))
await fs.symlink(pluginSource, path.join(tmpBase, 'plugins', 'walnut-time'), 'dir')

const { startServer, stopServer } = await import('../../../src/web/server.js')
const apiServer = await startServer({ port: 0, dev: true })
const apiAddress = apiServer.address()
if (!apiAddress || typeof apiAddress === 'string') throw new Error('Time App fixture did not bind a TCP port')
const apiTarget = `http://127.0.0.1:${apiAddress.port}`

const { createServer: createViteServer } = await import('vite')
const viteServer = await createViteServer({
  root: path.join(repoRoot, 'web'),
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/ws': { target: apiTarget.replace(/^http/, 'ws'), ws: true },
    },
  },
  logLevel: 'warn',
})
await viteServer.listen()

const fixture = { port, home: tmpBase, date: anchor.date, taskIds, previousDate: previous }
await fs.writeFile(path.join(tmpBase, 'fixture.json'), JSON.stringify(fixture, null, 2))
console.log(`TIME_APP_READY ${JSON.stringify(fixture)}`)

const shutdown = async () => {
  await viteServer.close().catch(() => {})
  await stopServer()
  try {
    const { localDaemon } = await import('../../../src/providers/local-daemon.js')
    await localDaemon.stopIfIsolated()
  } catch { /* best effort */ }
  await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
