/**
 * The Brief is a Markdown document Main or a lead edits itself, any time (2026-10-31, the user:
 * "不能说是静下来四分钟再重写，任何东西都可以 trigger 一个重写 ... 这就是一个 file 嘛，它直接 update 这个
 * file 就可以了 ... brief 把弄的简单一点"). Its session writes it whole or by exact-string edits
 * (ops brief_read / brief_write, PUT /api/v1/tasks/:id/brief), from any host; Walnut reminds it to
 * every few messages and when its team moved since (message hint `brief`, hints/hint-registry.ts).
 *
 * Every write is shaped the same way: refs completed to whole ids, the three sections kept, each
 * line under its task's live section, a finished task's line gone and every task asking the user
 * in Needs you (brief-structure.ts `live`); the rule check is answered to the writer (issues), and
 * the marks of what each named task's status was are stored beside it (brief-fresh.ts).
 */
import type { Task } from '../types.js';
import { BRIEF_MAX_CHARS, type TaskBrief } from '../user-status.js';
import { briefSnapshot } from './brief-fresh.js';
import { briefLangOf, briefOwnChars, briefWalnutLines, structureBrief, type BriefLang } from './brief-structure.js';
import { briefIssues, completeBriefRefs, type BriefIssue } from './brief-rules.js';
import { briefSourcesOf, sourcesAfterInsertions, sourcesAfterRewrite, spliceBriefEdit, UNKNOWN_WRITER, type BriefTextSource, type BriefWriter } from './brief-source.js';
import { wholeHtmlSource } from '../boards/board-html-source.js';

export class BriefWriteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra?: Record<string, unknown>) {
    super(message);
  }
}

export interface BriefEdit { old: string; new: string }

/** Apply exact-string edits in order, each `old` once (as the Board's edits); `onApply` hears where each one landed, with the whole text before it. */
export function applyBriefEdits(text: string, edits: readonly BriefEdit[], onApply?: (at: number, edit: BriefEdit, before: string) => void): string {
  if (!edits.length) throw new BriefWriteError(400, 'bad_request', '`edits` must be a non-empty array of { old, new }');
  let out = text;
  edits.forEach((e, index) => {
    if (!e || typeof e.old !== 'string' || typeof e.new !== 'string' || !e.old) {
      throw new BriefWriteError(400, 'bad_request', `edits[${index}] must be { old: non-empty string, new: string }`);
    }
    const first = out.indexOf(e.old);
    if (first === -1) throw new BriefWriteError(409, 'brief_edit_not_found', `edits[${index}].old does not occur in the Brief: read it again (brief_read)`, { index });
    if (out.indexOf(e.old, first + 1) !== -1) throw new BriefWriteError(409, 'brief_edit_not_unique', `edits[${index}].old occurs more than once in the Brief`, { index });
    onApply?.(first, e, out);
    out = out.slice(0, first) + e.new + out.slice(first + e.old.length);
  });
  return out;
}

/** A letter in its stored shape, against the live tasks. Pure. `prior`: the lines Walnut wrote into
 *  the letter it replaces (briefWalnutLines); those still in it word for word stay Walnut's.
 *  `walnut`: the ones that letter records (TaskBrief.added), which Walnut may write again. */
export function shapeBriefText(
  text: string, owner: Task, tasks: readonly Task[],
  opts: { language?: string; lang?: BriefLang; nowIso?: string; prior?: readonly string[]; walnut?: readonly string[]; sources?: readonly BriefTextSource[] } = {},
): { brief: TaskBrief; issues: BriefIssue[] } {
  const full = completeBriefRefs({ text }, tasks).text;
  // Completing a ref only lengthens its id: the words keep their writers.
  const sources = opts.sources
    ? (full === text ? opts.sources : sourcesAfterInsertions(text, full, opts.sources) ?? wholeHtmlSource(full.length, UNKNOWN_WRITER.by))
    : undefined;
  // Walnut's lines are written again from the live state, in the Brief's language (brief-structure.ts).
  const lang = opts.lang ?? briefLangOf(opts.language, full);
  const shaped = structureBrief(full, owner.id, tasks, {
    ...(opts.language ? { language: opts.language } : {}), lang, live: owner, ...(opts.walnut?.length ? { walnut: opts.walnut } : {}), ...(sources ? { sources } : {}),
  });
  const issues = briefIssues(shaped.text, owner, tasks);
  const at = opts.nowIso ?? new Date().toISOString();
  const added = walnutLinesKept(shaped.text, shaped.walnutLines ?? [], opts.prior ?? []);
  return {
    brief: {
      text: shaped.text, at, ...briefSnapshot(shaped.text, owner, tasks), ...(issues.length ? { issues } : {}), added, lang,
      ...(shaped.text_sources ? { text_sources: shaped.text_sources } : {}),
    },
    issues,
  };
}

/** The lines of a stored letter that are Walnut's: the ones it just wrote, and the ones it wrote
 *  before that are still there word for word, each as often as the letter holds it. */
function walnutLinesKept(text: string, written: readonly string[], prior: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const l of text.split('\n')) left.set(l.trim(), (left.get(l.trim()) ?? 0) + 1);
  const out: string[] = [];
  for (const l of [...written, ...prior]) {
    const k = left.get(l.trim());
    if (!k) continue;
    left.set(l.trim(), k - 1);
    out.push(l.trim());
  }
  return out;
}

/**
 * Write a node's Brief (whole `content`, or `edits` on the stored one). Main or a lead only.
 * `writer` is who the caller is, as the route knows it from the request (never from its body);
 * without one the words are an unknown writer's, never guessed as a person's.
 */
