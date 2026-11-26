/**
 * The list and run answers of trigger, health, plugin, MCP, time, approval and copy ops are
 * small for an agent, and whole for everyone else (src/ops/answer.ts).
 *
 * 2026-11-21: seven days of sessions measured trigger_list answering up to 91,700 characters,
 * health_monitor 51,700, feature_node_connections 46,800, health_alarm_set (a write) 40,000,
 * mcp_servers 36,000, health_sleep 36,000 and plugin_settings 21,000. Each op now gives its
 * own compact form (`answer.shape`). Each case below builds the op's real result from a dense
 * fixture shaped like its route's answer, and checks that the agent's answer fits its cap,
 * keeps the fields an agent decides on, names what it left out with the call that reads it, and
 * that `_full` returns the result untouched.
 */
import { describe, it, expect } from 'vitest'
import { getOp } from '../../src/ops/index.js'
import { agentAnswer as answerOn, answerPolicy, ANSWER_CEILING_CHARS } from '../../src/ops/answer.js'
import type { WalnutOp } from '../../src/ops/registry.js'

/** Each op's own shape under its own cap, as an MCP tool answers it (answer-policy.test.ts holds every op to the CLI's smaller cap too). */
const agentAnswer = (op: Parameters<typeof answerOn>[0], args: Record<string, unknown>, result: unknown, full = false): unknown => answerOn(op, args, result, full, 'mcp')

type Rec = Record<string, unknown>
type Call = (method: string, path: string, body?: unknown) => Promise<unknown>

const size = (v: unknown): number => JSON.stringify(v).length
const op = (name: string): WalnutOp => {
  const found = getOp(name)
  if (!found) throw new Error(`no op ${name}`)
  return found
}
const words = (n: number, seed = 'word'): string => Array.from({ length: n }, (_, i) => `${seed}${i % 17}`).join(' ')
const NOW = Date.parse('2026-11-21T18:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()

/** The agent's answer, held to the op's policy; and `_full` returns the very result. */
function answer(name: string, args: Rec, result: unknown): Rec {
  const o = op(name)
  expect(agentAnswer(o, args, result, true)).toBe(result)
  const a = agentAnswer(o, args, result) as Rec
  expect(size(a), `${name}: ${size(a)} > ${answerPolicy(o).max}`).toBeLessThanOrEqual(answerPolicy(o).max)
  return a
}

/** A handler op's result against a stub server. */
async function handled(name: string, args: Rec, call: Call): Promise<unknown> {
  return op(name).handler!(args, call as never)
}

const mapped = (name: string, body: unknown, args: Rec = {}): unknown => op(name).mapResult!({ body, args })

// ── triggers ──

function job(i: number): Rec {
  const at = NOW - i * 60_000
  return {
    id: `rt_${String(i).padStart(4, '0')}`,
    name: `PR ${100 + i} review comments`,
    description: `Checks PR ${100 + i} for new review comments every 5 minutes; when one arrives, the session addresses it and replies on the PR. ${words(30)}`,
    enabled: i % 7 !== 0,
    schedule: { kind: 'every', everyMs: 300_000 },
    check: { run: `bash ~/.open-walnut/triggers/pr-${i}/check.sh --repo org/repo --pr ${100 + i} ${words(40)}`, host: 'devbox', cwd: '/home/u/work', timeoutSeconds: 60 },
    executor: { type: 'session', config: { target: `task-${i}`, prompt: `When a new comment arrives: read it, fix the code, push, reply. ${words(300)}` } },
    state: {
      lastCheck: { atMs: at, outcome: i % 5 === 0 ? 'error' : 'quiet', reason: 'fire-false', durationMs: 4_000, ...(i % 5 === 0 ? { error: `exit 1: ${words(60)}` } : {}) },
      nextRunAtMs: at + 300_000,
      fireCount: i,
      checkLog: Array.from({ length: 6 }, (_, k) => ({ atMs: at - k * 300_000, outcome: 'fired', items: 2, injected: words(200), epoch: 3, durationMs: 3_000 })),
      fireLog: Array.from({ length: 4 }, (_, k) => ({ atMs: at - k * 600_000, items: 1, delivery: { status: 'ok' }, coalesced: 1 })),
    },
  }
}

describe('trigger_list', () => {
  const jobs = Array.from({ length: 120 }, (_, i) => job(i + 1))
  const call: Call = async (_m, path) => (path.startsWith('/routines') ? { jobs } : {})

  it('a full list keeps the newest rows that fit and names the call for the rest and for one whole', async () => {
    const args = { full: true, limit: 60 }
    const result = await handled('trigger_list', args, call) as Rec
    expect(size(result)).toBeGreaterThan(90_000)
    const a = answer('trigger_list', args, result)
    const rows = a.triggers as Rec[]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].id).toBe((result.triggers as Rec[])[0].id)
    expect(a.count).toBe(120)
    expect(a.more).toBe(120 - rows.length)
    expect(String(a.hint)).toContain('trigger_list {"name":"<its id>","full":true}')
  })

  it('the compact list keeps each row its state, last check and task', async () => {
    const args = { limit: 100 }
    const result = await handled('trigger_list', args, call) as Rec
    const a = answer('trigger_list', args, result)
    const row = (a.triggers as Rec[])[0]
    expect(row).toMatchObject({ id: expect.any(String), state: expect.any(String), task: expect.any(String), last: expect.any(String) })
    expect(Number(a.more)).toBeGreaterThan(0)
    // The route's limit sentence is replaced by one that counts both what the limit and the cap left out.
    expect(String(a.hint)).not.toMatch(/raise limit/)
  })

  it('a list that fits is answered as it is', async () => {
    const result = await handled('trigger_list', { name: 'PR 101 ' }, call)
    expect(agentAnswer(op('trigger_list'), { name: 'PR 101 ' }, result)).toEqual(result)
  })
})

