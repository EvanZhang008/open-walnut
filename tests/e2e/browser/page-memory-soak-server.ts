/**
 * Fixture server for the page memory soak (page-memory-soak.spec.ts).
 *
 * The Mac app's page reached 2.1 GB (2026-11-09). The main cause was a push handler: every
 * `cron:job-*` push, 12 to 30 a minute, made the page refetch the whole routines list (1.2 MB
 * for 182 routines). That class only shows at real density over hours, so this fixture seeds a
 * board as dense as the real one and replays a compressed multi-hour event load through the
 * server's real push paths, on request.
 *
 * Seeded (on disk, in the stores' own formats, before boot, the way the other fixtures seed):
 *  - about 180 routines whose list is over 1 MB (instruction text, trigger audit trails with the
 *    injected previews the real ones keep), most of them triggers aimed at seeded tasks;
 *  - about 300 tasks over five projects;
 *  - one session on a pinned task that has a trigger, with a short transcript.
 *
 * The replay: the spec writes `soak-replay.json` ({ hours }) into the data home. Per hour it
 * sends the mix measured on the real Mac app page: 440 cron:job-updated (the payload a quiet
 * trigger check sends, through the server's broadcast, the cron service's own onEvent path),
 * 140 task:updated (real updateTaskRaw writes), and the shown session's streaming (thinking and
 * text deltas, turn speed, usage, tool use and results, live activity, background tasks, status
 * changes, a result per turn) on the bus with the destinations their emitters use. Paced so one
 * cron push leaves every TICK_MS (450 ms: three hours in about ten minutes), a gap longer than the
 * page's 150 ms debounce, so a handler that refetches per push is seen per push. It writes `soak-replay-done.json` with the counts.
 *
 * Never :3456 and never the developer's data: OPEN_WALNUT_HOME, HOME and the daemon dirs all
 * point inside one temp directory that is removed on shutdown.
 *
 * Run: bun tests/e2e/browser/page-memory-soak-server.ts
 * Reads PW_SOAK_PORT; prints `SOAK_READY <json>` when it is serving.
 */

import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fixtureHome } from './fixture-home'

const port = Number(process.env.PW_SOAK_PORT ?? 3461)
// Its own home for real: Bun reads HOME only at startup (fixture-home.ts).
const tmpBase = await fixtureHome(path.join(os.tmpdir(), `walnut-soak-${port}-${Date.now()}`))

// Set the data home BEFORE importing any server module: constants.ts resolves it at
// import time. `--_ephemeral-child` on argv is what stops the leaked-tmpdir guard
// from pulling it back to ~/.open-walnut, and nothing can inherit it.
process.env.OPEN_WALNUT_HOME = tmpBase
process.env.WALNUT_DAEMON_DIR = path.join(tmpBase, 'daemon')
process.env.WALNUT_STREAMS_DIR = path.join(tmpBase, 'daemon-streams')
process.env.WALNUT_DISABLE_SEARCH = '1'
process.env.WALNUT_DISABLE_BACKGROUND_AI = '1'
// Approvals ask, as before the switch (src/core/approvals/ask-me.ts): the specs check the cards.
process.env.WALNUT_APPROVALS_ASK ??= '1'
process.env.HOME = tmpBase
process.env.USERPROFILE = tmpBase
process.argv.push('--_ephemeral-child')

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

/**
 * The page is the production build of the SPA, served by the server itself as users run it: built
 * here into the data home (about a minute), or WALNUT_WEB_STATIC_DIR when set. React's development
 * build keeps an owner stack (an Error) on every element it creates, and an unformatted Error keeps
 * the functions on its stack and their closures alive, so each render of the chat kept the one
 * before it: hundreds of KB per chat row that users never see (2026-11-10). PW_SOAK_WEB=dev serves
 * the source through Vite instead, for readable constructor names (PW_SOAK_HEAP_DIFF=1).
 */
const BUILT = process.env.PW_SOAK_WEB !== 'dev'
// Beside the data home, not in it: the seed below starts the home over.
const webBuildDir = `${tmpBase}-web`
if (BUILT && !process.env.WALNUT_WEB_STATIC_DIR) {
  const outDir = path.join(webBuildDir, 'static')
  const { build } = await import('vite')
  await build({
    root: path.join(repoRoot, 'web'),
    cacheDir: path.join(webBuildDir, 'vite-cache'),
    build: { outDir, emptyOutDir: true },
    logLevel: 'warn',
  })
  process.env.WALNUT_WEB_STATIC_DIR = outDir
}

