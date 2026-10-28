/**
 * The agent's own MEMORY.md: the working memory Main, every lead (VP) and every leader task keep
 * for themselves. 2026-10-27, the user, after Main put a deadline they did not need into its
 * Brief: "the brief is for people, only what is important goes in ... you can put it in your own
 * notes", "every agent can have its own notes; Walnut must control its length, but not too
 * tightly", "call it memory.md, every CEO, VP and leader has one".
 *
 * What goes in: pending items, a deadline days away, reminders, things to raise later, facts the
 * agent learned for its own work. Not shown to the user by default (no Brief, Board, status line,
 * chat or task list); a view that shows it reads its own route, folded and read-only.
 *
 * Not the global MEMORY.md / USER.md (memory_read / memory_write, the user's standing memory):
 * this one lives on the task (`task.agent_memory`), is named with the task everywhere, and is
 * read and written through agent_memory_read / agent_memory_write.
 *
 * Length: Walnut keeps it useful, not stingy. Up to AGENT_MEMORY_SOFT_CHARS it is left alone;
 * past it every turn-end ask tells the agent to rewrite it shorter, keeping everything still
 * valid; a write past AGENT_MEMORY_MAX_CHARS is refused whole and says so, never cut silently.
 */
import type { Task } from '../types.js';
import { cutEnd } from '../text-cut.js';
import { orgDisplayTitle } from '../org/org-tree.js';

/** Who made a write: the user, another task, or a caller Walnut cannot name. */
export type AgentMemoryWriter = 'human' | 'agent' | `task:${string}`;

export interface AgentMemory {
  text: string;
  at: string;
  /** A turn-end answer that was not written because it was over the limit: the next ask says so. */
  refused?: { at: string; chars: number };
  /**
   * The latest write by someone other than the task's own session, and when (2026-10-27: a
   * worker's lines written into its lead's file read, after a compaction, as the lead's own
   * notes). `by_name` is the writer as the user reads it, none for the user. The owner appends
   * at every turn end, so its appends keep the record; only the owner replacing the whole file
   * (it has then rewritten every line itself) clears it.
   */
  by?: AgentMemoryWriter;
  by_name?: string;
  by_at?: string;
}

export type AgentMemoryWriterStamp = { by: AgentMemoryWriter; by_name?: string };

/**
 * The writer record a write leaves. `stamp` is the writer when it is not the task's own session
 * (null for its own): another's write records itself with its time, the owner's append keeps the
 * record there, the owner's replace clears it.
 */
export function agentMemoryWriterAfter(
  current: AgentMemory | undefined, mode: 'replace' | 'append', stamp: AgentMemoryWriterStamp | null, nowIso: string,
): Pick<AgentMemory, 'by' | 'by_name' | 'by_at'> {
  if (stamp) return { by: stamp.by, ...(stamp.by_name ? { by_name: stamp.by_name } : {}), by_at: nowIso };
  if (mode === 'append' && current?.by) {
    return { by: current.by, ...(current.by_name ? { by_name: current.by_name } : {}), by_at: current.by_at ?? current.at };
  }
  return {};
}

