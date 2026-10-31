/**
 * What the Usage & Costs page shows: dollars first. Two views of one period:
 *
 * - `walnut`: Walnut's own model calls (the Personal AI's chat from its
 *   transcripts, plus every helper call the live tracker records: titles,
 *   parsing, summaries, search, plugins...), by feature, model and day.
 * - `agents`: coding sessions (Claude Code from each host's transcripts, Codex
 *   and OpenCode from their own session records), by engine, model, host,
 *   project and task; optionally for one engine only.
 * - `all`: both added up, the page's default: by agent (each engine, and Walnut
 *   as one more), model, project (Walnut's own calls as "Walnut itself") and host.
 *
 * Every breakdown also carries its lines per day, so a chart can stack them.
 *
 * Every amount is tokens x public list prices, priced per request band with the
 * same price book and `priceBucket` as the model picker's cost line, so the two
 * never disagree. It is an estimate, not an invoice; a request whose model has
 * no price is counted and named, never priced as zero.
 */
import { currentPriceSnapshot, ensurePriceBook, priceBookInfo, priceThresholds, resolvePrice, type UserPriceRates } from './price-book.js';
import { DEFAULT_PRICING } from './pricing.js';
import { priceBucket } from './session-cost-pricing.js';
import type { SessionCostBucket } from '../../providers/session-cost-core.js';
import type { CostRollup } from './cost-rollup.js';
import type { Database as DatabaseType } from '../../lib/sqlite.js';

export type CostView = 'walnut' | 'agents' | 'all';

export interface CostTokens { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface CostLine { key: string; label: string; costUsd: number; requests: number; tokens: CostTokens; unpriced: number }
export interface CostTaskLine extends CostLine { taskId?: string; sessionId?: string; project: string; hosts: string[]; engines: string[] }

/** Requests no price could be put on, by model and where they came from (a feature or an engine). */
export interface CostUnpriced { model: string; where: string; requests: number }
export interface CostFold { count: number; costUsd: number; requests: number; tokens: number }

/** A breakdown: its lines by cost, and per day the cost of each line that had any (keyed by line key). */
export interface CostGroup { id: string; heading: string; lines: CostLine[]; daily: { date: string; costs: Record<string, number> }[] }

export interface CostReport {
  view: CostView;
  range: { start: string | null; end: string | null };
  /** Agents only: the one engine counted, null for all of them. */
  engine: string | null;
  /** Agents only: the engines with sessions in the period, whatever `engine` is. */
  engines: { key: string; label: string }[];
  totals: CostLine;
  daily: { date: string; costUsd: number; requests: number }[];
  groups: CostGroup[];
  /** Agents and all: tasks by cost, short sessions folded into `shortSessions`. */
  tasks?: CostTaskLine[];
  moreTasks?: CostFold;
  shortSessions?: CostFold & { lines: CostTaskLine[] };
  unpricedModels: string[];
  unpriced: CostUnpriced[];
  prices: { source: string; asOf?: string };
  /** False while the per-day sums are still being built from past usage. */
  ready: boolean;
}

export interface CostReportDeps {
  rollup: CostRollup;
  db: DatabaseType;
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
/** An engine name as a query may carry it (the rollup's own values are lowercase words). */
export const ENGINE_KEY = /^[a-z][a-z0-9-]{0,31}$/;
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

/** Version of a `claude-<family>-<n>[-<n>...]` name, or null for anything else (a dated id included). */
function familyVersion(name: string, family: string): number[] | null {
  const prefix = `claude-${family}-`;
  if (!name.startsWith(prefix)) return null;
  const parts = name.slice(prefix.length).split('-');
  if (!parts.every(p => /^\d{1,3}$/.test(p))) return null;
  return parts.map(Number);
}

function newer(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0;
  }
  return a.length > b.length;
}

/**
 * The model a bare Claude Code alias ("haiku", "sonnet", "opus") stands for: the
 * newest `claude-<alias>-*` the loaded price book knows (built-in table as the
 * fallback). Older tracker rows recorded the alias the call asked for, not the
 * model it ran. Undefined when the word is no family the price book has.
 */
export function aliasModel(raw: string): string | undefined {
  const word = raw.trim().toLowerCase().replace(/(?:\[[^\]]*\])+$/, '');
  if (!/^[a-z]+$/.test(word)) return undefined;
  const names = [...Object.keys(currentPriceSnapshot()?.models ?? {}), ...DEFAULT_PRICING.map(p => p.pattern)];
  let best: { name: string; version: number[] } | undefined;
  for (const name of names) {
    const version = familyVersion(name, word);
    if (version && (!best || newer(version, best.version))) best = { name, version };
  }
  return best?.name;
}