/**
 * One cron push per tick, three times the page's 150 ms routines debounce: three hours replay in
 * about ten minutes (18x). Faster, the session column's 18x denser stream holds the page's main
 * thread long enough that the cron pushes pile up into bursts the store reads as one list fetch.
 */
const TICK_MS = Number(process.env.PW_SOAK_TICK_MS ?? 450)

// ── Deterministic seed data ──

let seed = 0x5eed
function rand(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!

const PROJECTS = ['Console', 'Mobile', 'Infra', 'Docs', 'Research'] as const
const VERBS = ['Fix', 'Add', 'Review', 'Rename', 'Measure', 'Move', 'Retire', 'Document', 'Speed up', 'Check', 'Split', 'Test']
const NOUNS = ['the session column', 'the task list sort', 'the routines page', 'push delivery', 'the folder picker',
  'the phone sign-in', 'the release notes', 'the search index', 'the build cache', 'the host daemon', 'the Board chips',
  'the inbox digest', 'the diff viewer', 'voice input', 'the deploy queue', 'the settings search', 'the org chart']
const SENTENCES = [
  'Read the latest state first and only act on what changed since the last run.',
  'If nothing new arrived, end quietly without writing to the user or the board.',
  'Each item carries its own link; open it, read the newest comment, and decide whether it needs this task.',
  'A failed run names its last line; read it and the task state before deciding who owns the cause.',
  'Keep the reply short: the conclusion first, then the one next step, then any evidence.',
  'Never send anything outside Walnut from this check; the session decides that on its own turn.',
  'When the build is green on the commit you named, move on to the next step of the plan.',
  'Check the open review threads, answer the ones addressed to this task, and leave the rest.',
]
const words = (n: number) => Array.from({ length: n }, () => pick(SENTENCES)).join(' ')

const now = Date.now()
const nowIso = new Date(now).toISOString()

// ── Tasks ──

const PHASES = ['TODO', 'TODO', 'TODO', 'TODO', 'IN_PROGRESS', 'IN_PROGRESS', 'IN_PROGRESS', 'WAITING', 'NEED_ACTION', 'COMPLETE', 'COMPLETE'] as const
const STATUS_OF: Record<string, string> = { TODO: 'todo', IN_PROGRESS: 'in_progress', WAITING: 'in_progress', NEED_ACTION: 'in_progress', COMPLETE: 'done' }
const TASK_COUNT = 300
const taskIds = Array.from({ length: TASK_COUNT }, (_, i) => `t-soak-${String(i + 1).padStart(3, '0')}`)
const LIVE_TASK = 't-soak-live'
const LIVE_SESSION = 'sess-soak-live'
const LIVE_TITLE = 'Soak live session task'

const tasks: Record<string, unknown>[] = taskIds.map((id, i) => {
  const phase = PHASES[i % PHASES.length]!
  return {
    id,
    title: `${pick(VERBS)} ${pick(NOUNS)} ${i + 1}`,
    status: STATUS_OF[phase],
    phase,
    priority: i % 9 === 0 ? 'immediate' : 'none',
    project: PROJECTS[i % PROJECTS.length],
    source: 'local',
    ...(i < 10 ? { pinned: true, focus_tier: 'focus', pin_order: i } : {}),
    ...(phase === 'COMPLETE' ? { completed_at: nowIso } : {}),
    session_ids: [],
    active_session_ids: [],
    created_at: new Date(now - (i + 1) * 3_600_000).toISOString(),
    updated_at: nowIso,
    description: words(2 + (i % 4)),
    summary: i % 3 === 0 ? words(2) : '',
    note: '',
    subtasks: [],
  }
})
tasks.unshift({
  id: LIVE_TASK,
  title: LIVE_TITLE,
  status: 'in_progress',
  phase: 'IN_PROGRESS',
  priority: 'none',
  project: 'Console',
  source: 'local',
  pinned: true,
  focus_tier: 'focus',
  pin_order: -1,
  session_ids: [LIVE_SESSION],
  active_session_ids: [],
  session_id: LIVE_SESSION,
  session_status: { process_status: 'stopped', mode: 'bypass' },
  created_at: new Date(now - 6 * 3_600_000).toISOString(),
  updated_at: nowIso,
  description: words(3),
  summary: words(2),
  note: '',
  subtasks: [],
})

// ── Routines (cron-jobs.json + its cron-state.json sidecar) ──

const ROUTINE_COUNT = 180
const TRIGGER_COUNT = 150
const routineIds = Array.from({ length: ROUTINE_COUNT }, (_, i) => `rt-soak-${String(i + 1).padStart(3, '0')}`)
// Triggers aim at the first 60 open tasks (some tasks hold several) and one at the live task.
const triggerTargets = taskIds.filter((_, i) => PHASES[i % PHASES.length] !== 'COMPLETE').slice(0, 60)

function auditEntry(atMs: number, fired: boolean, seq: number): Record<string, unknown> {
  return fired ? {
    atMs, outcome: 'fired', seq, items: 1 + (seq % 3), durationMs: 600 + (seq % 7) * 300,
    delivery: { status: 'ok', summary: `sent to session ${pick(NOUNS)}`, sessionId: `0000${seq}-soak` },
    injected: { chars: 2200, preview: `<walnut-message kind="trigger" note="fired, 1 new item">\n${words(11)}` },
  } : { atMs, outcome: 'quiet', reason: 'fire-false', durationMs: 300 + (seq % 5) * 100 }
}

const jobs: Record<string, unknown>[] = []
const states: Record<string, unknown> = {}
for (let i = 0; i < ROUTINE_COUNT; i += 1) {
  const id = routineIds[i]!
  const isTrigger = i < TRIGGER_COUNT
  const target = i === 0 ? LIVE_TASK : triggerTargets[i % triggerTargets.length]!
  const instructions = words(isTrigger ? 4 + (i % 9) : 2 + (i % 4))
  const everyMs = [5, 10, 15, 30, 60][i % 5]! * 60_000
  const created = now - (30 - (i % 30)) * 86_400_000
  if (isTrigger) {
    jobs.push({
      id,
      name: `Watch ${pick(NOUNS)} ${i + 1}`,
      description: words(1),
      enabled: i % 7 !== 0,
      createdAtMs: created,
      updatedAtMs: created,
      // The trigger's host decides when it runs; this one names a host the fixture does not
      // have, so nothing here ever runs a check: the replay is the only source of pushes.
      schedule: { kind: 'every', everyMs, anchorMs: created },
      sessionTarget: 'isolated',
      wakeMode: 'now',
      payload: { kind: 'agentTurn', message: instructions },
      executor: { type: 'session', config: { target, prompt: instructions, instructions } },
      check: { run: `bash watch-${i + 1}.sh`, cwd: '/srv/checks', host: 'buildbox', timeoutSeconds: 60 },
    })
    const fires = i % 4 === 0 ? 10 : i % 4 === 1 ? 2 : 0
    states[id] = {
      nextRunAtMs: now + everyMs,
      lastRunAtMs: now - everyMs,
      lastStatus: 'ok',
      lastCheck: { atMs: now - everyMs, outcome: 'quiet', reason: 'fire-false', durationMs: 420 },
      checkLog: Array.from({ length: 12 }, (_, k) => auditEntry(now - (k + 1) * everyMs, k % 6 === 0, 100 + k)),
      fireLog: Array.from({ length: fires }, (_, k) => auditEntry(now - (k + 1) * 6 * everyMs, true, 10 + k)),
    }
  } else {
    // Plain routines: a day apart, so the server's own clock never runs one during a test.
    jobs.push({
      id,
      name: `Daily ${pick(NOUNS)} ${i + 1}`,
      enabled: i % 3 !== 0,
      createdAtMs: created,
      updatedAtMs: created,
      schedule: { kind: 'every', everyMs: 86_400_000, anchorMs: now },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'agentTurn', message: instructions },
      executor: { type: 'main-agent', config: { instructions } },
    })
    states[id] = { nextRunAtMs: now + 86_400_000, lastRunAtMs: now - 86_400_000, lastStatus: 'ok', lastDurationMs: 31_000 }
  }
}