describe('trigger_create', () => {
  it('answers the trigger in a few facts, never the script, prompt and description it was sent', () => {
    const j = job(3)
    const body = {
      job: j, host: 'devbox', nextCheckAt: null,
      wait: { parked: true, task_id: 'task-3', wait_until: '2026-11-21T22:00:00.000Z' },
      timeLimit: { seconds: 60, tested: { durationMs: 4_000, seconds: 60, killed: false, at: iso(NOW) } },
    }
    const args = { run: (j.check as Rec).run, every: '5m', prompt: (j.executor as Rec & { config: Rec }).config.prompt, description: j.description, wait: true }
    const result = mapped('trigger_create', body, args) as Rec
    const a = answer('trigger_create', args, result)
    expect(answerPolicy(op('trigger_create')).kind).toBe('content')
    expect(a).toMatchObject({ id: j.id, name: j.name, host: 'devbox', every: '5m', task: 'task-3', wait: { parked: true }, timeLimit: { seconds: 60 } })
    expect(a.outcome).toBe(result.outcome)
    expect(a.next).toBe(result.next)
    expect(a.job).toBeUndefined()
    expect(JSON.stringify(a)).not.toContain('When a new comment arrives')
    expect(size(a)).toBeLessThan(size(result) / 2)
  })
})

describe('trigger_test', () => {
  it('keeps the END of each tail, the verdict and the head of a long item list', async () => {
    const lastLine = '{"fire":true,"items":[{"id":"c-1"}]}'
    const items = Array.from({ length: 150 }, (_, i) => ({ id: `comment-${i}`, title: words(8) }))
    const body = {
      result: {
        ok: true, exitCode: 0, durationMs: 12_000,
        stdoutTail: `${words(1_500, 'log')}\n${lastLine}`, stderrTail: words(1_400, 'warn'),
        parsed: { fire: true, items, input: words(800), state: { cursor: words(300) }, hasState: true },
        error: null, wouldFire: true, newItemCount: 150,
      },
      timeLimit: { seconds: 60, durationMs: 12_000, line: 'ran 12 s of its 60 s limit' },
    }
    const args = { run: 'bash check.sh' }
    const result = await handled('trigger_test', args, async () => body) as Rec
    expect(size(result)).toBeGreaterThan(20_000)
    const a = answer('trigger_test', args, result)
    const run = a.result as Rec
    // What the script printed rides the outside-data envelope; the verdict stays beside it.
    const output = ((run.output as Rec).external_content as Rec).data as Rec
    expect(((run.output as Rec).external_content as Rec).trust).toBe('untrusted')
    expect(run).not.toHaveProperty('stdoutTail')
    expect(String(output.stdoutTail).endsWith(lastLine)).toBe(true)
    expect(run).toMatchObject({ wouldFire: true, newItemCount: 150, exitCode: 0 })
    expect((output.parsed as Rec).itemCount).toBe(150)
    expect(((output.parsed as Rec).items as unknown[]).length).toBe(20)
    expect(String(a.shortened)).toContain('"_full": true')
    expect(a.outcome).toBe(result.outcome)
  })
})

