/**
 * The accumulators behind the Usage & Costs report (cost-report.ts): a breakdown's
 * lines with their cost per day, the split by token type (its tokens and its cost
 * are different shares: a cache read is most of the tokens and a smaller part of
 * the cost), and the kind of work a row was.
 */
import type { CostGroup, CostLine } from './cost-report.js';

export interface Sums { requests: number; input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }

/** The token kinds a price splits into, in the order the page lists them. */
export const TOKEN_KINDS = [
  ['input', 'Input'], ['output', 'Output'], ['cacheRead', 'Cache read'],
  ['cacheWrite5m', 'Cache write, 5 minutes'], ['cacheWrite1h', 'Cache write, 1 hour'],
] as const;
export type TokenKind = typeof TOKEN_KINDS[number][0];
/** A cost the call reported itself, with no tokens to split it by. */
export const REPORTED_KIND = 'reported';
export type CostPart = TokenKind | typeof REPORTED_KIND;

export interface Priced extends Sums {
  costUsd: number; unpriced: number;
  /** What each token kind cost; absent when the row was not priced. */
  parts?: Partial<Record<CostPart, number>>;
}

export function emptyLine(key: string, label: string): CostLine {
  return { key, label, costUsd: 0, requests: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, unpriced: 0 };
}

export function addPriced(line: CostLine, p: Priced): void {
  line.costUsd += p.costUsd; line.requests += p.requests; line.unpriced += p.unpriced;
  line.tokens.input += p.input; line.tokens.output += p.output; line.tokens.cacheRead += p.cacheRead;
  line.tokens.cacheWrite += p.cacheWrite5m + p.cacheWrite1h;
}

export function sorted(lines: Iterable<CostLine>): CostLine[] {
  return [...lines].sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests);
}

function round6(v: number): number { return Math.round(v * 1e6) / 1e6; }

function dailyOf(days: Map<string, Map<string, number>>): CostGroup['daily'] {
  return [...days].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, costs]) => ({ date, costs: Object.fromEntries([...costs].filter(([, v]) => v > 0).map(([k, v]) => [k, round6(v)])) }));
}

function addDay(days: Map<string, Map<string, number>>, date: string, key: string, cost: number): void {
  const day = days.get(date) ?? new Map<string, number>();
  day.set(key, (day.get(key) ?? 0) + cost); days.set(date, day);
}

/** One breakdown: its lines and, per day, each line's cost. */
export class GroupAcc {
  private lines = new Map<string, CostLine>();
  private days = new Map<string, Map<string, number>>();
  constructor(readonly id: string, readonly heading: string) {}
  add(key: string, label: string, date: string, p: Priced): void {
    const line = this.lines.get(key) ?? emptyLine(key, label);
    addPriced(line, p); this.lines.set(key, line);
    addDay(this.days, date, key, p.costUsd);
  }
  result(): CostGroup {
    return { id: this.id, heading: this.heading, lines: sorted(this.lines.values()), daily: dailyOf(this.days) };
  }
}

/**
 * The split by token type: each line carries only its own kind's tokens (so a
 * line's share of tokens reads from them) and that kind's cost. Requests do not
 * split by kind, so the lines carry none.
 */
export class TokenAcc {
  private lines = new Map<CostPart, CostLine>();
  private days = new Map<string, Map<string, number>>();
  add(date: string, p: Priced): void {
    for (const [kind, label] of TOKEN_KINDS) {
      const tokens = p[kind], cost = p.parts?.[kind] ?? 0;
      if (!tokens && !cost) continue;
      const line = this.line(kind, label);
      line.costUsd += cost;
      if (kind === 'cacheWrite5m' || kind === 'cacheWrite1h') line.tokens.cacheWrite += tokens; else line.tokens[kind] += tokens;
      addDay(this.days, date, kind, cost);
    }
    const reported = p.parts?.[REPORTED_KIND] ?? 0;
    if (reported > 0) {
      this.line(REPORTED_KIND, 'Reported cost, not split').costUsd += reported;
      addDay(this.days, date, REPORTED_KIND, reported);
    }
  }
  private line(kind: CostPart, label: string): CostLine {
    const line = this.lines.get(kind) ?? emptyLine(kind, label);
    this.lines.set(kind, line);
    return line;
  }
  result(): CostGroup {
    const order: string[] = [...TOKEN_KINDS.map(([k]) => k), REPORTED_KIND];
    const lines = [...this.lines.values()].sort((a, b) => b.costUsd - a.costUsd || order.indexOf(a.key) - order.indexOf(b.key));
    return { id: 'token', heading: 'By token type', lines, daily: dailyOf(this.days) };
  }
}

/** A price's lines (priceBucket) as cost per token kind; a cache write with no 5m/1h split counts as 5 minutes. */
export function partsOf(lines: { kind: string; costUsd: number }[]): Partial<Record<CostPart, number>> {
  const parts: Partial<Record<CostPart, number>> = {};
  for (const l of lines) {
    const kind: CostPart | undefined = l.kind === 'cacheWrite' ? 'cacheWrite5m' : l.kind === 'webSearch' ? REPORTED_KIND
      : TOKEN_KINDS.some(([k]) => k === l.kind) ? l.kind as TokenKind : undefined;
    if (kind) parts[kind] = (parts[kind] ?? 0) + l.costUsd;
  }
  return parts;
}

/** The kind of work a row was. A routine's run counts as a routine, its subagents too. */
export const WORK_KINDS = { interactive: 'Interactive', subagent: 'Subagents', routine: 'Routines', walnut: 'Walnut itself' } as const;
export type WorkKind = keyof typeof WORK_KINDS;

/**
 * A coding session's row: a routine's when its task was made by a routine run (or
 * the session is a scheduled one), a subagent's when a subagent made it, else the
 * user's own work. A trigger firing into a task the user works in is not told apart
 * from the user's turns there: the rollup sums by day, not by turn.
 */
export function workKindOf(row: { subagent: boolean; routineTask?: boolean; sessionType?: string }): WorkKind {
  if (row.routineTask || row.sessionType === 'cron' || row.sessionType === 'triage' || row.sessionType === 'hook') return 'routine';
  return row.subagent ? 'subagent' : 'interactive';
}