const WRITER_NAME_MAX = 60;

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}\u2026` : s;
}

/** A writer task as the user reads it: "the CEO", "the Growth VP", `the task "..."`; at most 60 characters. */
export function agentMemoryWriterName(task: Pick<Task, 'title' | 'org_role' | 'org_name'> | undefined): string {
  if (!task) return 'an agent';
  const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
  if (task.org_role === 'main' || task.org_role === 'lead') return clip(`the ${flat(orgDisplayTitle(task))}`, WRITER_NAME_MAX);
  return `the task "${clip(flat(task.title), WRITER_NAME_MAX - 'the task ""'.length)}"`;
}

/** One line for whoever reads the file back when someone other than its own session wrote in it; '' otherwise. */
export function agentMemoryWriterNote(memory: Pick<AgentMemory, 'at' | 'by' | 'by_name' | 'by_at'> | null | undefined): string {
  if (!memory?.by) return '';
  const name = memory.by === 'human' ? 'the user' : memory.by_name?.trim() || 'an agent';
  return `Last written by ${name} at ${memory.by_at ?? memory.at}.`;
}

/** Past this the agent is asked, at every turn end, to compress it (about 3,000 tokens). */
export const AGENT_MEMORY_SOFT_CHARS = 12_000;
/** A write past this is refused whole (about 5,000 tokens): nothing is dropped behind its back. */
export const AGENT_MEMORY_MAX_CHARS = 20_000;
/** How much of it a compaction reads back; the rest is one agent_memory_read away. */
const AFTER_COMPACTION_CHARS = 6_000;

/** Main, every lead, and every task leading open subtasks keeps one; a plain worker uses its task note. */
export function keepsAgentMemory(task: Pick<Task, 'org_role'>, hasOpenSubtasks: boolean): boolean {
  return task.org_role === 'main' || task.org_role === 'lead' || hasOpenSubtasks;
}

export class AgentMemoryTooLongError extends Error {
  readonly code = 'agent_memory_too_long';
  constructor(readonly chars: number) {
    super(`This MEMORY.md would be ${chars} characters, over the ${AGENT_MEMORY_MAX_CHARS} limit. Nothing was written: rewrite it shorter (merge, drop what is done or no longer true) and write the whole file again.`);
  }
}

/** The text a write leaves: `replace` sets it, `append` adds a dated entry. Throws past the limit. */
export function nextAgentMemory(current: string, content: string, mode: 'replace' | 'append', nowIso: string): string {
  const body = content.trim();
  const text = mode === 'append'
    ? [current.trimEnd(), `- ${nowIso.slice(0, 10)}: ${body.replace(/^-\s*/, '')}`].filter(Boolean).join('\n')
    : body;
  if (text.length > AGENT_MEMORY_MAX_CHARS) throw new AgentMemoryTooLongError(text.length);
  return text;
}

// The field's label at a line start, bold or not ("AGENT_MEMORY:", "**AGENT_MEMORY:**", "**AGENT_MEMORY**:"),
// or alone on its line with no colon.
const LABEL_RE = /^[ \t]*(?:#+[ \t]*)?(?:\*\*)?AGENT_MEMORY(?:\*\*)?[ \t]*(?::(?:\*\*)?[ \t]*|(?=\r?\n|$))/gim;

/**
 * The report split at its LAST AGENT_MEMORY label: the field is everything after it, and the head
 * is what every other field is read from. The file is free text, so a line in it that looks like
 * another label ("STATUS: review pending", a bare "GOAL") must neither end it nor feed that field.
 */
export function splitAgentMemory(report: string): { head: string; field: string | null } {
  let last: RegExpExecArray | null = null;
  for (const m of report.matchAll(LABEL_RE)) last = m as RegExpExecArray;
  if (!last) return { head: report, field: null };
  return { head: report.slice(0, last.index).trimEnd(), field: report.slice(last.index + last[0].length).trim() };
}

export type AgentMemoryAsk = { mode: 'replace' | 'append'; content: string };

/**
 * What the field asks for: an entry to add (`append:`), the whole file (`replace:`), or nothing.
 * Only those two explicit forms write: "unchanged" in bold, in quotes or with a remark, or
 * anything unclear, keeps the file as it is (a stray answer must never overwrite it).
 */
export function readAgentMemoryField(field: string | null): AgentMemoryAsk | null {
  const t = (field ?? '').replace(/^<(?:one new entry|the whole file, rewritten)>\s*/i, '').trim();
  const m = t.match(/^[*_`"']*(append|replace)[*_`"']*[ \t]*:[*_`]*[ \t]*([\s\S]*)$/i);
  if (!m) return null;
  const content = m[2]!.replace(/^<(?:one new entry|the whole file, rewritten)>\s*/i, '').trim();
  if (!content) return null;
  return { mode: m[1]!.toLowerCase() as 'replace' | 'append', content };
}

