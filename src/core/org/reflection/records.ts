/**
 * Where a finding lands besides the correction: the node's team guidance (one line a lesson, read
 * by the sessions it manages), its day's reflection record, and, for a lesson that needs steps, a
 * skill in Walnut's org skill registry (2026-11-19, the user: "let's do this in walnut as it is
 * shared across different agents").
 *
 * Files are plain Markdown under the node's folder of Walnut's artifacts
 * (`WALNUT_HOME/artifacts/nodes/<nodeTaskId>/`), so the user can read and edit them as notes:
 *   guidance.md               "- <rule>  (from <task>, <date>)" one line a lesson
 *   reflections/<date>.md     the day's findings, appended: each says the rule it became and the
 *                             task its correction went to
 *   reflections/<date>.json   the same entries as JSON (DayFile, schemaVersion 1), for scripts
 *                             and the nightly note; a day before it has only the Markdown
 * A guidance line the user deletes stays deleted: its text is kept in the node's reflection
 * state (state.ts `removed`) and never written again.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { nodeArtifactsDir } from '../../artifacts/paths.js';
import { withFileLock } from '../../../utils/file-lock.js';
import { normalizeForQuote, type Finding } from './judge.js';
import type { ReflectionSignal } from './signals.js';

export const GUIDANCE_LINES_MAX = 40;
/** New lines a day (a merge is none): more than a few a day churns what every session reads. */
export const GUIDANCE_NEW_PER_DAY_MAX = 6;
/** Places of the org skill registry the reflection leaves to the nodes themselves. */
const SKILL_ROOM_KEPT = 5;
export const guidanceFileOf = (nodeId: string): string => path.join(nodeArtifactsDir(nodeId), 'guidance.md');
export const reflectionDayFileOf = (nodeId: string, date: string): string => path.join(nodeArtifactsDir(nodeId), 'reflections', `${date}.md`);

/** Why a correction was not sent, as the day record says it. */
const NOT_SENT_WHY: Record<NonNullable<DayEntry['notSent']>, string> = {
  no_session: 'no known session to send to', task_done: 'the task is complete', not_managed: 'the task is not in this node\'s team now',
  duty_off: 'the node\'s reflection switch is off', org_off: 'the org is off', gone: 'the task or the node is gone', off: 'cause not recorded',
};

export interface GuidanceLine { text: string; from?: string; date?: string }

const LINE_RE = /^- (.+?)(?:\s{2}\(from (.+), (\d{4}-\d{2}-\d{2})\))?\s*$/;

/** The guidance lines of a guidance.md text: every "- " line, its source note split off. Pure. */
export function parseGuidance(text: string): GuidanceLine[] {
  const out: GuidanceLine[] = [];
  for (const raw of text.split('\n')) {
    const m = LINE_RE.exec(raw.trimEnd());
    if (!m) continue;
    out.push({ text: m[1].trim(), ...(m[2] ? { from: m[2], date: m[3] } : {}) });
  }
  return out;
}

export function renderGuidance(nodeName: string, lines: readonly GuidanceLine[]): string {
  return [
    `# Team guidance: ${nodeName}`,
    '',
    'One rule a line. The sessions this node manages read them. Written by its reflection; edit or delete any line.',
    '',
    ...lines.map((l) => `- ${l.text}${l.from ? `  (from ${l.from}, ${l.date})` : ''}`),
    '',
  ].join('\n');
}

export async function readGuidance(nodeId: string): Promise<GuidanceLine[]> {
  return parseGuidance(await fsp.readFile(guidanceFileOf(nodeId), 'utf-8').catch(() => ''));
}