// ── health monitor ──

function alarm(i: number, state: string): Rec {
  return {
    id: i % 3 ? `host.link{host=box-${i}}` : `log.spike:warn ${words(12)} ${i}`,
    defId: i % 3 ? 'host.link' : 'log.spike',
    title: i % 3 ? 'Host link drops' : 'Log line far above its normal',
    description: words(40),
    state, since: NOW - i * 3_600_000, value: i, unit: 'per hour',
    condition: 'max > 3 per hour, 2 of 3 periods of 15 min',
    ...(i % 3 ? { labels: { host: `box-${i}` } } : { signature: `warn ${words(30)}` }),
    spark: Array.from({ length: 96 }, (_, k) => (k % 5 ? k / 3 : null)),
    actions: state === 'ALARM' ? [{ at: NOW, kind: 'fix-task', ok: true, detail: words(40), taskId: `fix-${i}` }] : [],
    ...(state === 'ALARM' ? { fixTaskId: `fix-${i}` } : {}),
    ...(i % 4 === 0 ? { override: { mutedUntil: NOW + 3_600_000, by: 'human', at: NOW } } : {}),
    held: i % 4 === 0,
  }
}

function detail(id: string): Rec {
  return {
    ...alarm(1, 'ALARM'), id,
    history: Array.from({ length: 40 }, (_, k) => ({ at: NOW - k * 3_600_000, from: 'OK', to: 'ALARM', value: k, reason: words(20) })),
    series: Array.from({ length: 1_440 }, (_, k) => ({ t: NOW - (1_440 - k) * 60_000, v: k % 7 ? k / 10 : null })),
    sample: words(200),
  }
}

describe('health_monitor', () => {
  const states = ['ALARM', 'ALARM', 'INSUFFICIENT_DATA', ...Array.from({ length: 80 }, () => 'OK')]
  const body = {
    checkedAt: NOW, actions: true, counts: { OK: 80, ALARM: 2, INSUFFICIENT_DATA: 1 }, fixesToday: 1, fixesPerDay: 6,
    alarms: states.map((s, i) => alarm(i + 1, s)), fixTasks: 'record',
  }

  it('lists every alarm in a line, ALARM first, and names the calls for the rest and for one whole', () => {
    const result = mapped('health_monitor', body) as Rec
    expect(size(result)).toBeGreaterThan(50_000)
    const a = answer('health_monitor', {}, result)
    const rows = a.alarms as Rec[]
    expect(rows[0]).toMatchObject({ state: 'ALARM', fixTaskId: expect.any(String), lastAction: expect.stringContaining('fix-task ok') })
    expect(rows[0].spark).toBeUndefined()
    expect(a.counts).toEqual(body.counts)
    expect(a.outcome).toBe('2 alarms in ALARM.')
    const said = String(a.more ?? a.detail)
    expect(said).toContain('health_monitor {"alarm":"<id>"}')
  })

  it('`state` narrows the list for every caller', () => {
    const result = mapped('health_monitor', body, { state: 'ALARM' }) as Rec
    expect((result.alarms as Rec[]).map((r) => r.state)).toEqual(['ALARM', 'ALARM'])
  })

  it('one alarm keeps its spark, a series summary and its newest history, and says how to read every point', () => {
    const args = { alarm: 'host.link{host=box-1}' }
    const result = mapped('health_monitor', detail(args.alarm), args) as Rec
    expect(size(result)).toBeGreaterThan(40_000)
    const a = answer('health_monitor', args, result)
    expect(a).toMatchObject({ id: args.alarm, state: 'ALARM', series: { points: 1_440 }, historyCount: 40 })
    expect((a.history as unknown[]).length).toBe(10)
    expect(String(a.more)).toContain('"_full": true')
  })

  it('health_alarm_set answers a receipt: the change and the alarm\'s state, never its series', () => {
    const id = 'host.link{host=box-1}'
    const body = { id, override: { mutedUntil: NOW + 7_200_000, by: 'task:t-1', at: NOW }, alarm: detail(id) }
    const result = mapped('health_alarm_set', body, { id, muted_for: '2h' }) as Rec
    expect(size(result)).toBeGreaterThan(40_000)
    expect(answerPolicy(op('health_alarm_set')).kind).toBe('receipt')
    const a = answer('health_alarm_set', { id, muted_for: '2h' }, result)
    expect(a).toMatchObject({ id, override: { mutedUntil: NOW + 7_200_000 }, alarm: { state: 'ALARM', fixTaskId: 'fix-1' }, outcome: 'The alarm was changed.' })
    expect(a._cut).toBeUndefined()
  })
})