/**
 * The memory a turn-end answer leaves, given the row as it is now and the `at` of the file the
 * ask showed. A rewrite of a file that changed since the ask (agent_memory_write meanwhile, or
 * another session) would erase that change, so it is skipped; an entry still goes on top.
 * Past the limit nothing is written and the refusal is kept for the next ask. null = no write.
 */
export function applyAgentMemoryAnswer(
  current: AgentMemory | undefined, ask: AgentMemoryAsk, shownAt: string | undefined, nowIso: string,
): { memory: AgentMemory; outcome: 'written' | 'refused' } | { memory: null; outcome: 'stale' } {
  if (ask.mode === 'replace' && (current?.at ?? undefined) !== shownAt) return { memory: null, outcome: 'stale' };
  try {
    // The owner's own answer: an entry keeps the record of another's write, a whole rewrite clears it.
    const text = nextAgentMemory(current?.text ?? '', ask.content, ask.mode, nowIso);
    return { memory: { text, at: nowIso, ...agentMemoryWriterAfter(current, ask.mode, null, nowIso) }, outcome: 'written' };
  } catch (err) {
    if (!(err instanceof AgentMemoryTooLongError)) throw err;
    // Nothing was written, so the last writer stays whoever it was.
    return { memory: { ...current, text: current?.text ?? '', at: current?.at ?? nowIso, refused: { at: nowIso, chars: err.chars } }, outcome: 'refused' };
  }
}

/** The turn-end ask's MEMORY.md section: the file as it stands, and the rule for what goes in. Always the LAST field. */
export function agentMemoryPrompt(memory: AgentMemory | undefined, taskTitle: string): string {
  const text = memory?.text.trim() ?? '';
  const size = text.length;
  const over = size > AGENT_MEMORY_SOFT_CHARS;
  const writer = agentMemoryWriterNote(memory);
  const refused = memory?.refused
    ? `\nYour last answer (${memory.refused.chars} characters) was NOT written: it is over the ${AGENT_MEMORY_MAX_CHARS}-character limit. Give it again, shorter.`
    : '';
  return `
Last, YOUR OWN MEMORY.md (the working memory of "${taskTitle.replace(/"/g, "'")}", for you only; the user does not read it, and it is not Walnut's global MEMORY.md): pending items, a deadline days away, reminders, things to raise later, facts you learned for this work. Anything that does not need the user now or change their picture of the work goes here, not into the Brief or the FOR_USER lines.
${text ? `<own_memory chars="${size}" limit="${AGENT_MEMORY_SOFT_CHARS}">\n${text}\n</own_memory>${writer ? `\n${writer}` : ''}` : 'It is empty.'}${over ? `\nIt is over its ${AGENT_MEMORY_SOFT_CHARS}-character size: answer with replace and the whole file rewritten shorter, keeping everything still valid (merge entries, drop what is done or no longer true).` : ''}
A file past ${AGENT_MEMORY_MAX_CHARS} characters is not written at all.${refused}
Answer with exactly one of: "AGENT_MEMORY: unchanged", "AGENT_MEMORY: append: <one new entry>", or "AGENT_MEMORY: replace:" followed by the whole file on the next lines. Write nothing after it.
AGENT_MEMORY:`;
}

/** After a compaction: the file read back (its head when long), so the summary cannot lose it. '' when empty. */
export function agentMemoryAfterCompaction(task: Pick<Task, 'title' | 'agent_memory'>): string {
  const text = task.agent_memory?.text.trim();
  if (!text) return '';
  const cut = cutEnd(text, AFTER_COMPACTION_CHARS);
  const shown = text.length > AFTER_COMPACTION_CHARS
    ? `${text.slice(0, cut)}\n… (${text.length - cut} more characters: agent_memory_read reads the whole file)`
    : text;
  const writer = agentMemoryWriterNote(task.agent_memory);
  return `Your own MEMORY.md (for "${task.title}", yours only, not Walnut's global MEMORY.md; agent_memory_write changes it):\n${writer ? `${writer}\n` : ''}${shown}`;
}