/** The lines as the file holds them now, or null when it cannot be read (gone, a lock, a sync mid-write). */
export async function readGuidanceStrict(nodeId: string): Promise<GuidanceLine[] | null> {
  try {
    return parseGuidance(await fsp.readFile(guidanceFileOf(nodeId), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Add one lesson unless an existing line or a removed one says it already (same text once
 * normalized; an existing line also when it says nearly the same, nearlySame), the day's new lines are spent, or the file is full. The line is appended: what the
 * user wrote in the file (a heading, notes, other lists) stays as it is.
 */
export async function addGuidance(
  nodeId: string, nodeName: string, line: GuidanceLine, opts: { removed: readonly string[]; addedToday: number },
): Promise<'added' | 'known' | 'removed' | 'day_full' | 'file_full'> {
  const key = normalizeForQuote(line.text);
  if (!key) return 'known';
  if (opts.removed.includes(key)) return 'removed';
  const file = guidanceFileOf(nodeId);
  return withFileLock(file, async () => {
    const had = await fsp.readFile(file, 'utf-8').catch(() => null);
    const lines = parseGuidance(had ?? '');
    // A line that says nearly the same is the lesson already (2026-11-24 audit: the backfill wrote two
    // near-identical lines on one day; lessons of several tasks said the same in other words).
    if (lines.some((l) => normalizeForQuote(l.text) === key || nearlySame(l.text, line.text))) return 'known';
    if (opts.addedToday >= GUIDANCE_NEW_PER_DAY_MAX) return 'day_full';
    if (lines.length >= GUIDANCE_LINES_MAX) return 'file_full';
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const row = renderGuidance(nodeName, [line]).split('\n').filter((l) => l.startsWith('- ')).join('\n');
    if (had === null) await fsp.writeFile(file, renderGuidance(nodeName, [line]), 'utf-8');
    else await fsp.appendFile(file, `${had.endsWith('\n') || !had ? '' : '\n'}${row}\n`, 'utf-8');
    return 'added';
  });
}

/** Two lessons that say much the same: of about one length, most of the shorter one's character pairs in the other (any script). */
export function nearlySame(a: string, b: string): boolean {
  const pairs = (t: string) => { const x = normalizeForQuote(t).replace(/\s+/g, ''); const out = new Set<string>(); for (let i = 0; i < x.length - 1; i++) out.add(x.slice(i, i + 2)); return out; };
  const [p, q] = [pairs(a), pairs(b)];
  if (!p.size || !q.size) return false;
  const [small, big] = p.size <= q.size ? [p, q] : [q, p];
  // Of about one length: a short lesson inside a long line is another lesson (2026-11-24 review: "Run the
  // tests before you land." read as said by a 260-character line).
  if (small.size / big.size < 0.5) return false;
  let hit = 0;
  for (const x of small) if (big.has(x)) hit++;
  return hit / small.size >= 0.6;
}

/**
 * Put `next` in the place of the line whose text is `oldText` (guidance-merge.ts: a lesson merged into
 * it). 'gone' when that line is no longer in the file (the user edited or deleted it meanwhile):
 * nothing is written then. Everything else in the file stays as it is.
 */
export async function replaceGuidanceLine(nodeId: string, nodeName: string, oldText: string, next: GuidanceLine): Promise<'replaced' | 'gone'> {
  const file = guidanceFileOf(nodeId);
  const key = normalizeForQuote(oldText);
  return withFileLock(file, async () => {
    const had = await fsp.readFile(file, 'utf-8').catch(() => null);
    if (had === null) return 'gone';
    const rows = had.split('\n');
    const at = rows.findIndex((raw) => { const m = LINE_RE.exec(raw.trimEnd()); return !!m && normalizeForQuote(m[1]) === key; });
    if (at < 0) return 'gone';
    rows[at] = renderGuidance(nodeName, [next]).split('\n').find((l) => l.startsWith('- '))!;
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, rows.join('\n'), 'utf-8');
    await fsp.rename(tmp, file);
    return 'replaced';
  });
}

/** Lines the reflection wrote before that are gone from the file now: the user deleted them. */
export function deletedSince(before: readonly string[], now: readonly GuidanceLine[]): string[] {
  const kept = new Set(now.map((l) => normalizeForQuote(l.text)));
  return before.filter((k) => !kept.has(k));
}

/**
 * The rule a finding became: a new guidance line (its number in the file), a skill (with the line
 * when one was added too), a line already listed, or none (and why, in `text`).
 */
export interface DayRule {
  kind: 'guidance' | 'skill' | 'existing' | 'none'; text: string; line?: number; name?: string;
  /** A lesson merged into a line (guidance-merge.ts): the line's text before, the undo. */
  was?: string;
}

export interface DayEntry {
  at: string;
  signal: ReflectionSignal;
  task: { id: string; title: string };
  /** The thread his message was filed in, when it was a thread message. */
  thread?: { id: string; title: string };
  finding: Finding;
  /** `held`: a real correction kept from the session (`held` says why), in the record and the nightly note only. */
  corrected: 'sent' | 'already_fixed' | 'failed' | 'off' | 'held';
  /** own_cap: past a Main or lead chat's spacing; one_per_pass: its session got one this pass (both wait for a later send, held-corrections.ts); no_asking_session / no_session: no known session to send to. */
  held?: 'own_cap' | 'one_per_pass' | 'no_asking_session' | 'no_session';
  /** A held correction sent later, with others held for the same task (held-corrections.ts): when. */
  sentLater?: string;
  /** A held correction never sent (it waited too long, or more waited for its task): when it was dropped. */
  heldDropped?: string;
  /** With `off`: why it was not sent (pipeline.ts SendCheck). */
  notSent?: 'no_session' | 'task_done' | 'not_managed' | 'duty_off' | 'org_off' | 'gone' | 'off';
  /** Sent to the task's session now, about a turn of an earlier one. */
  earlierSession?: boolean;
  rule: DayRule;
  /** The task its correction was sent to; absent when none was sent. */
  handedTo?: { taskId: string; title: string };
  /** The pain registry entry his complaint went to (pains.ts), and whether it opened it. */
  pain?: { id: string; title: string; isNew: boolean } | { pending: true; title: string };
}

/** The day file's JSON twin: the entries for a script and the nightly note, no Markdown to parse. */
export const DAY_SCHEMA_VERSION = 1;
export interface DayFile {
  schemaVersion: 1; nodeId: string; nodeName: string; date: string; entries: DayEntry[];
  /** The day's notes (a spent judge budget): the same lines as the Markdown's "> Note:". */
  notes?: Array<{ at: string; text: string }>;
  /** The day's passes: how many, and the last one's counts, so a day with no finding still shows it ran. */
  passes?: { count: number; last: { at: string; candidates: number; judged: number; skipped: number } };
}
export const reflectionDayJsonOf = (nodeId: string, date: string): string => reflectionDayFileOf(nodeId, date).replace(/\.md$/, '.json');

const SIGNAL_LABEL: Record<ReflectionSignal, string> = {
  frustration: 'the user was frustrated', overruled: 'the user overruled the session',
  many_rounds: 'many rounds for one answer', needs_ask: 'an ask that reached Needs you',
  not_for_user: 'the user said the ask was not his to answer',
  unclear_ask: 'the user could not tell what an ask meant', unreviewed_design: 'the user said a design shown to him was not reviewed',
  regression: 'the user said something broke', built_different: 'the user said it is not what he asked for',
  duplicate_display: 'the user said something shows more than once', wrong_language: 'an answer in another language than his setting',
};

/** The rule as one line of text. Pure. */
export function ruleLine(r: DayRule | undefined): string {
  if (!r) return 'none';
  switch (r.kind) {
    case 'guidance': return `guidance line ${r.line ?? '?'}${r.was ? ` (merged; was: ${r.was})` : ''}: ${r.text}`;
    case 'skill': return `skill ${r.name ?? '?'}${r.line ? ` and guidance line ${r.line}` : ''}: ${r.text}`;
    case 'existing': return `already listed (guidance line ${r.line ?? '?'})${r.text ? `: ${r.text}` : ''}`;
    default: return `none${r.text ? ` (${r.text})` : ''}`;
  }
}

export const handedToLine = (e: Pick<DayEntry, 'handedTo' | 'held'>): string => (e.handedTo ? `${e.handedTo.title} (${e.handedTo.taskId})` : `none${e.held ? ` (${e.held})` : ''}`);

/** One finding as its day's record shows it. Pure. */
export function renderDayEntry(e: DayEntry): string {
  const f = e.finding;
  return [
    `## ${e.at.slice(11, 16)} ${e.task.title} (${e.task.id})`,
    `- Why looked: ${SIGNAL_LABEL[e.signal] ?? e.signal}. Kind: ${f.kind}.`,
    ...(e.thread ? [`- Thread: ${e.thread.title} (${e.thread.id})`] : []),
    `- The session said: "${f.session_quote}"`,
    ...(f.user_quote ? [`- The user said: "${f.user_quote}"`] : []),
    ...(f.rule_quote ? [`- Rule quoted: "${f.rule_quote}"`] : []),
    `- What went wrong: ${f.what_went_wrong}`,
    `- The right way: ${f.correct_action}`,
    `- Correction: ${e.corrected === 'sent' ? (e.earlierSession ? 'sent to the task\'s current session (the turn was in an earlier one)' : 'sent to the session') : e.corrected === 'already_fixed' ? 'not sent, the session had already taken up the right way' : e.corrected === 'failed' ? 'could not be sent' : e.corrected === 'held' ? `held (${e.held ?? 'held'})` : `not sent (${NOT_SENT_WHY[e.notSent ?? 'off']})`}`,
    `- Rule: ${ruleLine(e.rule)}`,
    `- Handed to: ${handedToLine(e)}`,
    ...(e.pain ? ['pending' in e.pain ? `- Pain registry: waits to be filed (the registry cannot be read): ${e.pain.title}` : `- Pain registry: ${e.pain.isNew ? 'new pain' : 'added to'} ${e.pain.id} ${e.pain.title}`] : []),
    '',
  ].join('\n');
}

/** An entry read back from a day's JSON, older or hand-edited ones included: missing fields read as none. */
function normalizeEntry(raw: unknown): DayEntry | null {
  const e = raw as Partial<DayEntry> | null;
  if (!e || typeof e !== 'object' || typeof e.at !== 'string' || !e.finding || typeof e.finding !== 'object' || !e.task) return null;
  const rule = e.rule && typeof e.rule === 'object' && typeof e.rule.kind === 'string' ? e.rule : { kind: 'none' as const, text: '' };
  const { handedTo, ...rest } = e;
  return { ...rest, rule, ...(handedTo && typeof handedTo.taskId === 'string' ? { handedTo } : {}) } as DayEntry;
}

/** A day's JSON as read: missing, unreadable (not JSON, or no entries list), or its entries. */
type DayJson = { state: 'missing' } | { state: 'bad' } | { state: 'ok'; entries: DayEntry[]; notes?: DayFile['notes']; passes?: DayFile['passes'] };

async function readDayJson(nodeId: string, date: string): Promise<DayJson> {
  const raw = await fsp.readFile(reflectionDayJsonOf(nodeId, date), 'utf-8').catch(() => null);
  if (raw === null) return { state: 'missing' };
  try {
    const f = JSON.parse(raw) as Partial<DayFile>;
    return Array.isArray(f.entries) ? {
      state: 'ok', entries: f.entries.map(normalizeEntry).filter((x): x is DayEntry => !!x),
      ...(Array.isArray(f.notes) ? { notes: f.notes } : {}), ...(f.passes && typeof f.passes === 'object' ? { passes: f.passes } : {}),
    } : { state: 'bad' };
  } catch {
    return { state: 'bad' };
  }
}

/** The day's entries from its JSON, or null when it has none readable (a day before the JSON, no finding, a broken file). */
export async function readDayEntries(nodeId: string, date: string): Promise<DayEntry[] | null> {
  const day = await readDayJson(nodeId, date);
  return day.state === 'ok' ? day.entries : null;
}

/**
 * Append one finding to the day's Markdown and its JSON twin, both under the Markdown file's lock.
 * A JSON that no longer parses is kept aside as `<date>.json.bad` and the JSON starts again: the
 * entries it held are all in the Markdown, which the nightly note reads for whatever the JSON lacks
 * (nightly.ts dayLines), so none is dropped.
 */
export async function appendDayEntry(nodeId: string, nodeName: string, date: string, entry: DayEntry): Promise<string> {
  const file = reflectionDayFileOf(nodeId, date);
  await withFileLock(file, async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const had = await fsp.readFile(file, 'utf-8').catch(() => '');
    const head = had ? '' : `# Session reflection: ${nodeName}, ${date}\n\n`;
    await fsp.appendFile(file, head + renderDayEntry(entry), 'utf-8');
    await writeDayJson(nodeId, nodeName, date, (d) => { d.entries.push(entry); });
  });
  return file;
}

/** One line about the pass itself (a spent budget) in the day's Markdown; the JSON keeps findings only. */
export async function appendDayNote(nodeId: string, nodeName: string, date: string, text: string, nowMs = Date.now()): Promise<void> {
  const file = reflectionDayFileOf(nodeId, date);
  const line = text.replace(/\s+/g, ' ').trim();
  await withFileLock(file, async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const had = await fsp.readFile(file, 'utf-8').catch(() => '');
    await fsp.appendFile(file, `${had ? '' : `# Session reflection: ${nodeName}, ${date}\n\n`}> Note: ${line}\n\n`, 'utf-8');
    // In the JSON too: an audit reads the JSON (2026-11-23: "the day's record says nothing of the budget");
    // never one that would start over a day the Markdown already holds (recordDayPass says why).
    if (had && (await readDayJson(nodeId, date)).state !== 'ok') return;
    await writeDayJson(nodeId, nodeName, date, (d) => { d.notes = [...(d.notes ?? []), { at: new Date(nowMs).toISOString(), text: line }]; });
  });
}

/** Whether the day's record already holds a note that starts with `prefix` (its Markdown, which every note goes to). */
export async function dayNoteSaid(nodeId: string, date: string, prefix: string): Promise<boolean> {
  const text = await fsp.readFile(reflectionDayFileOf(nodeId, date), 'utf-8').catch(() => '');
  return text.includes(`> Note: ${prefix}`);
}

/** Held entries of a day sent later or dropped: each marked with when (its JSON; the Markdown gets a note). */
export async function markHeld(nodeId: string, nodeName: string, date: string, taskId: string, entryAts: readonly string[], how: 'sentLater' | 'heldDropped', nowMs = Date.now()): Promise<void> {
  const file = reflectionDayFileOf(nodeId, date);
  await withFileLock(file, async () => {
    if ((await readDayJson(nodeId, date)).state !== 'ok') return;
    await writeDayJson(nodeId, nodeName, date, (d) => {
      for (const e of d.entries) if (e.task.id === taskId && e.corrected === 'held' && entryAts.includes(e.at)) e[how] = new Date(nowMs).toISOString();
    });
  });
}

/** One pass of the day, counted in its JSON (no Markdown line: a pass with no finding adds nothing to read). */
export async function recordDayPass(nodeId: string, nodeName: string, date: string, counts: { candidates: number; judged: number; skipped: number }, nowMs = Date.now()): Promise<void> {
  const file = reflectionDayFileOf(nodeId, date);
  await withFileLock(file, async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // A day whose Markdown holds entries its JSON does not (a broken JSON set aside, a day before the
    // JSON) is left as it is: a count alone would make the JSON the day's record and hide them.
    const read = await readDayJson(nodeId, date);
    if (read.state !== 'ok' && await fsp.access(file).then(() => true, () => false)) return;
    await writeDayJson(nodeId, nodeName, date, (d) => {
      d.passes = { count: (d.passes?.count ?? 0) + 1, last: { at: new Date(nowMs).toISOString(), ...counts } };
    });
  });
}

/** Read, change and write the day's JSON whole (under the day file's lock): a broken one is set aside first. */
async function writeDayJson(nodeId: string, nodeName: string, date: string, change: (d: DayFile) => void): Promise<void> {
  const json = reflectionDayJsonOf(nodeId, date);
  const read = await readDayJson(nodeId, date);
  if (read.state === 'bad') await fsp.rename(json, `${json}.bad`).catch(() => {});
  const day: DayFile = {
    schemaVersion: DAY_SCHEMA_VERSION, nodeId, nodeName, date, entries: read.state === 'ok' ? read.entries : [],
    ...(read.state === 'ok' && read.notes ? { notes: read.notes } : {}), ...(read.state === 'ok' && read.passes ? { passes: read.passes } : {}),
  };
  change(day);
  const tmp = `${json}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(day, null, 2)}\n`, 'utf-8');
  await fsp.rename(tmp, json);
}

/** A finding's skill, written to the org registry unless one of that name exists already. Never throws. */
export async function writeFindingSkill(nodeId: string, nodeName: string, skill: NonNullable<Finding['skill']>): Promise<'written' | 'exists' | 'no_room' | 'refused'> {
  try {
    const { listAgentSkills, writeAgentSkill, AGENT_SKILLS_MAX } = await import('../../sessions/agent-skills.js');
    const org = await listAgentSkills('org', nodeId);
    if (org.some((s) => s.name === skill.name)) return 'exists';
    // The registry is the org's: the reflection never takes its last places from the nodes' own writes.
    if (org.length >= AGENT_SKILLS_MAX - SKILL_ROOM_KEPT) return 'no_room';
    await writeAgentSkill('org', nodeId, { name: skill.name, description: skill.description || `When: ${skill.name}`, content: skill.text },
      { by: `task:${nodeId}`, by_name: `${nodeName}'s reflection` });
    return 'written';
  } catch {
    return 'refused';
  }
}
