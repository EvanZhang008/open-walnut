/**
 * The pain registry of a reflecting node (2026-11-21, the user: "Make sure all the pain I have the
 * customer don't need experience again"): every complaint of his the reflection found, one entry a
 * pain (one problem one fix would end), each with his words, the cause, the rule that now covers it,
 * the test that guards it, the task that owns it, its status, and whether every user would meet it.
 *
 *   <node folder>/pains.json        the registry (PainFile, schemaVersion 1): what scripts and the pass read
 *   <node folder>/pains.md          the same, as he reads it
 *   <node folder>/pains-tests.json  the guard tests' last run (scripts/pain-guards.mjs), when one runs
 *   <node folder>/pains/images/     his pictures, by content (images/ stays out of the data sync)
 *
 * Paths inside the registry are relative to the node folder, so they hold when the folder moves with
 * its project. Reading and writing the files: pains-store.ts.
 *
 * A pain with no rule or no test is unowned, whatever status was written: its node hands it on. The
 * nightly note lists what is unowned, and every guard test the last run did not pass, missed, or that
 * has not run for GUARD_RUN_STALE_MS.
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { nodeArtifactsDir } from '../../artifacts/paths.js';

export const PAIN_SCHEMA_VERSION = 1;
export const PAIN_STATUSES = ['live', 'in_progress', 'unowned'] as const;
export type PainStatus = typeof PAIN_STATUSES[number];
export type PainScope = 'all_users' | 'only_him';
/** His words kept for one pain: the newest, each cut to QUOTE_MAX. */
export const PAIN_QUOTES_MAX = 5;
const QUOTE_MAX = 600;
/** The pains the judge is shown to match a complaint against: the newest. */
export const PAIN_TITLES_FOR_JUDGE = 80;
/** A guard run older than this is reported as not run. */
export const GUARD_RUN_STALE_MS = 36 * 3600_000;

export interface PainQuote { at: string; text: string; taskId?: string; threadId?: string; images?: string[] }
export interface PainEntry {
  id: string;
  title: string;
  kind: string;
  scope: PainScope;
  scopeWhy?: string;
  firstAt: string;
  lastAt: string;
  /** How many of his messages said it. */
  count: number;
  quotes: PainQuote[];
  rootCause?: string;
  /** The rule that covers it: where it is written (a file, a guidance line, a skill) and its words. */
  rule?: { where: string; text: string };
  /** The test that fails when it comes back. */
  test?: { file: string; name: string };
  owner?: { taskId: string; title: string };
  /** As written; statusOf gives the one shown (no rule or no test: unowned). */
  status: PainStatus;
  note?: string;
  /** Who last changed it by hand (the route's writer: 'human' or 'task:<id>'). */
  changedBy?: string;
}
export interface PainFile { schemaVersion: 1; nodeId: string; nodeName: string; updatedAt: string; entries: PainEntry[] }

/** One guard test's last run (scripts/pain-guards.mjs). */
/** ci_only: a browser spec, which only CI's browser jobs run. */
export type GuardResult = 'passed' | 'ci_only' | 'failed' | 'no_file' | 'no_test' | 'not_run';
export interface GuardRun { schemaVersion: 1; at: string; commit?: string; results: Record<string, { result: GuardResult; detail?: string }> }

export const painsFileOf = (nodeId: string): string => path.join(nodeArtifactsDir(nodeId), 'pains.json');
export const painsMarkdownOf = (nodeId: string): string => path.join(nodeArtifactsDir(nodeId), 'pains.md');
export const guardRunFileOf = (nodeId: string): string => path.join(nodeArtifactsDir(nodeId), 'pains-tests.json');
/** His pictures, relative to the node folder (git-sync ignores every images/ folder). */
export const PAIN_IMAGES_REL = path.join('pains', 'images');
/** A path the registry holds, as an absolute one: relative ones are the node folder's. Pure but for the folder. */
export const resolvePainPath = (nodeId: string, p: string): string => (path.isAbsolute(p) ? p : path.join(nodeArtifactsDir(nodeId), p));

export const painId = (seed: string): string => `pn-${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 8)}`;