export async function writeNodeBrief(
  taskId: string, input: { content?: string; edits?: readonly BriefEdit[]; language?: string }, writer: BriefWriter = UNKNOWN_WRITER,
): Promise<{ task: Task; brief: TaskBrief; issues: BriefIssue[] }> {
  const { getTask, listTasks, updateTaskRaw } = await import('../task-manager.js');
  const task = await getTask(taskId);
  if (task.org_role !== 'main' && task.org_role !== 'lead') {
    throw new BriefWriteError(409, 'not_org_node', `"${task.title}" is not Main or a lead: only they keep a Brief.`);
  }
  if (task.phase === 'COMPLETE') throw new BriefWriteError(409, 'task_complete', `"${task.title}" is complete: its Brief is kept as it was.`);
  if (input.content === undefined && !input.edits) throw new BriefWriteError(400, 'bad_request', 'content (string) or edits ([{ old, new }]) is required');
  // Checked first against the stored letter, and again under the row lock against the letter as it
  // is then: two writers' edits compose, and a stale edit is refused, never written over the other.
  const textOf = (base: string, onApply?: (at: number, edit: BriefEdit, before: string) => void): string => {
    const text = input.content !== undefined ? input.content : applyBriefEdits(base, input.edits!, onApply);
    if (!text.trim()) throw new BriefWriteError(400, 'bad_request', 'The Brief cannot be empty: write its three sections');
    return text;
  };
  // Only the writer's own lines are held to the limit, measured on the letter as it is stored
  // (briefOwnChars): the lines Walnut adds (asks the letter did not name, can-close lines, the
  // count past the cap, headings, "None") may take it past BRIEF_MAX_CHARS, and an edit that does
  // not grow the writer's share still goes through (2026-11-06, Main: a stored letter over the
  // limit refused every later edit, and it rewrote the whole letter four times in a day).
  const checkOwn = (shaped: TaskBrief, base: string, prior: readonly string[]): void => {
    const own = briefOwnChars(shaped.text, shaped.added);
    if (own > BRIEF_MAX_CHARS && (input.content !== undefined || own > briefOwnChars(base, prior))) {
      throw new BriefWriteError(413, 'brief_too_long', `Your own lines in the Brief come to ${own} characters, over ${BRIEF_MAX_CHARS} (the lines Walnut adds, the headings and "None" lines are not counted): keep it to what matters now (at most 15 lines of work).`, { chars: shaped.text.length, own_chars: own, limit: BRIEF_MAX_CHARS });
    }
  };
  const first = textOf(task.brief?.text ?? '');
  // Walnut's own lines follow the user's reply language when it is one Walnut writes; else the
  // letter's own (briefLangOf).
  const { walnutLetterLanguage } = await import('../human-inbox/walnut-letters/languages.js');
  const letterLang = await walnutLetterLanguage();
  const lang: BriefLang = letterLang === 'zh' ? 'zh' : briefLangOf(input.language, first);
  // Every status it names is derived now (user-status-sync.ts debounces 1.5 s): a phase set right
  // before the write would otherwise be stored as its old mark and read as a move a moment later.
  let tasks = await listTasks();
  const { briefAskScope } = await import('./brief-structure.js');
  const { syncUserStatuses } = await import('../user-status-sync.js');
  const scope = new Set([...briefAskScope(task, tasks).map((t) => t.id), ...[...first.matchAll(/<task-ref\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]!)]);
  if (await syncUserStatuses(scope).catch(() => 0)) tasks = await listTasks();
  let complete = false;
  let failure: unknown;
  let out: { brief: TaskBrief; issues: BriefIssue[] } | null = null;
  await updateTaskRaw(task.id, (current) => {
    try {
      const base = current.brief?.text ?? '';
      const prior = briefWalnutLines(current.brief, current, tasks);
      // A write, whole or by edits, makes only what it changed the writer's.
      let sources: BriefTextSource[] = briefSourcesOf(current.brief);
      let sourceMs = 0;
      const text = textOf(base, (at, e, before) => {
        if (e.old === e.new || sourceMs >= 25) return;
        const started = performance.now();
        sources = spliceBriefEdit(sources, at, e.old, e.new, writer, before);
        sourceMs += performance.now() - started;
      });
      if (sourceMs >= 25) sources = wholeHtmlSource(text.length, UNKNOWN_WRITER.by);
      // A whole letter keeps every unchanged character's stored writer (the same words sent again too).
      if (input.content !== undefined) sources = sourcesAfterRewrite(base, text, sources, writer);
      out = shapeBriefText(text, current, tasks, { ...(input.language ? { language: input.language } : {}), lang, prior, ...(current.brief?.added ? { walnut: current.brief.added } : {}), sources });
      checkOwn(out.brief, base, prior);
      return { brief: out.brief };
    } catch (err) {
      failure = err;
      return null;
    }
  }, {
    emitEvent: true, source: 'brief-write',
    shouldUpdate: (current) => { complete = current.phase === 'COMPLETE'; return !complete; },
  });
  if (complete) throw new BriefWriteError(409, 'task_complete', `"${task.title}" is complete: its Brief is kept as it was.`);
  if (failure) throw failure;
  if (!out) throw new BriefWriteError(409, 'brief_not_written', 'The Brief was not written: read it again (brief_read) and retry');
  const { brief, issues } = out as { brief: TaskBrief; issues: BriefIssue[] };
  return { task, brief, issues };
}