await fs.rm(tmpBase, { recursive: true, force: true })
await fs.mkdir(path.join(tmpBase, 'tasks'), { recursive: true })
await fs.writeFile(path.join(tmpBase, 'tasks', 'tasks.json'), JSON.stringify({ version: 1, tasks }, null, 2))
await fs.writeFile(path.join(tmpBase, 'cron-jobs.json'), JSON.stringify({ version: 2, jobs }, null, 2))
await fs.writeFile(path.join(tmpBase, 'cron-state.json'), JSON.stringify({ version: 1, states }, null, 2))

// No live model calls from a fixture: the main agent points at the repo's mock CLI.
const mockMainAgent = path.join(repoRoot, 'tests/providers/mock-main-agent.mjs')
await fs.writeFile(path.join(tmpBase, 'config.yaml'), JSON.stringify({
  version: 1,
  defaults: { priority: 'none', platform: 'local' },
  provider: { type: 'claude-code' },
  agent: { main_provider: 'soak-cli', main_model: 'soak-mock', triage: { debounce_minutes: 0 } },
  providers: { 'soak-cli': { api: 'claude-cli', claude_cli_command: mockMainAgent } },
}, null, 2))

// ── The live session: stopped, with a short transcript ──

const sessionCwd = path.join(tmpBase, 'project')
await fs.mkdir(sessionCwd, { recursive: true })
const jsonlDir = path.join(tmpBase, '.claude', 'projects', sessionCwd.replace(/[^a-zA-Z0-9]/g, '-'))
await fs.mkdir(jsonlDir, { recursive: true })
const jsonlPath = path.join(jsonlDir, `${LIVE_SESSION}.jsonl`)
const startedAt = now - 2 * 3_600_000
await fs.writeFile(path.join(tmpBase, 'sessions.json'), JSON.stringify({
  version: 2,
  sessions: [{
    claudeSessionId: LIVE_SESSION,
    taskId: LIVE_TASK,
    project: 'Console',
    process_status: 'stopped',
    mode: 'bypass',
    last_status_change: new Date(startedAt).toISOString(),
    startedAt: new Date(startedAt).toISOString(),
    lastActiveAt: new Date(startedAt + 20 * 60_000).toISOString(),
    messageCount: 24,
    cwd: sessionCwd,
    title: LIVE_TITLE,
  }],
}, null, 2))
const transcriptLine = (type: 'user' | 'assistant', at: number, text: string) => JSON.stringify({
  type,
  sessionId: LIVE_SESSION,
  uuid: `soak-${type}-${at}`,
  timestamp: new Date(at).toISOString(),
  message: type === 'user'
    ? { role: 'user', content: text }
    : { role: 'assistant', content: [{ type: 'text', text }] },
})
await fs.writeFile(jsonlPath, Array.from({ length: 12 }, (_, i) => [
  transcriptLine('user', startedAt + i * 60_000, `soak question ${i + 1}`),
  transcriptLine('assistant', startedAt + i * 60_000 + 30_000, `soak answer ${i + 1}: ${words(2)}`),
]).flat().concat('').join('\n'))

