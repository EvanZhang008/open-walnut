/**
 * A realistic GET /api/usage/costs answer for browser specs: a busy month with
 * long task titles, many models and hosts, folded short sessions and an
 * unpriced model. The page reads the whole picture (`view=all`, every breakdown
 * per day); the two older views stay for the callers that still ask for them.
 */
const tokens = (n: number) => ({ input: n * 10, output: n * 40, cacheRead: n * 9000, cacheWrite: n * 300 })
const line = (key: string, label: string, costUsd: number, requests: number, unpriced = 0) =>
  ({ key, label, costUsd, requests, tokens: tokens(requests), unpriced })

function days(start: string | null, end: string | null) {
  const out: { date: string; costUsd: number; requests: number }[] = []
  const from = Date.parse(`${start ?? '2026-09-01'}T00:00:00Z`), to = Date.parse(`${end ?? '2026-09-23'}T00:00:00Z`)
  for (let t = from, i = 0; t <= to; t += 86_400_000, i++) out.push({ date: new Date(t).toISOString().slice(0, 10), costUsd: 40 + (i % 5) * 30, requests: 900 + i })
  return out
}

const ENGINES = [{ key: 'claude', label: 'Claude Code' }, { key: 'codex', label: 'Codex' }]

const common = (view: string, start: string | null, end: string | null) => ({
  view, range: { start, end }, engine: null as string | null, engines: [] as { key: string; label: string }[],
  daily: days(start, end), unpricedModels: [] as string[], unpriced: [] as { model: string; where: string; requests: number }[],
  prices: { source: 'litellm', asOf: '2026-10-20T00:00:00.000Z' }, ready: true, timeZone: 'America/Los_Angeles',
  bounds: { min: '2026-09-01', max: '2026-09-23' },
  countedUntil: [{ host: '__local__', until: '2026-09-23T18:00:00.000Z' }, { host: 'devbox', until: '2026-09-23T17:30:00.000Z' }],
  checks: [{ source: 'Canonical transcript', host: '__local__', status: 'matched', matchedCalls: 100, unmatchedCalls: 0, detail: 'Every response counted once.' }],
  collection: { running: false },
})

export const LONG_TITLE = 'Investigate why the nightly export of every archived project to the shared drive keeps timing out after the third retry on the slow host'

/** Each line's cost spread over the period's days, every line with its own shape. */
function perDay(lines: { key: string; costUsd: number }[], start: string | null, end: string | null) {
  const dates = days(start, end).map((d) => d.date)
  const out = dates.map((date) => ({ date, costs: {} as Record<string, number> }))
  lines.forEach((l, k) => {
    const w = dates.map((_, i) => 1 + ((i * (k + 1) + k) % 7))
    const sum = w.reduce((a, b) => a + b, 0)
    dates.forEach((_, i) => { out[i].costs[l.key] = l.costUsd * w[i] / sum })
  })
  return out
}

function wholePicture(start: string | null, end: string | null) {
  const agents = agentsReport('agents', start, end)
  const walnutCost = 68.37
  const total = agents.totals.costUsd + walnutCost
  const scale = (lines: ReturnType<typeof line>[], to: number) => {
    const sum = lines.reduce((n, l) => n + l.costUsd, 0)
    return lines.map((l) => ({ ...l, costUsd: l.costUsd / sum * to }))
  }
  const groups = [
    { id: 'agent', heading: 'By agent', lines: [line('claude', 'Claude Code', agents.totals.costUsd - 120, 60_000), line('walnut', 'Walnut', walnutCost, 3270), line('codex', 'Codex', 120, 1000)] },
    { id: 'model', heading: 'By model', lines: scale(Array.from({ length: 11 }, (_, i) => line(`m${i}`, i === 2 ? 'gpt-6.1-sol' : `claude-model-${i}`, 1000 - i * 80, 3000 - i * 100)), total) },
    { id: 'project', heading: 'By project', lines: [line('Walnut', 'Walnut', (total - walnutCost - 2.4) * 0.7, 40_000), line('Notes', 'Notes', (total - walnutCost - 2.4) * 0.3, 20_000),
      line('__walnut__', 'Walnut itself', walnutCost, 3270), line('', 'Inbox', 2.4, 24)] },
    { id: 'host', heading: 'By host', lines: [line('__local__', '__local__', total * 0.6, 36_000), line('devbox', 'devbox', total * 0.4, 25_000)] },
    { id: 'feature', heading: "By Walnut feature", lines: scale([line('chat', 'Personal AI chat', 61.2, 412), line('title', 'Titles', 3.41, 2210)], walnutCost) },
  ].map((g) => ({ ...g, lines: [...g.lines].sort((a, b) => b.costUsd - a.costUsd), daily: perDay(g.lines, start, end) }))
  const daily = groups[0].daily.map((d) => ({ date: d.date, costUsd: Object.values(d.costs).reduce((a, b) => a + b, 0), requests: 1000 }))
  return { ...agents, view: 'all', engine: null, totals: line('total', 'Total', total, 64_270, 14), daily, groups }
}

export function costReport(view: string, start: string | null, end: string | null, engine: string | null = null) {
  if (view === 'all') return wholePicture(start, end)
  return agentsReport(view, start, end, engine)
}