export class CostPricer {
  private cache = new Map<string, ReturnType<typeof resolvePrice> | null>();
  private aliases = new Map<string, string | undefined>();
  readonly unpricedModels = new Set<string>();
  constructor(private readonly thresholds: number[], private readonly overrides?: Record<string, UserPriceRates>) {}

  /** The model a row is priced as: itself, or the model a bare alias stands for. */
  resolve(rawModel: string): string {
    if (!this.aliases.has(rawModel)) {
      // A name the price book already has (a user rate keyed "sonnet") keeps its own price.
      this.aliases.set(rawModel, resolvePrice(rawModel, 'standard', this.overrides) ? undefined : aliasModel(rawModel));
    }
    return this.aliases.get(rawModel) ?? rawModel;
  }

  /** How a model reads on a row: an alias names the model it was priced as. */
  label(rawModel: string): string {
    const resolved = this.resolve(rawModel);
    return resolved === rawModel ? rawModel : `${rawModel} (${resolved})`;
  }

  /** `fallback`: the caller has a reported cost to use instead, so the model is not named as unpriced. */
  price(rawModel: string, band: number, s: Sums, fallback = false): Priced {
    // A request that used no tokens costs nothing whatever its model; there is nothing to price.
    if (!s.input && !s.output && !s.cacheRead && !s.cacheWrite5m && !s.cacheWrite1h) return { ...s, costUsd: 0, unpriced: 0 };
    // A 1M-context variant id prices as its base model (its long rate comes from the band).
    const model = this.resolve(rawModel).replace(/-1m$/i, '');
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
function trackerRows(db: DatabaseType, thresholds: number[], start: string | undefined, end: string | undefined, timeZone: string) {
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

export async function buildCostReport(view: CostView, range: { start?: string; end?: string; engine?: string }, deps: CostReportDeps): Promise<CostReport> {
  await ensurePriceBook();
  const thresholds = priceThresholds(deps.overrides);
  deps.rollup.setThresholds(thresholds);
  const ready = deps.rollup.isReady();
  if (!ready) void deps.rollup.backfill().catch(() => {});
  const pricer = new CostPricer(thresholds, deps.overrides);
  const totals = emptyLine('total', 'Total');
  const daily = new Map<string, { date: string; costUsd: number; requests: number }>();
  const groups = new Map<string, GroupAcc>();
  const group = (id: string, heading: string) => {
    const g = groups.get(id) ?? new GroupAcc(id, heading);
    groups.set(id, g); return g;
  };
  /** One priced row: into the total, its day, and each group it names. */
  const count = (date: string, p: Priced, into: [GroupAcc, string, string][]) => {
    addPriced(totals, p);
    const d = daily.get(date) ?? { date, costUsd: 0, requests: 0 };
    d.costUsd += p.costUsd; d.requests += p.requests; daily.set(date, d);
    for (const [g, key, label] of into) g.add(key, label, date, p);
  };
  const unpriced = new Map<string, CostUnpriced>();
  /** Names what could not be priced and where it came from, so the page can say why. */
  const noteUnpriced = (model: string, where: string, p: Priced) => {
    if (!p.unpriced) return;
    const key = `${model}\u0000${where}`;
    const u = unpriced.get(key) ?? { model, where, requests: 0 };
    u.requests += p.unpriced; unpriced.set(key, u);
  };
  const engine = view === 'agents' && range.engine && ENGINE_KEY.test(range.engine) ? range.engine : null;
  const report: CostReport = { view, range: { start: range.start ?? null, end: range.end ?? null }, engine, engines: [], totals, daily: [],
    groups: [], unpricedModels: [], unpriced: [], prices: priceBookInfo(), ready };
  const all = view === 'all';
  // The whole picture names each model once, as it is priced: an alias row joins its model.
  const modelLine = (raw: string): [string, string] => {
    if (!all) return [raw, pricer.label(raw)];
    const m = shortModel(pricer.resolve(raw));
    return [m, m];
  };

  if (view === 'walnut' || all) {
    const byFeature = group('feature', 'By feature'), byModel = group('model', 'By model');
    const byAgent = group('agent', 'By agent'), byProject = group('project', 'By project'), byHost = group('host', 'By host');
    const walnutInto = (model: string, feature: string, featureName: string, host: string): [GroupAcc, string, string][] => {
      const [mk, ml] = modelLine(model);
      return all
        ? [[byAgent, WALNUT_KEY, 'Walnut'], [byModel, mk, ml], [byProject, WALNUT_PROJECT_KEY, WALNUT_PROJECT], [byHost, host, host], [byFeature, feature, featureName]]
        : [[byFeature, feature, featureName], [byModel, mk, ml]];
    };
    for (const r of deps.rollup.query({ start: range.start, end: range.end, sources: ['chat'], by: ['date', 'host'] })) {
      const p = pricer.price(r.model, r.band, { ...r, requests: r.calls });
      noteUnpriced(r.model, featureLabel('chat'), p);
      count(r.date, p, walnutInto(r.model, 'chat', featureLabel('chat'), r.host as string));
    }
    for (const r of trackerRows(deps.db, thresholds, range.start, range.end, deps.timeZone)) {
      let p = pricer.price(r.model, r.band, r, r.recorded > 0);
      // No list price (an internal model), or only an alias whose model then may be older than
      // today's: the cost the call itself reported, when it reported one.
      const aliased = pricer.resolve(r.model) !== r.model;
      if ((p.unpriced || aliased) && r.recorded > 0) p = { ...p, costUsd: r.recorded, unpriced: 0 };
      else if (r.costOnly > 0) p = { ...p, costUsd: p.costUsd + r.costOnly, unpriced: 0 };
      noteUnpriced(r.model, featureLabel(r.source, r.agent), p);
      const feature = r.source === 'plugin' && r.agent?.startsWith('plugin:') ? `plugin:${r.agent}` : r.source;
      // Walnut's own helper calls run in this server, on the machine it serves from.
      count(r.date, p, walnutInto(r.model, feature, featureLabel(r.source, r.agent), LOCAL_HOST));
    }
  }
  if (view === 'agents' || all) {
    const rows0 = deps.rollup.query({ start: range.start, end: range.end, sources: ['session'], by: ['date', 'engine', 'host', 'session', 'task'] });
    // The engines offered are the period's, so picking one never hides the others from the choice.
    const seen = new Map<string, number>();
    for (const r of rows0) seen.set(r.engine, (seen.get(r.engine) ?? 0) + r.calls);
    report.engines = [...seen].sort((a, b) => b[1] - a[1]).map(([key]) => ({ key, label: engineLabel(key) }));
    const rows = engine ? rows0.filter(r => r.engine === engine) : rows0;
    const sessions = await deps.sessions();
    const perTask = new Map<string, { taskId?: string; sessionId: string; lineKey: string; hosts: Set<string>; engines: Set<string>;
      priced: CostLine; days: Map<string, Priced[]> }>();
    const byEngine = group(all ? 'agent' : 'engine', all ? 'By agent' : 'By engine'), byModel = group('model', 'By model');
    const byHost = group('host', 'By host');
    for (const r of rows) {
      const p = pricer.price(r.model, r.band, { ...r, requests: r.calls });
      noteUnpriced(r.model, engineLabel(r.engine), p);
      const [mk, ml] = modelLine(r.model);
      count(r.date, p, [[byEngine, r.engine, engineLabel(r.engine)], [byModel, mk, ml], [byHost, r.host, r.host]]);
      const session = sessions.get(r.sessionId as string);
      const taskId = (r.taskId as string | null) ?? session?.taskId ?? undefined;
      const lineKey = taskId ? `task:${taskId}` : `session:${r.sessionId}`;
      // The line opens the first session seen for it (a task may have several).
      const t = perTask.get(lineKey) ?? { taskId, sessionId: r.sessionId as string, lineKey,
        hosts: new Set<string>(), engines: new Set<string>(), priced: emptyLine(lineKey, ''), days: new Map<string, Priced[]>() };
      t.hosts.add(r.host); t.engines.add(r.engine); addPriced(t.priced, p);
      const day = t.days.get(r.date) ?? [];
      day.push(p); t.days.set(r.date, day);
      perTask.set(lineKey, t);
    }
    const tasks = await deps.tasks([...perTask.values()].flatMap(t => t.taskId ? [t.taskId] : []));
    const byProject = group('project', 'By project');
    const lines: CostTaskLine[] = [...perTask.values()].map(t => {
      const task = t.taskId ? tasks.get(t.taskId) : undefined;
      const session = !task && t.sessionId ? sessions.get(t.sessionId) : undefined;
      const project = task?.project ?? session?.project ?? '';
      const title = oneLine(task?.title || session?.title || (t.taskId ? 'Removed task' : 'Session without a task'));
      // A project is known only once its task is read, so its days come from the task's.
      for (const [date, priced] of t.days) for (const p of priced) byProject.add(project, project || 'Inbox', date, p);
      return { ...t.priced, key: t.lineKey, label: title, project, hosts: [...t.hosts], engines: [...t.engines].map(engineLabel),
        ...(t.taskId ? { taskId: t.taskId } : {}), ...(t.sessionId ? { sessionId: t.sessionId } : {}) };
    });
    const ordered = lines.sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests);
    const short = ordered.filter(l => l.requests <= SHORT_REQUESTS && l.costUsd < SHORT_USD);
    const kept = ordered.filter(l => !(l.requests <= SHORT_REQUESTS && l.costUsd < SHORT_USD));
    report.tasks = kept.slice(0, TOP_TASKS);
    const rest = kept.slice(TOP_TASKS);
    if (rest.length) report.moreTasks = fold(rest);
    if (short.length) report.shortSessions = { ...fold(short), lines: short.slice(0, 50) };
  }
  const order = all ? ['agent', 'model', 'project', 'host', 'feature']
    : view === 'walnut' ? ['feature', 'model']
    // One engine picked: its "By engine" would be one row saying the total again.
    : [...(engine ? [] : ['engine']), 'model', 'host', 'project'];
  report.groups = order.flatMap(id => groups.get(id) ? [groups.get(id)!.result()] : []);
  report.daily = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
  report.unpricedModels = [...pricer.unpricedModels].sort();
  report.unpriced = [...unpriced.values()].sort((a, b) => b.requests - a.requests);
  return report;
}

const WALNUT_KEY = 'walnut';
const WALNUT_PROJECT = 'Walnut itself';
/** Not a name a project can have, so a project called "walnut" never joins Walnut's own calls. */
const WALNUT_PROJECT_KEY = '__walnut__';
const LOCAL_HOST = '__local__';

/** A provider's routing prefix ("global.anthropic.") is not part of the model's name. */
export function shortModel(model: string): string {
  return model.replace(/^(?:[a-z]{2,6}\.)?(?:anthropic|openai|meta|amazon|mistral|deepseek|qwen|google)\./i, '');
}

/** One breakdown: its lines and, per day, each line's cost. */
class GroupAcc {
  private lines = new Map<string, CostLine>();
  private days = new Map<string, Map<string, number>>();
  constructor(readonly id: string, readonly heading: string) {}
  add(key: string, label: string, date: string, p: Priced): void {
    const line = this.lines.get(key) ?? emptyLine(key, label);
    addPriced(line, p); this.lines.set(key, line);
    const day = this.days.get(date) ?? new Map<string, number>();
    day.set(key, (day.get(key) ?? 0) + p.costUsd); this.days.set(date, day);
  }
  result(): CostGroup {
    const daily = [...this.days].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, costs]) => ({ date, costs: Object.fromEntries([...costs].filter(([, v]) => v > 0).map(([k, v]) => [k, round6(v)])) }));
    return { id: this.id, heading: this.heading, lines: sorted(this.lines.values()), daily };
  }
}

function round6(v: number): number { return Math.round(v * 1e6) / 1e6; }

function fold(rows: CostLine[]): CostFold {
  return { count: rows.length, costUsd: rows.reduce((n, r) => n + r.costUsd, 0), requests: rows.reduce((n, r) => n + r.requests, 0),
    tokens: rows.reduce((n, r) => n + r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheWrite, 0) };
}

/** A title on one line, short enough for a row (a first prompt can be pages long). */
export function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
}