// ── Server + Vite ──

const { startServer, stopServer, armGracefulSignalExit } = await import('../../../src/web/server.js')
const apiServer = await startServer({ port: BUILT ? port : 0, dev: !BUILT })
const apiAddress = apiServer.address()
if (!apiAddress || typeof apiAddress === 'string') throw new Error('Soak fixture did not bind a TCP port')
const apiTarget = `http://127.0.0.1:${apiAddress.port}`

// The seeded density, measured from the API the page reads, so the spec can refuse a thin seed.
const listBytes = (await (await fetch(`${apiTarget}/api/routines?includeDisabled=true`)).text()).length

let viteServer: import('vite').ViteDevServer | null = null
if (!BUILT) {
  const { createServer: createViteServer } = await import('vite')
  // The server trusts a page without a credential only when its Origin is the server's
  // own, so the proxy restates its own pages' origin as the API target.
  const { restateOwnOrigin } = await import('../../../web/dev-proxy-origin.js')
  const { holdUntilWarm } = await import('./fixture-warm.js')
  const warm = holdUntilWarm()
  viteServer = await createViteServer({
    root: path.join(repoRoot, 'web'),
    // Every request waits behind the SPA's first compile (fixture-warm.ts).
    plugins: [warm.plugin],
    // Its own dependency cache, as test-server.ts: a shared one is re-optimized under it.
    cacheDir: path.join(tmpBase, 'vite-cache'),
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true, configure: (proxy) => restateOwnOrigin(proxy, apiTarget) },
        '/ws': { target: apiTarget.replace(/^http/, 'ws'), ws: true, configure: (proxy) => restateOwnOrigin(proxy, apiTarget) },
      },
    },
    logLevel: 'warn',
  })
  await viteServer.listen()
  await warm.warm(viteServer)
}

