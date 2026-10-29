/**
 * The live "current action" of a running task (2026-10-28, from the multi-agent tracking
 * research, point 4): what its session is doing NOW, read by the program from the session's
 * stream, never written by the model. The Board's Status view, the Org page's team rows and
 * the phone show it under a Working task, so "is it still moving, and on what" is answered
 * without waiting for the turn-end report (which is up to 4 minutes old by design, and a
 * 40-minute turn kept its 40-minute-old words all along).
 *
 *   Bash: bun run test:quick · 3 min · turn 41 min · $2.10
 *   No tool call for 12 min · turn 55 min · $3.40
 *
 * The facts only carry timestamps; every duration is computed by the reader against its own
 * clock, so no event is ever sent just because time passed (sessions/live-activity-registry.ts
 * sends one only when the action itself changed, at most every few seconds per session).
 *
 * Pure and browser-safe: the server (the tracker, the v1 projection) and the web app import it.
 */

export type LiveActivityKind = 'tool' | 'thinking' | 'writing';

/** What a running session is doing, as the server last saw it. Every field is optional on
 *  the wire except `kind` and `since`: an older or newer peer may omit any. */
export interface LiveActivity {
  kind: LiveActivityKind;
  /** kind 'tool': the tool's name (Bash, Edit, an MCP tool...). */
  tool?: string;
  /** kind 'tool': the short target (a command's first line, a file's last path segments). */
  target?: string;
  /** When this action began (ISO). */
  since: string;
  /** When the turn began (ISO). */
  turnStartedAt?: string;
  /** When the session last started a tool call, any lane (ISO). */
  lastToolAt?: string;
  /** The turn's cost so far, in USD (an estimate until the turn's result). */
  costUsd?: number;
  /** The session it was read from. */
  sessionId?: string;
}