function agentsReport(view: string, start: string | null, end: string | null, engine: string | null = null) {
  if (view === 'walnut') {
    const features = [line('chat', 'Personal AI chat', 61.2, 412), line('title', 'Titles', 3.41, 2210), line('task-search-agent', 'AI task search', 2.05, 380),
      line('summary', 'Summaries', 1.12, 140), line('plugin:plugin:mail', 'Plugin: mail', 0.4, 60), line('quick-parse', 'Quick add', 0.08, 41),
      line('memory', 'Memory upkeep', 0.05, 12), line('commit-message', 'Commit messages', 0.03, 9), line('transfer', 'Session transfer', 0.02, 4),
      line('jev', 'Decision checks', 0.004, 2)]
    const total = features.reduce((n, l) => n + l.costUsd, 0), requests = features.reduce((n, l) => n + l.requests, 0)
    return { ...common(view, start, end), totals: line('total', 'Total', total, requests + 2, 2),
      unpricedModels: ['unknown'], unpriced: [{ model: 'unknown', where: 'Task overview upkeep', requests: 2 }],
      groups: [{ id: 'feature', heading: 'By feature', lines: features },
        { id: 'model', heading: 'By model', lines: [line('claude-opus-5-5', 'claude-opus-5-5', 61.2, 412), line('claude-haiku-5-5', 'claude-haiku-5-5', total - 61.2, requests - 412)] }] }
  }
  if (engine === 'codex') {
    const task = { ...line('task:t3', 'Coding task 4', 810, 1000), taskId: 't3', sessionId: 's3', project: 'Walnut', hosts: ['devbox'], engines: ['Codex'] }
    return { ...common(view, start, end), engine, engines: ENGINES, totals: line('total', 'Total', 810, 1000),
      daily: days(start, end).map((d) => ({ ...d, costUsd: 5, requests: 7 })), tasks: [task],
      groups: [
        { id: 'model', heading: 'By model', lines: [line('gpt-6.1-sol', 'gpt-6.1-sol', 810, 1000)] },
        { id: 'host', heading: 'By host', lines: [line('devbox', 'devbox', 810, 1000)] },
        { id: 'project', heading: 'By project', lines: [line('Walnut', 'Walnut', 810, 1000)] },
      ] }
  }
  if (engine) return { ...common(view, start, end), engine, engines: ENGINES, totals: line('total', 'Total', 0, 0), daily: [], tasks: [], groups: [] }
  const tasks = Array.from({ length: 25 }, (_, i) => ({ ...line(`task:t${i}`, i === 0 ? LONG_TITLE : `Coding task ${i + 1}`, 900 - i * 30, 2000 - i * 50),
    taskId: `t${i}`, sessionId: `s${i}`, project: i % 3 ? 'Walnut' : 'Notes', hosts: i % 2 ? ['devbox'] : ['__local__', 'devbox'],
    engines: i === 3 ? ['Codex'] : ['Claude Code'] }))
  const short = Array.from({ length: 12 }, (_, i) => ({ ...line(`session:x${i}`, `Probe ${i + 1}`, 0.2, 2), sessionId: `x${i}`, project: '',
    hosts: ['__local__'], engines: ['Claude Code'] }))
  const total = tasks.reduce((n, l) => n + l.costUsd, 0) + 2400 + 2.4
  return { ...common(view, start, end), engines: ENGINES, totals: line('total', 'Total', total, 61_000, 14), unpricedModels: ['internal-model'],
    unpriced: [{ model: 'internal-model', where: 'Claude Code', requests: 14 }],
    tasks, moreTasks: { count: 140, costUsd: 2400, requests: 21_000, tokens: 195_000_000 }, shortSessions: { count: 12, costUsd: 2.4, requests: 24, tokens: 223_000, lines: short },
    groups: [
      { id: 'engine', heading: 'By engine', lines: [line('claude', 'Claude Code', total - 120, 60_000), line('codex', 'Codex', 120, 1000)] },
      { id: 'model', heading: 'By model', lines: Array.from({ length: 11 }, (_, i) => line(`m${i}`, `claude-model-${i}`, 1000 - i * 80, 3000 - i * 100)) },
      { id: 'host', heading: 'By host', lines: [line('__local__', '__local__', total * 0.6, 36_000), line('devbox', 'devbox', total * 0.4, 25_000)] },
      { id: 'project', heading: 'By project', lines: [line('Walnut', 'Walnut', total * 0.7, 40_000), line('Notes', 'Notes', total * 0.3, 20_000), line('', 'Inbox', 2.4, 24)] },
    ] }
}

/**
 * Answers every /api/usage/costs read from the fixture; returns the URLs asked for.
 * `hold` may delay one answer (a slow reply that lands after the user moved on).
 */
export async function routeCosts(page: import('@playwright/test').Page, hold?: (url: URL) => Promise<void> | undefined): Promise<URL[]> {
  const asked: URL[] = []
  await page.route('**/api/usage/costs**', async (route) => {
    const url = new URL(route.request().url())
    asked.push(url)
    await hold?.(url)
    return route.fulfill({ json: costReport(url.searchParams.get('view') ?? 'walnut', url.searchParams.get('start'), url.searchParams.get('end'),
      url.searchParams.get('engine')) })
  })
  return asked
}