/** A pain every user would meet whose rule is not in the product itself: everyone else still lacks it. Pure. */
export function lacksGenericDefault(e: Pick<PainEntry, 'scope' | 'rule'>): boolean {
  // Only the product's own code (its default instructions, its gates, its UI) is a default for every
  // user: a rule in USER.md, a team's guidance, a skill or a developer doc is not.
  return e.scope === 'all_users' && !!e.rule && !/(?:^|[\s(;,'/])(?:src|web\/src)\/(?![\w/.-]*AGENTS\.md)/.test(e.rule.where);
}

/** The status shown: what was written, unless no rule or no test covers it yet. Pure. */
export function statusOf(e: Pick<PainEntry, 'status' | 'rule' | 'test'>): PainStatus {
  return !e.rule?.where || !e.test?.file || !e.test?.name ? 'unowned' : e.status;
}

/** The fields this release reads; any other field of an entry is kept as written (pains-store.ts). */
export const PAIN_KNOWN_KEYS: ReadonlySet<string> = new Set(['id', 'title', 'kind', 'scope', 'scopeWhy', 'firstAt', 'lastAt', 'count', 'quotes', 'rootCause', 'rule', 'test', 'owner', 'status', 'note', 'changedBy']);

const str = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);

/** One entry read back, hand-edited ones included: what is malformed is left out. Pure. */
export function normalizePain(raw: unknown): PainEntry | null {
  const e = obj(raw);
  if (!e || !str(e.id) || !str(e.title)) return null;
  const rule = obj(e.rule);
  const test = obj(e.test);
  const owner = obj(e.owner);
  const quotes = (Array.isArray(e.quotes) ? e.quotes : []).flatMap((q) => {
    const o = obj(q);
    return o && str(o.at) && str(o.text) ? [{
      at: o.at, text: o.text, ...(str(o.taskId) ? { taskId: o.taskId } : {}), ...(str(o.threadId) ? { threadId: o.threadId } : {}),
      ...(Array.isArray(o.images) && o.images.every(str) && o.images.length ? { images: o.images as string[] } : {}),
    }] : [];
  });
  const firstAt = str(e.firstAt) ? e.firstAt : quotes[0]?.at ?? '';
  return {
    id: e.id, title: e.title, kind: str(e.kind) ? e.kind : 'other', scope: e.scope === 'only_him' ? 'only_him' : 'all_users',
    ...(str(e.scopeWhy) ? { scopeWhy: e.scopeWhy } : {}),
    firstAt, lastAt: str(e.lastAt) ? e.lastAt : firstAt, count: Number.isInteger(e.count) && (e.count as number) > 0 ? e.count as number : Math.max(1, quotes.length),
    quotes, ...(str(e.rootCause) ? { rootCause: e.rootCause } : {}),
    ...(rule && str(rule.where) ? { rule: { where: rule.where, text: str(rule.text) ? rule.text : '' } } : {}),
    ...(test && str(test.file) && str(test.name) ? { test: { file: test.file, name: test.name } } : {}),
    ...(owner && str(owner.taskId) ? { owner: { taskId: owner.taskId, title: str(owner.title) ? owner.title : '' } } : {}),
    status: (PAIN_STATUSES as readonly unknown[]).includes(e.status) ? e.status as PainStatus : 'unowned',
    ...(str(e.note) ? { note: e.note } : {}), ...(str(e.changedBy) ? { changedBy: e.changedBy } : {}),
  };
}


const STATUS_LABEL: Record<PainStatus, string> = { unowned: 'Unowned (no rule or no test yet)', in_progress: 'In progress', live: 'Live (rule and test in place)' };
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** One entry as pains.md shows it. Pure. */
export function renderPain(e: PainEntry, run?: GuardRun | null, resolve: (p: string) => string = (p) => p): string {
  const g = e.test ? run?.results[e.id] : undefined;
  return [
    `### ${e.title} (${e.id})`,
    `- Scope: ${e.scope === 'all_users' ? 'every user would meet it' : 'only this user'}${e.scopeWhy ? ` (${e.scopeWhy})` : ''}. Kind: ${e.kind}. Said ${e.count} time${e.count === 1 ? '' : 's'}, ${e.firstAt.slice(0, 10)} to ${e.lastAt.slice(0, 10)}.`,
    ...e.quotes.map((q) => `- His words (${q.at.slice(0, 16).replace('T', ' ')}${q.taskId ? `, task ${q.taskId}` : ''}${q.threadId ? `, thread ${q.threadId}` : ''}): "${oneLine(q.text)}"${q.images?.length ? ` Screenshot: ${q.images.map(resolve).join(', ')}` : ''}`),
    `- Root cause: ${e.rootCause ?? 'not found yet'}`,
    `- Rule: ${e.rule ? `${e.rule.where}${e.rule.text ? `: ${oneLine(e.rule.text)}` : ''}` : 'none yet'}`,
    ...(lacksGenericDefault(e) ? ['- Generic default: missing (the rule is not in the product\'s code or default instructions, so other users do not get it)'] : []),
    `- Guard test: ${e.test ? `${e.test.file} "${e.test.name}"${g ? ` (last run: ${g.result}${g.detail ? `, ${oneLine(g.detail)}` : ''})` : run ? ' (not in the last run)' : ''}` : 'none yet'}`,
    `- Owner: ${e.owner ? `${e.owner.title} (${e.owner.taskId})` : 'nobody yet'}`,
    ...(e.note ? [`- Note: ${e.note}`] : []),
    '',
  ].join('\n');
}

/** The whole of pains.md. Pure. */
export function renderPains(nodeName: string, entries: readonly PainEntry[], run?: GuardRun | null, resolve?: (p: string) => string): string {
  const head = [
    `# Pain registry: ${nodeName}`,
    '',
    `Every complaint of the user the reflection found, one entry a pain. ${entries.length} pain${entries.length === 1 ? '' : 's'}: `
      + PAIN_STATUSES.map((s) => `${entries.filter((e) => statusOf(e) === s).length} ${s.replace('_', ' ')}`).join(', ') + '.',
    `Guard tests last run: ${run ? `${run.at}${run.commit ? ` on ${run.commit.slice(0, 12)}` : ''}: ${guardCountsLine(run)}` : 'never'}. pains.json holds the same entries for scripts; edits to it are kept.`,
    '',
  ];
  // What needs someone first: unowned, then in progress, then live.
  const body = [...PAIN_STATUSES].reverse().flatMap((s) => {
    const of = entries.filter((e) => statusOf(e) === s).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
    return of.length ? [`## ${STATUS_LABEL[s]}`, '', ...of.map((e) => renderPain(e, run, resolve))] : [];
  });
  return [...head, ...body].join('\n');
}

const GUARD_RESULTS: readonly GuardResult[] = ['passed', 'ci_only', 'failed', 'no_file', 'no_test', 'not_run'];

/** A run's results counted, in GUARD_RESULTS order ("31 passed, 5 ci only, 2 no test"): a run that passed is seen too. Pure. */
export function guardCountsLine(run: GuardRun): string {
  const n = new Map<GuardResult, number>();
  for (const g of Object.values(run.results)) n.set(g.result, (n.get(g.result) ?? 0) + 1);
  const parts = GUARD_RESULTS.filter((r) => n.get(r)).map((r) => `${n.get(r)} ${r.replace('_', ' ')}`);
  return parts.length ? parts.join(', ') : 'no results';
}

/** A guard run read from a file or a request: what is malformed is left out, a run with no time is none. Pure. */
export function guardRunOf(raw: unknown): GuardRun | null {
  const r = obj(raw);
  const at = r && str(r.at) && !Number.isNaN(Date.parse(r.at)) ? r.at : null;
  const results = r ? obj(r.results) : null;
  if (!at || !results) return null;
  const out: GuardRun['results'] = {};
  for (const [id, v] of Object.entries(results).slice(0, 1000)) {
    const g = obj(v);
    if (g && (GUARD_RESULTS as readonly unknown[]).includes(g.result)) out[id] = { result: g.result as GuardResult, ...(str(g.detail) ? { detail: g.detail.slice(0, 600) } : {}) };
  }
  return { schemaVersion: 1, at, ...(r && str(r.commit) ? { commit: r.commit.slice(0, 64) } : {}), results: out };
}




/** A complaint the reflection found, as the registry takes it. */
export interface PainReport {
  /** The judge's match: an existing pain's id, or '' for a new one. */
  sameAs: string;
  title: string;
  scope: PainScope;
  kind: string;
  quote: PainQuote;
  rootCause: string;
  rule?: { where: string; text: string };
  owner: { taskId: string; title: string };
}

/** The registry with one complaint added: to its pain (same id), or as a new unowned pain. Pure. */
export function addComplaint(entries: readonly PainEntry[], r: PainReport): { entries: PainEntry[]; id: string; isNew: boolean } {
  const quote = { ...r.quote, text: r.quote.text.slice(0, QUOTE_MAX) };
  const hit = r.sameAs ? entries.find((e) => e.id === r.sameAs) : undefined;
  if (hit) {
    // The same words twice (a message filed in a thread and its task) are one complaint.
    if (hit.quotes.some((q) => q.text === quote.text)) return { entries: [...entries], id: hit.id, isNew: false };
    const next: PainEntry = {
      ...hit, count: hit.count + 1, lastAt: quote.at > hit.lastAt ? quote.at : hit.lastAt,
      quotes: [...hit.quotes, quote].sort((a, b) => a.at.localeCompare(b.at)).slice(-PAIN_QUOTES_MAX),
      ...(!hit.rule && r.rule ? { rule: r.rule } : {}), ...(!hit.rootCause && r.rootCause ? { rootCause: r.rootCause } : {}),
    };
    return { entries: entries.map((e) => (e.id === hit.id ? next : e)), id: hit.id, isNew: false };
  }
  let id = painId(`${r.title}|${quote.at}`);
  while (entries.some((e) => e.id === id)) id = painId(`${id}|again`);
  const entry: PainEntry = {
    id, title: r.title.slice(0, 160), kind: r.kind, scope: r.scope, firstAt: quote.at, lastAt: quote.at, count: 1, quotes: [quote],
    ...(r.rootCause ? { rootCause: r.rootCause } : {}), ...(r.rule ? { rule: r.rule } : {}), owner: r.owner, status: 'unowned',
  };
  return { entries: [...entries, entry], id, isNew: true };
}

/** What the nightly note says about the registry: unowned pains, and guard tests not passing. Pure. */
export interface PainsReport { total: number; unowned: PainEntry[]; guards: Array<{ entry: PainEntry; result: GuardResult | 'stale'; detail?: string }> }

export function painsReport(entries: readonly PainEntry[], run: GuardRun | null, nowMs: number): PainsReport {
  const stale = !run || nowMs - Date.parse(run.at) > GUARD_RUN_STALE_MS;
  type Guard = PainsReport['guards'][number];
  const guards = entries.filter((e) => e.test).flatMap((entry): Guard[] => {
    if (stale) return [{ entry, result: 'stale' }];
    const g = run!.results[entry.id];
    if (!g) return [{ entry, result: 'not_run' }];
    return g.result === 'passed' || g.result === 'ci_only' ? [] : [{ entry, result: g.result, ...(g.detail ? { detail: g.detail } : {}) }];
  });
  return { total: entries.length, unowned: entries.filter((e) => statusOf(e) === 'unowned'), guards };
}

/** The registry's part of the nightly note: '' when nothing in it needs the node. Pure. */
export function painsNightlyText(file: string, r: PainsReport, run: GuardRun | null): string {
  // A run that passed is said in one line too (2026-11-24 audit: a passing run showed nowhere but the file).
  const ran = run && !r.guards.some((g) => g.result === 'stale') ? `- Guard tests ran ${run.at}${run.commit ? ` on ${run.commit.slice(0, 12)}` : ''}: ${guardCountsLine(run)}.` : '';
  // Alone it wakes nobody: a day with nothing else for the node sends no note (the registry's header says it).
  if (!r.unowned.length && !r.guards.length) return '';
  const lines = [`Pain registry (${r.total} pains, ${file}):`, ...(ran ? [ran] : [])];
  if (r.unowned.length) {
    lines.push(`- ${r.unowned.length} with no rule or no guard test yet: hand each to the task that owns its area, and write the rule and the test into the entry when they land.`);
    for (const e of r.unowned.slice(0, 12)) lines.push(`  - ${e.id} ${e.title}${e.owner ? ` (owner: ${e.owner.title}, ${e.owner.taskId})` : ' (no owner)'}`);
    if (r.unowned.length > 12) lines.push(`  - ... and ${r.unowned.length - 12} more, in the file`);
  }
  const stale = r.guards.filter((g) => g.result === 'stale');
  if (stale.length) lines.push(`- The guard tests have not run since ${run ? run.at : 'ever'}: none of the ${stale.length} is known to pass today (scripts/pain-guards.mjs writes ${path.basename(guardRunFileOf('x'))}).`);
  for (const g of r.guards.filter((x) => x.result !== 'stale').slice(0, 12)) {
    lines.push(`- Guard test ${g.result.replace('_', ' ')} for ${g.entry.id} ${g.entry.title}: ${g.entry.test!.file} "${g.entry.test!.name}"${g.detail ? ` (${oneLine(g.detail).slice(0, 160)})` : ''}`);
  }
  return lines.join('\n');
}
