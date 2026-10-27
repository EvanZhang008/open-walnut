/**
 * A realistic GET /api/usage/costs answer for browser specs: a busy week with
 * long task titles, many models and hosts, folded short sessions and an
 * unpriced model, for both views.
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

const common = (view: string, start: string | null, end: string | null) => ({
  view, range: { start, end }, daily: days(start, end), unpricedModels: [] as string[],
  prices: { source: 'litellm', asOf: '2026-10-20T00:00:00.000Z' }, ready: true, timeZone: 'America/Los_Angeles',
  bounds: { min: '2026-09-01', max: '2026-09-23' },
  countedUntil: [{ host: '__local__', until: '2026-09-23T18:00:00.000Z' }, { host: 'devbox', until: '2026-09-23T17:30:00.000Z' }],
  checks: [{ source: 'Canonical transcript', host: '__local__', status: 'matched', matchedCalls: 100, unmatchedCalls: 0, detail: 'Every response counted once.' }],
  collection: { running: false },
})

export const LONG_TITLE = 'Investigate why the nightly export of every archived project to the shared drive keeps timing out after the third retry on the slow host'

export function costReport(view: string, start: string | null, end: string | null) {
  if (view === 'walnut') {
    const features = [line('chat', 'Personal AI chat', 61.2, 412), line('title', 'Titles', 3.41, 2210), line('task-search-agent', 'AI task search', 2.05, 380),
      line('summary', 'Summaries', 1.12, 140), line('plugin:plugin:mail', 'Plugin: mail', 0.4, 60), line('quick-parse', 'Quick add', 0.08, 41),
      line('memory', 'Memory upkeep', 0.05, 12), line('commit-message', 'Commit messages', 0.03, 9), line('transfer', 'Session transfer', 0.02, 4),
      line('jev', 'Decision checks', 0.004, 2)]
    const total = features.reduce((n, l) => n + l.costUsd, 0), requests = features.reduce((n, l) => n + l.requests, 0)
    return { ...common(view, start, end), totals: line('total', 'Total', total, requests),
      groups: [{ id: 'feature', heading: 'By feature', lines: features },
        { id: 'model', heading: 'By model', lines: [line('claude-opus-5-5', 'claude-opus-5-5', 61.2, 412), line('claude-haiku-5-5', 'claude-haiku-5-5', total - 61.2, requests - 412)] }] }
  }
  const tasks = Array.from({ length: 25 }, (_, i) => ({ ...line(`task:t${i}`, i === 0 ? LONG_TITLE : `Coding task ${i + 1}`, 900 - i * 30, 2000 - i * 50),
    taskId: `t${i}`, sessionId: `s${i}`, project: i % 3 ? 'Walnut' : 'Notes', hosts: i % 2 ? ['devbox'] : ['__local__', 'devbox'],
    engines: i === 3 ? ['Codex'] : ['Claude Code'] }))
  const short = Array.from({ length: 12 }, (_, i) => ({ ...line(`session:x${i}`, `Probe ${i + 1}`, 0.2, 2), sessionId: `x${i}`, project: '',
    hosts: ['__local__'], engines: ['Claude Code'] }))
  const total = tasks.reduce((n, l) => n + l.costUsd, 0) + 2400 + 2.4
  return { ...common(view, start, end), totals: line('total', 'Total', total, 61_000, 14), unpricedModels: ['internal-model'],
    tasks, moreTasks: { count: 140, costUsd: 2400, requests: 21_000 }, shortSessions: { count: 12, costUsd: 2.4, requests: 24, lines: short },
    groups: [
      { id: 'engine', heading: 'By engine', lines: [line('claude', 'Claude Code', total - 120, 60_000), line('codex', 'Codex', 120, 1000)] },
      { id: 'model', heading: 'By model', lines: Array.from({ length: 11 }, (_, i) => line(`m${i}`, `claude-model-${i}`, 1000 - i * 80, 3000 - i * 100)) },
      { id: 'host', heading: 'By host', lines: [line('__local__', '__local__', total * 0.6, 36_000), line('devbox', 'devbox', total * 0.4, 25_000)] },
      { id: 'project', heading: 'By project', lines: [line('Walnut', 'Walnut', total * 0.7, 40_000), line('Notes', 'Notes', total * 0.3, 20_000), line('', 'Inbox', 2.4, 24)] },
    ] }
}

/** Answers every /api/usage/costs read from the fixture; returns the URLs asked for. */
export async function routeCosts(page: import('@playwright/test').Page): Promise<URL[]> {
  const asked: URL[] = []
  await page.route('**/api/usage/costs**', (route) => {
    const url = new URL(route.request().url())
    asked.push(url)
    return route.fulfill({ json: costReport(url.searchParams.get('view') ?? 'walnut', url.searchParams.get('start'), url.searchParams.get('end')) })
  })
  return asked
}
