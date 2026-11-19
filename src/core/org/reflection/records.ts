/**
 * Where a finding lands besides the correction: the node's team guidance (one line a lesson, read
 * by the sessions it manages), its day's reflection record, and, for a lesson that needs steps, a
 * skill in Walnut's org skill registry (2026-11-19, the user: "let's do this in walnut as it is
 * shared across different agents").
 *
 * Files are plain Markdown under the node's folder of Walnut's knowledge
 * (`WALNUT_HOME/knowledge/nodes/<nodeTaskId>/`), so the user can read and edit them as notes:
 *   guidance.md               "- <rule>  (from <task>, <date>)" one line a lesson
 *   reflections/<date>.md     the day's findings, appended
 * A guidance line the user deletes stays deleted: its text is kept in the node's reflection
 * state (state.ts `removed`) and never written again.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { WALNUT_HOME } from '../../../constants.js';
import { withFileLock } from '../../../utils/file-lock.js';
import { normalizeForQuote, type Finding } from './judge.js';
import type { ReflectionSignal } from './signals.js';

export const GUIDANCE_LINES_MAX = 40;
export const GUIDANCE_NEW_PER_DAY_MAX = 3;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function nodeKnowledgeDir(nodeId: string): string {
  if (!TASK_ID_RE.test(nodeId)) throw new Error(`Invalid node id: ${nodeId}`);
  return path.join(WALNUT_HOME, 'knowledge', 'nodes', nodeId);
}
export const guidanceFileOf = (nodeId: string): string => path.join(nodeKnowledgeDir(nodeId), 'guidance.md');
export const reflectionDayFileOf = (nodeId: string, date: string): string => path.join(nodeKnowledgeDir(nodeId), 'reflections', `${date}.md`);

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

/**
 * Add one lesson unless an existing line or a removed one says it already (same text once
 * normalized), the day's new lines are spent, or the file is full. Returns whether it was added.
 */
export async function addGuidance(
  nodeId: string, nodeName: string, line: GuidanceLine, opts: { removed: readonly string[]; addedToday: number },
): Promise<'added' | 'known' | 'removed' | 'day_full' | 'file_full'> {
  const key = normalizeForQuote(line.text);
  if (!key) return 'known';
  if (opts.removed.includes(key)) return 'removed';
  const file = guidanceFileOf(nodeId);
  return withFileLock(file, async () => {
    const lines = parseGuidance(await fsp.readFile(file, 'utf-8').catch(() => ''));
    if (lines.some((l) => normalizeForQuote(l.text) === key)) return 'known';
    if (opts.addedToday >= GUIDANCE_NEW_PER_DAY_MAX) return 'day_full';
    if (lines.length >= GUIDANCE_LINES_MAX) return 'file_full';
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, renderGuidance(nodeName, [...lines, line]), 'utf-8');
    return 'added';
  });
}

/** Lines the reflection wrote before that are gone from the file now: the user deleted them. */
export function deletedSince(before: readonly string[], now: readonly GuidanceLine[]): string[] {
  const kept = new Set(now.map((l) => normalizeForQuote(l.text)));
  return before.filter((k) => !kept.has(k));
}

export interface DayEntry {
  at: string;
  signal: ReflectionSignal;
  task: { id: string; title: string };
  finding: Finding;
  corrected: 'sent' | 'already_fixed' | 'failed' | 'off';
  guidance: string;
  skill?: string;
}

const SIGNAL_LABEL: Record<ReflectionSignal, string> = {
  frustration: 'the user was frustrated', overruled: 'the user overruled the session',
  many_rounds: 'many rounds for one answer', decision_ask: 'checked before the user read it',
};

/** One finding as its day's record shows it. Pure. */
export function renderDayEntry(e: DayEntry): string {
  const f = e.finding;
  return [
    `## ${e.at.slice(11, 16)} ${e.task.title} (${e.task.id})`,
    `- Why looked: ${SIGNAL_LABEL[e.signal]}. Kind: ${f.kind}.`,
    `- The session said: "${f.session_quote}"`,
    ...(f.user_quote ? [`- The user said: "${f.user_quote}"`] : []),
    ...(f.rule_quote ? [`- Rule: "${f.rule_quote}"`] : []),
    `- What went wrong: ${f.what_went_wrong}`,
    `- The right way: ${f.correct_action}`,
    `- Correction: ${e.corrected === 'sent' ? 'sent to the session' : e.corrected === 'already_fixed' ? 'not sent, the session had already taken up the right way' : e.corrected === 'failed' ? 'could not be sent' : 'not sent'}`,
    `- Guidance: ${e.guidance}`,
    ...(e.skill ? [`- Skill: ${e.skill}`] : []),
    '',
  ].join('\n');
}

export async function appendDayEntry(nodeId: string, nodeName: string, date: string, entry: DayEntry): Promise<string> {
  const file = reflectionDayFileOf(nodeId, date);
  await withFileLock(file, async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const had = await fsp.readFile(file, 'utf-8').catch(() => '');
    const head = had ? '' : `# Session reflection: ${nodeName}, ${date}\n\n`;
    await fsp.appendFile(file, head + renderDayEntry(entry), 'utf-8');
  });
  return file;
}

/** A finding's skill, written to the org registry unless one of that name exists already. */
export async function writeFindingSkill(nodeId: string, nodeName: string, skill: NonNullable<Finding['skill']>): Promise<'written' | 'exists' | 'refused'> {
  const { listAgentSkills, writeAgentSkill } = await import('../../sessions/agent-skills.js');
  if ((await listAgentSkills('org', nodeId)).some((s) => s.name === skill.name)) return 'exists';
  try {
    await writeAgentSkill('org', nodeId, { name: skill.name, description: skill.description || `When: ${skill.name}`, content: skill.text },
      { by: `task:${nodeId}`, by_name: `${nodeName}'s reflection` });
    return 'written';
  } catch {
    return 'refused';
  }
}
