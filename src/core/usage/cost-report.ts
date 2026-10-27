/**
 * What the Usage & Costs page shows: dollars first. Two views of one period:
 *
 * - `walnut`: Walnut's own model calls (the Personal AI's chat from its
 *   transcripts, plus every helper call the live tracker records: titles,
 *   parsing, summaries, search, plugins...), by feature, model and day.
 * - `agents`: coding sessions (Claude Code from each host's transcripts, Codex
 *   and OpenCode from their own session records), by engine, model, host,
 *   project and task.
 *
 * Every amount is tokens x public list prices, priced per request band with the
 * same price book and `priceBucket` as the model picker's cost line, so the two
 * never disagree. It is an estimate, not an invoice; a request whose model has
 * no price is counted and named, never priced as zero.
 */
import { ensurePriceBook, priceBookInfo, priceThresholds, resolvePrice, type UserPriceRates } from './price-book.js';
import { priceBucket } from './session-cost-pricing.js';
import type { SessionCostBucket } from '../../providers/session-cost-core.js';
import type { CostRollup } from './cost-rollup.js';
import type Database from 'better-sqlite3';

export type CostView = 'walnut' | 'agents';

export interface CostTokens { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface CostLine { key: string; label: string; costUsd: number; requests: number; tokens: CostTokens; unpriced: number }
export interface CostTaskLine extends CostLine { taskId?: string; sessionId?: string; project: string; hosts: string[]; engines: string[] }

export interface CostReport {
  view: CostView;
  range: { start: string | null; end: string | null };
  totals: CostLine;
  daily: { date: string; costUsd: number; requests: number }[];
  groups: { id: string; heading: string; lines: CostLine[] }[];
  /** Agents only: tasks by cost, short sessions folded into `shortSessions`. */
  tasks?: CostTaskLine[];
  moreTasks?: { count: number; costUsd: number; requests: number };
  shortSessions?: { count: number; costUsd: number; requests: number; lines: CostTaskLine[] };
  unpricedModels: string[];
  prices: { source: string; asOf?: string };
  /** False while the per-day sums are still being built from past usage. */
  ready: boolean;
}

export interface CostReportDeps {
  rollup: CostRollup;
  db: Database.Database;
  timeZone: string;
  overrides?: Record<string, UserPriceRates>;
  /** taskId -> title/project as they are now. */
  tasks: (ids: string[]) => Promise<Map<string, { title: string; project: string }>>;
  /** Coding session id -> its record, for engine and title when a session has no task. */
  sessions: () => Promise<Map<string, { title?: string; taskId?: string; project?: string; engine?: string }>>;
}

const FEATURE: Record<string, string> = {
  chat: 'Personal AI chat', agent: 'Personal AI (older)', 'agent-cli': 'Personal AI (command line)', subagent: 'Subagents',
  compaction: 'Chat compaction', triage: 'Triage', cron: 'Routines', jev: 'Decision checks', 'task-hook': 'Task overview upkeep',
  'task-search-agent': 'AI task search', plugin: 'Plugins and apps', 'background-review': 'Self-review', heartbeat: 'Heartbeat',
  'image-tool': 'Image reading', perplexity: 'Web search', glm: 'GLM calls', title: 'Titles', 'quick-parse': 'Quick add',
  summary: 'Summaries', organize: 'Organizing sessions', 'commit-message': 'Commit messages', memory: 'Memory upkeep',
  transfer: 'Session transfer', 'routine-draft': 'Routine drafts', 'host-learning': 'Host learning',
};
const ENGINE: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', goose: 'Goose' };
/** A task this small in the period is a test or a one-off: it is folded into one line. */
const SHORT_REQUESTS = 5, SHORT_USD = 1;
const TOP_TASKS = 25;

export function featureLabel(source: string, agent?: string | null): string {
  if (source === 'plugin' && agent?.startsWith('plugin:')) return `Plugin: ${agent.slice(7)}`;
  return FEATURE[source] ?? source;
}

export function engineLabel(engine: string): string { return ENGINE[engine] ?? engine; }

interface Sums { requests: number; input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }
interface Priced extends Sums { costUsd: number; unpriced: number }

function emptyLine(key: string, label: string): CostLine {
  return { key, label, costUsd: 0, requests: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, unpriced: 0 };
}

function addPriced(line: CostLine, p: Priced): void {
  line.costUsd += p.costUsd; line.requests += p.requests; line.unpriced += p.unpriced;
  line.tokens.input += p.input; line.tokens.output += p.output; line.tokens.cacheRead += p.cacheRead;
  line.tokens.cacheWrite += p.cacheWrite5m + p.cacheWrite1h;
}

function sorted(lines: Iterable<CostLine>): CostLine[] {
  return [...lines].sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests);
}