// ── Apple Health sleep ──

function night(date: string, stages: boolean): Rec {
  return {
    date, status: 'ok', tz: 'America/Los_Angeles',
    bedtime: `${date}T06:40:00.000Z`, wake: `${date}T14:10:00.000Z`,
    inBedMin: 450, asleepMin: 410, awakeMin: 40, stages: { deepMin: 60, coreMin: 250, remMin: 100, unspecifiedMin: 0 },
    stagesCoverage: 1, efficiency: 0.91, efficiencyBasis: 'inBed', awakenings: 3,
    sleepingHr: 54, hrvSdnn: 48, respiratoryRate: 14, spo2: 96, wristTemp: 0.1,
    primarySource: { bundleId: 'com.apple.health.watch', name: 'Apple Watch' },
    otherSources: [{ key: 'k1', bundleId: 'com.example.sleep', name: 'Sleep App', asleepMin: 400, usedMin: 0 }],
    naps: [], hypnogram: stages ? Array.from({ length: 60 }, (_, k) => ({ start: `${date}T07:${String(k % 60).padStart(2, '0')}:00-08:00`, end: `${date}T07:${String((k + 1) % 60).padStart(2, '0')}:00-08:00`, stage: ['core', 'deep', 'rem', 'awake'][k % 4] })) : [],
  }
}

describe('health_sleep', () => {
  const dates = Array.from({ length: 30 }, (_, i) => iso(NOW - (29 - i) * 86_400_000).slice(0, 10))
  const body = {
    tz: 'America/Los_Angeles', nights: dates.map((d) => night(d, true)),
    averages: { n: 30, asleepMin: 410 }, baseline28: { from: '2026-09-24', to: '2026-10-21', n: 28, asleepMin: 400 },
    units: { asleepMin: 'min' }, preferredUnits: { distance: 'km' },
    caveats: ['Sleep stages come from consumer wearables; they are estimates, not a sleep study.', 'HRV here is SDNN, not RMSSD.'],
  }

  it('keeps the newest nights that fit, the caveats and averages whole, and names the call for the older ones', () => {
    const args = { last_nights: 30, detail: 'stages' }
    expect(size(body)).toBeGreaterThan(36_000)
    const a = answer('health_sleep', args, body)
    const nights = a.nights as Rec[]
    expect(nights[nights.length - 1].date).toBe(dates[29])
    expect(nights[0]).toMatchObject({ asleepMin: 410, source: 'Apple Watch', stages: { deepMin: 60 } })
    expect(String((nights[0].hypnogram as string[])[0])).toMatch(/^\d{2}:\d{2}-\d{2}:\d{2} core$/)
    expect(a.caveats).toEqual(body.caveats)
    expect(a.averages).toEqual(body.averages)
    expect(Number(a.olderNights)).toBe(30 - nights.length)
    expect(String(a.more)).toContain(`health_sleep {"from":"${dates[0]}"`)
  })
})

// ── plugins and MCP servers ──