// ── The replay ──

const { bus, EventNames } = await import('../../../src/core/event-bus.js')
const { broadcastEvent } = await import('../../../src/web/ws/handler.js')
const { updateTaskRaw } = await import('../../../src/core/task-manager.js')
const { emitSessionStatusChanged, getSessionByClaudeId } = await import('../../../src/core/session-tracker.js')

/** The per-hour mix measured on the real Mac app page (2026-11-09). */
const PER_HOUR = {
  cron: 440, task: 140,
  thinking: 4100, text: 900, speed: 900, usage: 500, toolUse: 200, toolResult: 180,
  live: 300, background: 250, status: 90,
}
/** A turn ends with a result; ten an hour spread the session mix over realistic turns. */
const TURNS_PER_HOUR = 10

type Step = () => void | Promise<void>

let statusRevision = 1000
async function emitStatus(processStatus: 'running' | 'idle', activity: string | null): Promise<void> {
  const record = await getSessionByClaudeId(LIVE_SESSION)
  if (!record) return
  statusRevision += 1
  emitSessionStatusChanged({
    ...record,
    process_status: processStatus,
    activity,
    statusRevision,
    statusUpdatedAt: new Date().toISOString(),
  } as typeof record, {}, ['*'], { source: 'session-runner' })
}

function emitLive(activity: Record<string, unknown> | null): void {
  bus.emit(EventNames.SESSION_LIVE_ACTIVITY, {
    sessionId: LIVE_SESSION, taskId: LIVE_TASK, activity, taskActivity: activity,
  } as never, ['web-ui', 'mobile-events-feed'], { source: 'session-runner' })
}

/**
 * One turn of the shown session: the events its runner emits, in a realistic order. The content
 * comes as the CLI streams it, one API message per tool call (its thinking, then its text, then
 * the tool call, then the tool's result); the readouts (speed, usage, live activity, background
 * tasks, status) are spread over the turn between them.
 */