export class CostPricer {
  private cache = new Map<string, ReturnType<typeof resolvePrice> | null>();
  readonly unpricedModels = new Set<string>();
  constructor(private readonly thresholds: number[], private readonly overrides?: Record<string, UserPriceRates>) {}

  /** `fallback`: the caller has a reported cost to use instead, so the model is not named as unpriced. */
  price(rawModel: string, band: number, s: Sums, fallback = false): Priced {
    // A 1M-context variant id prices as its base model (its long rate comes from the band).
    const model = rawModel.replace(/-1m$/i, '');
    const speed = /-fast$/.test(model) ? 'fast' : 'standard';
    const key = `${model}\u0000${speed}`;
    if (!this.cache.has(key)) this.cache.set(key, resolvePrice(model, speed, this.overrides) ?? null);
    const resolved = this.cache.get(key);
    const bucket: SessionCostBucket = { model, speed, geo: '', tier: 'standard', band, responses: s.requests,
      input: s.input, output: s.output, cacheRead: s.cacheRead, cacheWrite5m: s.cacheWrite5m, cacheWrite1h: s.cacheWrite1h,
      cacheWrite: 0, webSearches: 0, incomplete: 0, firstAt: '', lastAt: '' };
    const priced = resolved ? priceBucket(bucket, resolved.entry, this.thresholds) : 'no price for this model';
    if (typeof priced === 'string') {
      if (!fallback) this.unpricedModels.add(rawModel);
      return { ...s, costUsd: 0, unpriced: s.requests };
    }
    return { ...s, costUsd: priced.costUsd, unpriced: 0 };
  }
}

/** The UTC instant a local calendar day starts, for timestamp-keyed tables. */
export function localDayStartIso(day: string, timeZone: string): string {
  const [y, m, d] = day.split('-').map(Number);
  let guess = Date.UTC(y, m - 1, d);
  // Two passes settle the zone offset, also across a DST change.
  for (let i = 0; i < 2; i++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess)).map(p => [p.type, p.value]));
    const shown = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    guess -= shown - Date.UTC(y, m - 1, d);
  }
  return new Date(guess).toISOString();
}