describe('plugin_settings', () => {
  const fields = Array.from({ length: 40 }, (_, i) => ({
    key: `setting_${i}`, label: `Setting ${i}`, help: words(80), type: i % 3 ? 'string' : 'array', declared: true,
    required: i < 2, secret: i === 5, set: true,
    value: i % 3 ? `value ${i}` : Array.from({ length: 40 }, (_, k) => `#channel-${k}`),
    ...(i % 3 ? {} : { items: { type: 'string', description: words(40) } }),
    ...(i === 7 ? { enum: Array.from({ length: 60 }, (_, k) => `choice-${k}`) } : {}),
  }))
  const view = {
    id: 'chat', name: 'Chat', description: words(40), status: 'loaded', missing: [], settingsIn: 'plugins',
    page: '/apps/chat', fields, tools: Array.from({ length: 30 }, (_, i) => `chat_tool_${i}`), skills: true, signIn: true,
  }
  const call: Call = async () => view

  it('one plugin reads a line per setting, every key named; a long value says how to read it with key', async () => {
    const result = await handled('plugin_settings', { plugin: 'chat' }, call) as Rec
    expect(size(result)).toBeGreaterThan(20_000)
    const a = answer('plugin_settings', { plugin: 'chat' }, result)
    const rows = a.fields as Rec[]
    expect(rows[0]).toMatchObject({ key: 'setting_0', required: true, set: true, value: expect.stringContaining('read it with key'), schema: expect.any(String) })
    expect(rows[1]).toMatchObject({ key: 'setting_1', value: 'value 1' })
    expect([...rows.map((f) => f.key), ...((a.moreKeys as string[] | undefined) ?? [])]).toEqual(fields.map((f) => f.key))
    if (a.moreKeys) expect(String(a.more)).toContain('plugin_settings {"plugin":"chat","key":"<key>"}')
    expect(a.page).toBe('/apps/chat')
    expect(a._cut).toBeUndefined()
  })

  it('`key` answers that one setting whole', async () => {
    const result = await handled('plugin_settings', { plugin: 'chat', key: 'setting_0' }, call) as Rec
    expect((result.fields as Rec[]).map((f) => f.key)).toEqual(['setting_0'])
    const a = answer('plugin_settings', { plugin: 'chat', key: 'setting_0' }, result)
    expect(((a.fields as Rec[])[0].value as unknown[]).length).toBe(40)
    const none = await handled('plugin_settings', { plugin: 'chat', key: 'nope' }, call) as Rec
    expect(String(none.hint)).toContain('setting_1')
  })
})

describe('mcp_servers', () => {
  const body = {
    servers: Array.from({ length: 90 }, (_, i) => ({
      name: `server-${i}`, title: `Server ${i}`, owner: `plugin-${i % 9}`, state: i % 4 ? 'ready' : 'failed', since: NOW,
      sessions: i % 2 ? 'read-only' : 'all', toolCount: 12, serverInfo: { name: `srv-${i}`, version: '1.2.3' },
      ...(i % 4 ? {} : { lastError: `The MCP server "Server ${i}" could not start: ${words(70)}` }),
    })),
  }

  it('lists the servers in a few facts, every one named, a failure reason cut to its head with the call that reads it', () => {
    const result = mapped('mcp_servers', body, {}) as Rec
    expect(size(result)).toBeGreaterThan(25_000)
    const a = answer('mcp_servers', {}, result)
    const rows = a.servers as Rec[]
    expect(rows[0]).toMatchObject({ name: 'server-0', state: 'failed', sessions: 'all', toolCount: 12 })
    // The head, then Walnut's cut mark (answer.ts cutMark), so a write can tell it from the whole reason.
    expect(String(rows[0].lastError)).toMatch(/^.{1,120}… \[Walnut cut: \d+ more characters\]$/s)
    expect([...rows.map((r) => r.name), ...((a.moreServers as string[] | undefined) ?? [])]).toEqual(body.servers.map((r) => r.name))
    expect(a.count).toBe(90)
    expect(String(a.more)).toContain('mcp_servers {"server":"<name>"}')
    expect(a._cut).toBeUndefined()
  })

  it('`server` narrows the list for every caller and answers those servers whole', () => {
    const result = mapped('mcp_servers', body, { server: 'server-8' }) as Rec
    expect((result.servers as Rec[]).map((s) => s.name)).toEqual(['server-8', 'server-80', 'server-81', 'server-82', 'server-83', 'server-84', 'server-85', 'server-86', 'server-87', 'server-88', 'server-89'])
    const a = answer('mcp_servers', { server: 'server-8' }, result)
    expect((a.servers as Rec[])[0].serverInfo).toEqual({ name: 'srv-8', version: '1.2.3' })
  })

  it('mcp_read pages a long text answer and names the call that reads on; mcp_call answers content', () => {
    const text = Array.from({ length: 400 }, (_, i) => `## Part ${i}\n${words(30)}`).join('\n')
    const args = { server: 'docs', tool: 'read_doc', arguments: { id: 'd-1' } }
    const result = { isError: false, text }
    const a = answer('mcp_read', args, result)
    expect(String(a.text).length).toBeLessThan(text.length)
    expect(String((a.page as Rec).next)).toContain('mcp_read {"server":"docs","tool":"read_doc","arguments":{"id":"d-1"},"offset":')
    expect(answerPolicy(op('mcp_call'))).toMatchObject({ kind: 'content', max: 12_000 })
  })
})