function turnSteps(turn: number): Step[] {
  const per = (n: number) => Math.round(n / TURNS_PER_HOUR)
  const sid = LIVE_SESSION
  const taskId = LIVE_TASK
  const turnStart = Date.now()
  const messages = per(PER_HOUR.toolUse)
  // Messages whose tool result is not in the mix (180 results to 200 calls an hour).
  const noResult = new Set(Array.from({ length: messages - per(PER_HOUR.toolResult) }, (_, k) => Math.floor(((k + 0.5) * messages) / (messages - per(PER_HOUR.toolResult) || 1))))
  let toolSeq = 0
  let chars = 0
  let outputTokens = 0
  const transcript: string[] = []
  const finalText: string[] = []

  const content: Step[] = []
  const share = (total: number, m: number) => Math.floor(((m + 1) * total) / messages) - Math.floor((m * total) / messages)
  for (let m = 0; m < messages; m += 1) {
    const msgId = `msg_soak_${turn}_${m}`
    const toolUseId = `toolu_soak_${turn}_${m}`
    const thinking: string[] = []
    const text: string[] = []
    for (let k = 0; k < share(per(PER_HOUR.thinking), m); k += 1) content.push(() => {
      const delta = `${pick(SENTENCES).slice(0, 40)} `
      chars += delta.length
      thinking.push(delta)
      bus.emit(EventNames.SESSION_THINKING_DELTA, { sessionId: sid, taskId, delta, msgId }, ['main-ai'], { source: 'session-runner' })
    })
    for (let k = 0; k < share(per(PER_HOUR.text), m); k += 1) content.push(() => {
      const delta = `${pick(SENTENCES).slice(0, 60)} `
      chars += delta.length
      text.push(delta)
      bus.emit(EventNames.SESSION_TEXT_DELTA, { sessionId: sid, taskId, delta, msgId }, ['main-ai'], { source: 'session-runner' })
    })
    const input = { command: `bun run test:focus tests/core/area-${m + 1}.test.ts`, description: 'Run the focused tests' }
    content.push(() => {
      toolSeq = m + 1
      bus.emit(EventNames.SESSION_TOOL_USE, { sessionId: sid, taskId, toolName: 'Bash', toolUseId, input }, ['main-ai'], { source: 'session-runner' })
      finalText.push(text.join(''))
      transcript.push(JSON.stringify({
        type: 'assistant', sessionId: sid, uuid: `soak-a-${turn}-${m}`, timestamp: new Date().toISOString(),
        message: { id: msgId, role: 'assistant', content: [
          { type: 'thinking', thinking: thinking.join('') },
          { type: 'text', text: text.join('') },
          { type: 'tool_use', id: toolUseId, name: 'Bash', input },
        ] },
      }))
    })
    if (!noResult.has(m)) content.push(() => {
      const result = `${words(3)}\n 12 passed (12)\n Duration 1.4s`
      bus.emit(EventNames.SESSION_TOOL_RESULT, { sessionId: sid, taskId, toolUseId, result }, ['main-ai'], { source: 'session-runner' })
      transcript.push(JSON.stringify({
        type: 'user', sessionId: sid, uuid: `soak-r-${turn}-${m}`, timestamp: new Date().toISOString(),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: result }] },
      }))
    })
  }

  const readout: Record<string, Step> = {
    speed: () => {
      outputTokens += 40
      bus.emit(EventNames.SESSION_TURN_SPEED, {
        sessionId: sid, taskId,
        speed: {
          startedAt: turnStart, ttftMs: 1800, generationMs: Date.now() - turnStart, outputTokens, messages: 1 + toolSeq,
          model: 'soak-model', inFlight: true, inFlightChars: chars, inFlightMs: 1200, inFlightVisibleMs: 900, final: false,
        },
      }, ['web-ui'], { source: 'session-runner' })
    },
    usage: () => {
      const inputTokens = 40_000 + turn * 900 + outputTokens
      bus.emit(EventNames.SESSION_USAGE_UPDATE, {
        sessionId: sid, model: 'soak-model', inputTokens,
        contextPercent: Math.round((inputTokens / 1_000_000) * 100), contextWindow: 1_000_000, contextWindowSource: 'cli',
      }, ['main-ai'], { source: 'session-runner' })
    },
    live: () => emitLive({
      kind: 'tool', tool: 'Bash', target: `bun run test:focus area-${toolSeq}`, since: new Date().toISOString(),
      turnStartedAt: new Date(turnStart).toISOString(), lastToolAt: new Date().toISOString(), sessionId: sid,
    }),
    background: () => {
      const running = toolSeq % 4 !== 0
      bus.emit(EventNames.SESSION_BACKGROUND_TASKS, {
        sessionId: sid, taskId, inFlight: running ? 1 : 0, foregroundActive: true,
        tasks: [{ taskId: `bg_soak_${turn}`, description: 'Run the whole quick tier', taskType: 'local_shell',
          status: running ? 'running' : 'completed', startedAt: turnStart, toolUseId: `toolu_soak_${turn}_0` }],
        phases: [], agents: [],
      }, ['main-ai', 'web-ui'], { source: 'session-runner' })
    },
    status: () => emitStatus('running', toolSeq % 2 ? 'tool:Bash' : 'thinking'),
  }
  const slots: Array<{ at: number; step: Step }> = content.map((step, k) => ({ at: (k + 0.5) / content.length, step }))
  const readoutCounts: Record<string, number> = {
    speed: per(PER_HOUR.speed), usage: per(PER_HOUR.usage), live: per(PER_HOUR.live) - 2,
    background: per(PER_HOUR.background), status: per(PER_HOUR.status) - 2,
  }
  for (const [kind, n] of Object.entries(readoutCounts)) {
    for (let j = 0; j < n; j += 1) slots.push({ at: (j + 0.5) / n, step: readout[kind]! })
  }
  slots.sort((a, b) => a.at - b.at)

  return [
    () => emitStatus('running', 'thinking'),
    () => emitLive({ kind: 'thinking', since: new Date().toISOString(), turnStartedAt: new Date(turnStart).toISOString(), sessionId: sid }),
    ...slots.map((s) => s.step),
    async () => {
      // The CLI writes its transcript as it goes; the turn is in it by the time its result lands.
      const at = Date.now()
      await fs.appendFile(jsonlPath, [
        transcriptLine('user', turnStart, `soak replay turn ${turn + 1}`),
        ...transcript,
      ].join('\n') + '\n')
      bus.emit(EventNames.SESSION_RESULT, {
        sessionId: sid, taskId, result: finalText.at(-1) ?? '', isError: false, duration: at - turnStart,
        usage: { input_tokens: 4000, output_tokens: outputTokens },
      }, ['main-ai', 'session-runner'], { source: 'session-runner' })
    },
    () => emitStatus('idle', null),
    () => emitLive(null),
  ]
}