function nextDay(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`) + 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function bandSql(thresholds: number[]): string {
  const prompt = '(COALESCE(input_tokens,0)+COALESCE(cache_read_input_tokens,0)+COALESCE(cache_creation_input_tokens,0))';
  return thresholds.length ? thresholds.map(t => `(${prompt} > ${Math.floor(t)})`).join(' + ') : '0';
}

/** The live tracker's rows for Walnut's own calls (not coding sessions, not chat: chat comes from transcripts). */
function trackerRows(db: Database.Database, thresholds: number[], start: string | undefined, end: string | undefined, timeZone: string) {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='usage'").get()) return [];
  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage(timestamp)');
  const clauses = ["source NOT IN ('session','chat')"]; const args: string[] = [];
  if (start) { clauses.push('timestamp >= ?'); args.push(localDayStartIso(start, timeZone)); }
  if (end) { clauses.push('timestamp < ?'); args.push(localDayStartIso(nextDay(end), timeZone)); }
  // Grouped by UTC quarter hour, then dated in the local zone (exact for every zone offset in use).
  const quarter = "substr(timestamp,1,14) || printf('%02d', CAST(substr(timestamp,15,2) AS INTEGER) / 15 * 15)";
  const rows = db.prepare(`SELECT ${quarter} hour, source, agent_id agent, model, ${bandSql(thresholds)} band,
    COUNT(*) requests, SUM(input_tokens) input, SUM(output_tokens) output, SUM(cache_read_input_tokens) cacheRead,
    SUM(cache_creation_input_tokens) cacheWrite5m,
    SUM(CASE WHEN COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(cache_read_input_tokens,0)+COALESCE(cache_creation_input_tokens,0) = 0
      THEN COALESCE(external_cost_usd, cost_usd, 0) ELSE 0 END) costOnly,
    SUM(COALESCE(external_cost_usd, cost_usd, 0)) recorded
    FROM usage WHERE ${clauses.join(' AND ')} GROUP BY 1, source, agent_id, model, band`).all(...args) as
    { hour: string; source: string; agent: string | null; model: string; band: number; requests: number; input: number; output: number;
      cacheRead: number; cacheWrite5m: number; costOnly: number; recorded: number }[];
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return rows.map(r => ({ ...r, date: fmt.format(new Date(`${r.hour}:00Z`)), cacheWrite1h: 0 }));
}

export async function buildCostReport(view: CostView, range: { start?: string; end?: string }, deps: CostReportDeps): Promise<CostReport> {
  await ensurePriceBook();
  const thresholds = priceThresholds(deps.overrides);
  deps.rollup.setThresholds(thresholds);
  const ready = deps.rollup.isReady();
  if (!ready) void deps.rollup.backfill().catch(() => {});
  const pricer = new CostPricer(thresholds, deps.overrides);
  const totals = emptyLine('total', 'Total');
  const daily = new Map<string, { date: string; costUsd: number; requests: number }>();
  const addDay = (date: string, p: Priced) => {
    const d = daily.get(date) ?? { date, costUsd: 0, requests: 0 };
    d.costUsd += p.costUsd; d.requests += p.requests; daily.set(date, d);
  };
  const bump = (map: Map<string, CostLine>, key: string, label: string, p: Priced) => {
    const line = map.get(key) ?? emptyLine(key, label);
    addPriced(line, p); map.set(key, line);
  };
  const report: CostReport = { view, range: { start: range.start ?? null, end: range.end ?? null }, totals, daily: [], groups: [],
    unpricedModels: [], prices: priceBookInfo(), ready };

  if (view === 'walnut') {
    const byFeature = new Map<string, CostLine>(), byModel = new Map<string, CostLine>();
    for (const r of deps.rollup.query({ start: range.start, end: range.end, sources: ['chat'], by: ['date'] })) {
      const p = pricer.price(r.model, r.band, { ...r, requests: r.calls });
      addPriced(totals, p); addDay(r.date, p);
      bump(byFeature, 'chat', featureLabel('chat'), p); bump(byModel, r.model, r.model, p);
    }
    for (const r of trackerRows(deps.db, thresholds, range.start, range.end, deps.timeZone)) {
      let p = pricer.price(r.model, r.band, r, r.recorded > 0);
      // No list price (a CLI alias like "sonnet", an internal model): the cost the call itself reported.
      if (p.unpriced && r.recorded > 0) p = { ...p, costUsd: r.recorded, unpriced: 0 };
      else if (r.costOnly > 0) p = { ...p, costUsd: p.costUsd + r.costOnly, unpriced: 0 };
      addPriced(totals, p); addDay(r.date, p);
      const feature = r.source === 'plugin' && r.agent?.startsWith('plugin:') ? `plugin:${r.agent}` : r.source;
      bump(byFeature, feature, featureLabel(r.source, r.agent), p); bump(byModel, r.model, r.model, p);
    }
    report.groups = [
      { id: 'feature', heading: 'By feature', lines: sorted(byFeature.values()) },
      { id: 'model', heading: 'By model', lines: sorted(byModel.values()) },
    ];
  } else {
    const rows = deps.rollup.query({ start: range.start, end: range.end, sources: ['session'], by: ['date', 'engine', 'host', 'session', 'task'] });
    const sessions = await deps.sessions();
    const perTask = new Map<string, { taskId?: string; sessionId: string; lineKey: string; hosts: Set<string>; engines: Set<string>; priced: CostLine }>();
    const byEngine = new Map<string, CostLine>(), byModel = new Map<string, CostLine>(), byHost = new Map<string, CostLine>();
    for (const r of rows) {
      const p = pricer.price(r.model, r.band, { ...r, requests: r.calls });
      addPriced(totals, p); addDay(r.date, p);
      const session = sessions.get(r.sessionId as string);
      const engine = r.engine === 'claude' ? 'claude' : r.engine;
      bump(byEngine, engine, engineLabel(engine), p);
      bump(byModel, r.model, r.model, p);
      bump(byHost, r.host, r.host, p);
      const taskId = (r.taskId as string | null) ?? session?.taskId ?? undefined;
      const lineKey = taskId ? `task:${taskId}` : `session:${r.sessionId}`;
      // The line opens the first session seen for it (a task may have several).
      const t = perTask.get(lineKey) ?? { taskId, sessionId: r.sessionId as string, lineKey,
        hosts: new Set<string>(), engines: new Set<string>(), priced: emptyLine(lineKey, '') };
      t.hosts.add(r.host); t.engines.add(engine); addPriced(t.priced, p);
      perTask.set(lineKey, t);
    }
    const tasks = await deps.tasks([...perTask.values()].flatMap(t => t.taskId ? [t.taskId] : []));
    const byProject = new Map<string, CostLine>();
    const lines: CostTaskLine[] = [...perTask.values()].map(t => {
      const task = t.taskId ? tasks.get(t.taskId) : undefined;
      const session = !task && t.sessionId ? sessions.get(t.sessionId) : undefined;
      const project = task?.project ?? session?.project ?? '';
      const title = oneLine(task?.title || session?.title || (t.taskId ? 'Removed task' : 'Session without a task'));
      return { ...t.priced, key: t.lineKey, label: title, project, hosts: [...t.hosts], engines: [...t.engines].map(engineLabel),
        ...(t.taskId ? { taskId: t.taskId } : {}), ...(t.sessionId ? { sessionId: t.sessionId } : {}) };
    });
    for (const line of lines) {
      const project = byProject.get(line.project) ?? emptyLine(line.project, line.project || 'Inbox');
      project.costUsd += line.costUsd; project.requests += line.requests; project.unpriced += line.unpriced;
      for (const k of Object.keys(project.tokens) as (keyof CostTokens)[]) project.tokens[k] += line.tokens[k];
      byProject.set(line.project, project);
    }
    const ordered = lines.sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests);
    const short = ordered.filter(l => l.requests <= SHORT_REQUESTS && l.costUsd < SHORT_USD);
    const kept = ordered.filter(l => !(l.requests <= SHORT_REQUESTS && l.costUsd < SHORT_USD));
    report.tasks = kept.slice(0, TOP_TASKS);
    const rest = kept.slice(TOP_TASKS);
    if (rest.length) report.moreTasks = { count: rest.length, costUsd: sum(rest, 'costUsd'), requests: sum(rest, 'requests') };
    if (short.length) report.shortSessions = { count: short.length, costUsd: sum(short, 'costUsd'), requests: sum(short, 'requests'), lines: short.slice(0, 50) };
    report.groups = [
      { id: 'engine', heading: 'By engine', lines: sorted(byEngine.values()) },
      { id: 'model', heading: 'By model', lines: sorted(byModel.values()) },
      { id: 'host', heading: 'By host', lines: sorted(byHost.values()) },
      { id: 'project', heading: 'By project', lines: sorted(byProject.values()) },
    ];
  }
  report.daily = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
  report.unpricedModels = [...pricer.unpricedModels].sort();
  return report;
}

function sum<T extends { costUsd: number; requests: number }>(rows: T[], field: 'costUsd' | 'requests'): number {
  return rows.reduce((n, r) => n + r[field], 0);
}

/** A title on one line, short enough for a row (a first prompt can be pages long). */
export function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
}