/** No tool call for this long (and none running) reads as gone quiet. */
export const LIVE_QUIET_MS = 5 * 60_000;
const TARGET_MAX = 80;

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function cut(s: string, max = TARGET_MAX): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join('')}…`;
}

/** The last two segments of a path: enough to name the file, short enough for a row. */
function shortPath(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length <= 2 ? p : parts.slice(-2).join('/');
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/** The short target of a tool call, from its input; '' when it has none worth showing. */
export function toolTarget(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  let raw: string | undefined;
  switch (name) {
    case 'Bash': {
      const cmd = str(i.command);
      raw = cmd ? cmd.split('\n').find((l) => l.trim()) : str(i.description);
      break;
    }
    case 'Read': case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': {
      const p = str(i.file_path) ?? str(i.notebook_path) ?? str(i.path);
      raw = p ? shortPath(p) : undefined;
      break;
    }
    case 'Grep': case 'Glob': raw = str(i.pattern); break;
    case 'Agent': case 'Task': raw = str(i.description) ?? str(i.subagent_type); break;
    case 'WebFetch': raw = str(i.url)?.replace(/^https?:\/\//, ''); break;
    case 'WebSearch': case 'ToolSearch': raw = str(i.query); break;
    case 'Skill': raw = str(i.skill) ?? str(i.command); break;
    case 'TodoWrite': case 'ExitPlanMode': raw = undefined; break;
    default: raw = str(i.description) ?? str(i.command) ?? str(i.query) ?? str(i.path) ?? str(i.url) ?? str(i.name);
  }
  return raw ? cut(oneLine(raw)) : '';
}

/** The tool's name as a person reads it: an MCP tool loses its `mcp__server__` prefix. */
export function toolLabel(name: string): string {
  const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  return m ? `${m[1]}: ${m[2]}` : name;
}

/** "40 s", "12 min", "1 h 5 min". */
export function formatSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

export function formatCost(usd: number | undefined): string | undefined {
  if (usd === undefined || !Number.isFinite(usd) || usd <= 0) return undefined;
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

export interface LiveActivityLine {
  /** "Bash: bun run test:quick · 3 min", "Thinking · 40 s", or "No tool call for 12 min". */
  action: string;
  /** The session has gone quiet: no tool running and none started for LIVE_QUIET_MS. */
  quiet: boolean;
  /** "turn 41 min", when the turn's start is known. */
  turn?: string;
  /** "$2.10", when the turn has cost something yet. */
  cost?: string;
  /** Every part in one line. */
  text: string;
}

const ms = (iso: string | undefined): number => (iso ? Date.parse(iso) : NaN);

/** The line a surface shows for a live activity, against the reader's clock. */
export function formatLiveActivity(a: LiveActivity, nowMs: number): LiveActivityLine {
  const sinceMs = ms(a.since);
  const turnMs = ms(a.turnStartedAt);
  const lastTool = ms(a.lastToolAt);
  // Quiet is measured from the last tool call, else from the turn's start, else from the action's.
  const quietFrom = Number.isFinite(lastTool) ? lastTool : Number.isFinite(turnMs) ? turnMs : sinceMs;
  const quiet = a.kind !== 'tool' && Number.isFinite(quietFrom) && nowMs - quietFrom >= LIVE_QUIET_MS;
  const span = Number.isFinite(sinceMs) ? formatSpan(nowMs - sinceMs) : '';
  let action: string;
  if (quiet) {
    action = `No tool call for ${formatSpan(nowMs - quietFrom)}`;
  } else if (a.kind === 'tool') {
    const label = toolLabel(a.tool || 'a tool');
    action = `${a.target ? `${label}: ${a.target}` : label}${span ? ` · ${span}` : ''}`;
  } else {
    action = `${a.kind === 'writing' ? 'Writing' : 'Thinking'}${span ? ` · ${span}` : ''}`;
  }
  const turn = Number.isFinite(turnMs) ? `turn ${formatSpan(nowMs - turnMs)}` : undefined;
  const cost = formatCost(a.costUsd);
  return { action, quiet, ...(turn ? { turn } : {}), ...(cost ? { cost } : {}), text: [action, turn, cost].filter(Boolean).join(' · ') };
}

/** Reads one activity off the wire (an event, a REST body): undefined for anything malformed. */
export function parseLiveActivity(v: unknown): LiveActivity | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (o.kind !== 'tool' && o.kind !== 'thinking' && o.kind !== 'writing') return undefined;
  if (typeof o.since !== 'string') return undefined;
  const s = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
  const cost = typeof o.costUsd === 'number' && Number.isFinite(o.costUsd) ? o.costUsd : undefined;
  return {
    kind: o.kind, since: o.since,
    ...(s('tool') ? { tool: s('tool') } : {}),
    ...(s('target') ? { target: s('target') } : {}),
    ...(s('turnStartedAt') ? { turnStartedAt: s('turnStartedAt') } : {}),
    ...(s('lastToolAt') ? { lastToolAt: s('lastToolAt') } : {}),
    ...(cost !== undefined ? { costUsd: cost } : {}),
    ...(s('sessionId') ? { sessionId: s('sessionId') } : {}),
  };
}

/**
 * Follows one session's stream: the session runner calls it on the events it already parses
 * (a turn's start, a tool call and its result, the first token of text or thinking). Each
 * call says whether the action changed, so the caller sends only real changes, never per token.
 */
export class LiveActivityTracker {
  private kind: LiveActivityKind | null = null;
  private tool: string | undefined;
  private target: string | undefined;
  private since = 0;
  private lastToolAt: number | undefined;
  /** Main-lane tool calls still waiting for their result, oldest first. */
  private open: { id: string; tool: string; target: string; at: number }[] = [];

  /** A new turn: the model is thinking until it says or does something. */
  turnStart(now: number): boolean {
    this.open = [];
    this.lastToolAt = undefined;
    return this.set('thinking', now);
  }

  /** A tool call. A subagent's (`sub`) only proves the session is moving; the row keeps the
   *  main lane's call (the Agent tool that runs it). */
  toolUse(id: string | undefined, name: string, input: unknown, now: number, sub = false): boolean {
    this.lastToolAt = now;
    if (sub) return false;
    const call = { id: id ?? '', tool: name, target: toolTarget(name, input), at: now };
    this.open.push(call);
    this.kind = 'tool';
    this.tool = call.tool;
    this.target = call.target || undefined;
    this.since = now;
    return true;
  }

  /** A tool's result: when none is left running, the model has the word again. */
  toolResult(id: string | undefined, now: number): boolean {
    if (this.kind !== 'tool') return false;
    const at = id ? this.open.findIndex((c) => c.id === id) : -1;
    if (at === -1) return false;
    this.open.splice(at, 1);
    const still = this.open[this.open.length - 1];
    if (still) {
      if (still.tool === this.tool && (still.target || undefined) === this.target) return false;
      this.tool = still.tool;
      this.target = still.target || undefined;
      this.since = still.at;
      return true;
    }
    return this.set('thinking', now);
  }

  /** Main-lane text is streaming. */
  writing(now: number): boolean {
    if (this.kind === 'writing') return false;
    this.open = [];
    return this.set('writing', now);
  }

  /** Main-lane thinking is streaming. */
  thinking(now: number): boolean {
    if (this.kind === 'thinking') return false;
    this.open = [];
    return this.set('thinking', now);
  }

  /** The turn ended (or the process went away). */
  end(): boolean {
    const was = this.kind !== null;
    this.kind = null;
    this.open = [];
    this.tool = this.target = undefined;
    return was;
  }

  get active(): boolean {
    return this.kind !== null;
  }

  snapshot(extra: { turnStartedAt?: number; costUsd?: number; sessionId?: string } = {}): LiveActivity | null {
    if (!this.kind) return null;
    const iso = (n: number | undefined) => (n !== undefined && Number.isFinite(n) ? new Date(n).toISOString() : undefined);
    const turn = iso(extra.turnStartedAt);
    const last = iso(this.lastToolAt);
    return {
      kind: this.kind,
      since: new Date(this.since).toISOString(),
      ...(this.kind === 'tool' && this.tool ? { tool: this.tool } : {}),
      ...(this.kind === 'tool' && this.target ? { target: this.target } : {}),
      ...(turn ? { turnStartedAt: turn } : {}),
      ...(last ? { lastToolAt: last } : {}),
      ...(extra.costUsd !== undefined && extra.costUsd > 0 ? { costUsd: Math.round(extra.costUsd * 10_000) / 10_000 } : {}),
      ...(extra.sessionId ? { sessionId: extra.sessionId } : {}),
    };
  }

  private set(kind: LiveActivityKind, now: number): true {
    this.kind = kind;
    this.tool = this.target = undefined;
    this.since = now;
    return true;
  }
}