/** Turns across replays, so a later replay never reuses a message id. */
let turnSeq = 0

async function replay(hours: number): Promise<Record<string, number>> {
  const counts: Record<string, number> = { cron: 0, task: 0, session: 0 }
  const cronTotal = Math.round(PER_HOUR.cron * hours)
  const taskTotal = Math.round(PER_HOUR.task * hours)
  const openTasks = taskIds.filter((_, i) => PHASES[i % PHASES.length] !== 'COMPLETE')
  const triggerIds = routineIds.slice(0, TRIGGER_COUNT)
  // Turns are built lazily, one after another, so each starts on its own clock.
  const turns = Math.max(1, Math.round(hours * TURNS_PER_HOUR))
  const perTurn = turnSteps(0).length
  const sessionTotal = perTurn * turns
  let turn = 0
  let queue: Step[] = []
  let sessionDone = 0
  let taskDone = 0
  const started = Date.now()
  for (let tick = 0; tick < cronTotal; tick += 1) {
    const tickStart = Date.now()
    const sessionUntil = Math.floor(((tick + 1) * sessionTotal) / cronTotal)
    while (sessionDone < sessionUntil) {
      if (queue.length === 0) {
        if (turn >= turns) break
        queue = turnSteps(turnSeq)
        turnSeq += 1
        turn += 1
      }
      await queue.shift()!()
      sessionDone += 1
      counts.session += 1
    }
    const taskUntil = Math.floor(((tick + 1) * taskTotal) / cronTotal)
    while (taskDone < taskUntil) {
      const id = openTasks[taskDone % openTasks.length]!
      await updateTaskRaw(id, { summary: `${words(2)} (update ${taskDone + 1})` }, { emitEvent: true, source: 'session' })
      taskDone += 1
      counts.task += 1
    }
    // The payload a quiet trigger check sends (trigger-apply.ts), through the cron service's onEvent path.
    const jobId = triggerIds[Math.floor(rand() * triggerIds.length)]!
    broadcastEvent(`${EventNames.CRON_JOB_UPDATED}`, { jobId, action: 'updated', nextRunAtMs: Date.now() + 600_000 })
    counts.cron += 1
    const left = TICK_MS - (Date.now() - tickStart)
    if (left > 0) await new Promise((resolve) => setTimeout(resolve, left))
  }
  // Whatever of the last turn is left, so the session ends idle.
  while (queue.length > 0) { await queue.shift()!(); counts.session += 1 }
  counts.turns = turn
  counts.ms = Date.now() - started
  return counts
}

const replayRequest = path.join(tmpBase, 'soak-replay.json')
let replaying = false
setInterval(() => {
  if (replaying) return
  void fs.readFile(replayRequest, 'utf8').then(async (text) => {
    replaying = true
    await fs.rm(replayRequest, { force: true })
    await fs.rm(path.join(tmpBase, 'soak-replay-done.json'), { force: true })
    const { hours } = JSON.parse(text) as { hours: number }
    const counts = await replay(hours)
    await fs.writeFile(path.join(tmpBase, 'soak-replay-done.json'), JSON.stringify({ hours, ...counts }))
    replaying = false
  }, () => { /* no request */ })
}, 250).unref()

const fixture = { port, built: BUILT, home: tmpBase, liveTaskId: LIVE_TASK, liveSessionId: LIVE_SESSION, liveTitle: LIVE_TITLE, routines: ROUTINE_COUNT, tasks: tasks.length, listBytes }
await fs.writeFile(path.join(tmpBase, 'fixture.json'), JSON.stringify(fixture, null, 2))
console.log(`SOAK_READY ${JSON.stringify(fixture)}`)

const shutdown = async () => {
  await viteServer?.close().catch(() => {})
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
// The server's own signal handler would re-raise the signal and end the process before shutdown()
// removed anything (no 'exit' handler runs then); this one ends it.
armGracefulSignalExit()
// Last word on the data home, as test-server.ts: the server's own exit handlers write into it
// after shutdown() removed it. 'exit' handlers run in
// registration order, so this one, registered after startServer()'s, runs last.
process.on('exit', () => {
  for (const dir of [tmpBase, webBuildDir]) {
    try { fsSync.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) } catch { /* best effort */ }
  }
})