// ── feature-node journal ──

describe('feature_node_connections', () => {
  const events = Array.from({ length: 1_000 }, (_, i) => (i % 10 === 0
    ? { at: iso(NOW - (1_000 - i) * 60_000), type: 'server_stopping', reason: 'deploy', build: 'b1' }
    : { at: iso(NOW - (1_000 - i) * 60_000), type: i % 2 ? 'connected' : 'disconnected', nodeId: `node-${i % 4}`, generation: `g-${i}`, cause: 'abnormal', closeCode: 1006, connectedForMs: 90_000 }))

  it('keeps the newest events as lines, oldest first, and names the call for the older ones', () => {
    const args = { limit: 1_000 }
    const result = mapped('feature_node_connections', { events, truncated: false, now: iso(NOW), current: null }, args) as Rec
    expect(size(result)).toBeGreaterThan(46_000)
    const a = answer('feature_node_connections', args, result)
    const lines = a.events as string[]
    expect(lines[lines.length - 1]).toContain((events[999] as Rec).at as string)
    expect(lines[0] < lines[lines.length - 1]).toBe(true)
    expect(Number(a.older)).toBe(1_000 - lines.length)
    expect(String(a.more)).toContain('feature_node_connections {"limit":1000,"_full":true}')
    expect(a.outcome).toBe(result.outcome)
  })
})

// ── time report ──

function taskMeta(i: number): Rec {
  return { taskId: `task-${i}`, title: `Task number ${i}: ${words(20)}`, project: 'Walnut', phase: 'IN_PROGRESS', createdAt: iso(NOW - i * 86_400_000), createdBeforeRange: true, parentTaskId: `parent-${i}`, source: 'local' }
}

describe('time_report', () => {
  const split = { min: 120, workMin: 100, offMin: 20, shareOfDay: 0.2, workShare: 0.25 }
  const days = Array.from({ length: 31 }, (_, i) => ({
    date: iso(NOW - (30 - i) * 86_400_000).slice(0, 10), weekday: 'Mon', workday: true,
    walnutMin: 200, workMin: 150, offMin: 50, agentMin: 300, readingMin: 30,
    byKind: { session: 100, triage: 20, chat: 50, app: 30, agent: 300 },
    outside: { min: 240, workMin: 200, walnutForegroundMin: 180, topApps: Array.from({ length: 5 }, (_, k) => ({ app: `App ${k}`, min: 40 - k, workMin: 30 })) },
    attentionMin: 470, attentionWorkMin: 380, callMin: 60, callWorkMin: 50, sent: { count: 12, chars: 3_000 },
    topTasks: [1, 2, 3].map((k) => ({ ...taskMeta(k), min: 50, workMin: 40 })),
    fragmentation: { tasks: 9, switches: 40, switchesPerHour: 6, longest: { min: 80, taskId: 'task-1', start: '09:00', end: '10:20' }, deepMin: 80, deepShare: 0.3 },
  }))
  const body = {
    from: days[0].date, to: days[30].date, dayCount: 31,
    workHours: { start: '09:00', end: '18:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'], label: '09:00-18:00 Mon-Fri', source: 'default' },
    kinds: ['session', 'triage', 'chat', 'app'],
    totals: { denominator: 'attention', wholeDay: { walnutMin: 6_200, attentionMin: 14_000, agentMin: 9_000 }, workHours: { walnutMin: 4_600, shareOfDay: 0.8 }, offHours: { walnutMin: 1_600 }, byKind: { session: 3_000 } },
    days,
    groups: {
      task: { rows: Array.from({ length: 15 }, (_, i) => ({ ...taskMeta(i), ...split, agentMin: 30, days: 5, readingMin: 10, sent: 4 })), otherMin: 300, more: 40 },
      project: { rows: Array.from({ length: 15 }, (_, i) => ({ project: `Project ${i}`, ...split, agentMin: 30, tasks: 4, days: 9 })), otherMin: 100, more: 3 },
      app: { rows: Array.from({ length: 15 }, (_, i) => ({ app: `App ${i}`, bundleId: `com.example.app${i}`, ...split, days: 20, topHosts: Array.from({ length: 5 }, (_, k) => ({ host: `site${k}.example.com`, min: 10, workMin: 8 })) })), otherMin: 50, more: 9 },
      hour: Array.from({ length: 24 }, (_, h) => ({ hour: h, walnutMin: 30, outsideMin: 20 })),
    },
    fragmentation: { activeDays: 31, avgTasksPerDay: 9, avgSwitchesPerDay: 40, switchesPerHour: 6, deepShare: 0.3, longest: { min: 80, taskId: 'task-1', start: '09:00', end: '10:20', ...taskMeta(1) }, rules: { mergeGapMin: 5, longMin: 45, glanceSec: 20 } },
    today: days[30].date,
    notes: Array.from({ length: 6 }, () => words(40)),
  }

  it('a week of the default groups keeps every total, group row and day in its numbers', () => {
    const week = { ...body, days: days.slice(-7), dayCount: 7, groups: { task: body.groups.task, project: body.groups.project } }
    const a = answer('time_report', {}, week)
    expect(a.totals).toEqual(body.totals)
    const groups = a.groups as Record<string, Rec>
    expect((groups.task.rows as Rec[])).toHaveLength(15)
    expect((groups.task.rows as Rec[])[0]).toMatchObject({ taskId: 'task-0', project: 'Walnut', min: 120, workMin: 100, workShare: 0.25 })
    expect((groups.task.rows as Rec[])[0].parentTaskId).toBeUndefined()
    expect((groups.project.rows as Rec[])).toHaveLength(15)
    // Each day keeps its numbers: as a row, or as one line when the rows (titles cut with Walnut's mark) leave no room.
    const day = (a.days as unknown[])[6]
    if (typeof day === 'string') {
      expect(day).toContain(`${days[30].date} Mon: walnut 200m (work hours 150m), attention 470m`)
    } else {
      expect(day).toMatchObject({ date: days[30].date, walnutMin: 200, attentionMin: 470, fragmentation: { switches: 40, longestMin: 80 } })
      expect(((day as Rec).topTasks as string[])[0]).toBe('task-1 50m')
    }
    expect(String(a.notes)).toContain('"_full": true')
    expect(a._cut).toBeUndefined()
  })

  it('a month of four groups keeps every total, each day in a line and the biggest rows, the rest summed in otherMin', () => {
    const args = { last_days: 31, group_by: 'task,project,app,hour' }
    expect(size(body)).toBeGreaterThan(30_000)
    const a = answer('time_report', args, body)
    expect(a.totals).toEqual(body.totals)
    expect((a.days as string[])).toHaveLength(31)
    expect((a.days as string[])[30]).toContain(`${days[30].date} Mon: walnut 200m`)
    const task = (a.groups as Record<string, Rec>).task
    const kept = (task.rows as Rec[]).length
    expect(kept).toBeLessThan(15)
    expect(task.more).toBe(40 + 15 - kept)
    expect(task.otherMin).toBe(300 + (15 - kept) * 120)
    expect(String(a.shortened)).toContain('"top":15')
    expect(a._cut).toBeUndefined()
  })
})

// ── approvals ──

function approval(i: number, status: string): Rec {
  return {
    id: `ap-${i}`, what: `Push the release branch ${i}`, detail: `git push origin release-${i}\n${words(900)}`,
    digest: 'a'.repeat(64), mode: 'tap',
    requester: { host: 'devbox', taskId: `task-${i}`, taskTitle: `Release ${i}: ${words(30)}`, sessionId: `s-${i}`, cwd: '/home/u/repo', command: 'walnut approve' },
    createdAt: iso(NOW - i * 60_000), expiresAt: iso(NOW + 600_000), status,
    ...(status === 'approved' ? { answer: { decision: 'approve', at: iso(NOW), mode: 'tap', device: { id: 'd-1', name: 'iPhone', kind: 'iphone' } } } : {}),
    context: { why: words(40), whyFrom: 'asker', goal: words(30), project: 'Walnut', steps: Array.from({ length: 3 }, () => ({ role: 'assistant', text: words(40) })) },
    ...(i % 2 ? { singleUse: true } : {}),
  }
}

describe('approval_list and approval_wait', () => {
  const all = Array.from({ length: 120 }, (_, i) => approval(i, i % 3 ? 'approved' : 'pending'))
  const call: Call = async (_m, path) => (path.startsWith('/approvals/')
    ? { approval: all.find((a) => path.endsWith(`/${String(a.id)}`)) }
    : { approvals: all, keys: [], askMe: true })

  it('a list answers the newest rows with the head of each detail, and names the calls for more and for one whole', async () => {
    const args = { status: 'all' }
    const result = await handled('approval_list', args, call) as Rec
    expect(size(result)).toBeGreaterThan(300_000)
    const a = answer('approval_list', args, result)
    const rows = a.approvals as Rec[]
    expect(rows).toHaveLength(10)
    expect(rows[1]).toMatchObject({ id: 'ap-1', status: 'approved', singleUse: true, digest: 'a'.repeat(64), answer: expect.stringContaining('approve at'), asker: { taskId: 'task-1' } })
    expect(Number(rows[0].detailChars)).toBeGreaterThan(5_000)
    expect(a.askMe).toBe(true)
    expect(a.more).toBe(110)
    expect(String(a.next)).toContain('approval_list {"status":"all","limit":120}')
    expect(String(a.detail)).toContain('approval_list {"id":"<id>"}')
  })

  it('`id` answers one approval whole; `limit` narrows the list for every caller', async () => {
    const one = await handled('approval_list', { id: 'ap-4' }, call) as Rec
    expect((one.approval as Rec).detail).toBe(all[4].detail)
    const few = await handled('approval_list', { limit: 3 }, call) as Rec
    expect(few).toMatchObject({ count: 120 })
    expect((few.approvals as unknown[])).toHaveLength(3)
  })

  it('approval_wait answers the decision with the detail cut to a head; a single_use one is answered whole for approval_consume', () => {
    // Room for a single-use record whole (its asker checks every field: cli-core.ts singleUseProblem).
    expect(answerPolicy(op('approval_wait'))).toMatchObject({ kind: 'content', max: ANSWER_CEILING_CHARS })
    const result = mapped('approval_wait', { approval: approval(2, 'approved'), used: true }) as Rec
    const a = answer('approval_wait', { id: 'ap-2', token: 't' }, result)
    expect(a).toMatchObject({ used: true, approval: { id: 'ap-2', status: 'approved' }, outcome: result.outcome, next: result.next })
    expect(String((a.approval as Rec).detail).length).toBeLessThanOrEqual(200)
    const single = mapped('approval_wait', { approval: approval(1, 'approved'), used: true }) as Rec
    const s = answer('approval_wait', { id: 'ap-1', token: 't' }, single)
    expect(s).toMatchObject({ approval: { id: 'ap-1', singleUse: true, digest: 'a'.repeat(64) } })
    // The record as Walnut keeps it: its detail whole, and the fields the asker checks (2026-11-23, apr-kCUkpVWwmbBH).
    expect((s.approval as Rec).detail).toBe((single.approval as Rec).detail)
    expect(s.approval).toEqual(single.approval)
  })
})

// ── host copy ──

describe('host_copy', () => {
  it('a finished copy says it is done and that nothing more is needed', () => {
    const body = { copyId: 'hc-abcd', running: false, from_host: 'devbox', to_host: 'macbox', from: '~/src.tgz', to: '~/build/src.tgz', bytes: 2_048, sha256: 'b'.repeat(64), ms: 1_200, chunks: 1, retries: 0, replaced: false }
    const a = answer('host_copy', { from: '~/src.tgz', to_host: 'macbox', to: '~/build/' }, mapped('host_copy', body))
    expect(answerPolicy(op('host_copy')).kind).toBe('content')
    expect(String(a.outcome)).toMatch(/^Done: copied 2\.0 KB from devbox:~\/src\.tgz to macbox:~\/build\/src\.tgz/)
    expect(String(a.next)).toContain('do not copy it again')
  })

  it('a copy still going names the exact call that waits for it', () => {
    const body = { copyId: 'hc-abcd', running: true, from_host: 'devbox', to_host: 'macbox', from: '~/big.tgz', to: '~/build/big.tgz', bytes: 900_000_000, sent: 100_000_000, ms: 60_000 }
    const a = answer('host_copy', {}, mapped('host_copy', body))
    expect(String(a.outcome)).toContain('Not done yet')
    expect(String(a.next)).toContain('host_copy_result {"copy_id":"hc-abcd"}')
  })

  it('its description stays short', () => {
    expect(op('host_copy').description.length).toBeLessThanOrEqual(1_600)
  })
})
