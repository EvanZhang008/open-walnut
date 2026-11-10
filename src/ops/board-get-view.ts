/**
 * What `board_get` (src/ops/boards.ts) answers: the whole board when it is
 * small, a summary when it is not, or only the parts the caller names.
 *
 * Why (2026-11-10): a team board with 269 kanban cards, 40 projects and their
 * task states answered 165,884 characters, more than an agent's tool result
 * takes, so the agent could not read even its section count. The kanban fields
 * and the projects were the bulk, not the html. Pure functions, no I/O.
 */
import { threadMeta } from '../core/boards/board-html.js';

/** One read answers at most this many characters of JSON before it becomes a summary. */
export const BOARD_GET_BUDGET = 30_000;

/** Part name → the keys of GET /tasks/:id/board it returns. */
export const BOARD_PARTS = {
  html: ['board'],
  threads: ['threads'],
  marks: ['marks'],
  projects: ['projects'],
  checks: ['checks'],
  choices: ['choices'],
  reminders: ['reminders'],
  section_seen: ['section_seen', 'section_seen_agent'],
  tasks: ['refs'],
  refs: ['refs'],
  lanes: ['lanes', 'lanes_effective', 'lanes_template'],
  cards: ['cards'],
  team: ['team'],
  kanban_seen: ['kanban_seen', 'kanban_seen_agent'],
  kanban: ['lanes', 'lanes_effective', 'lanes_template', 'cards', 'team', 'kanban_seen', 'kanban_seen_agent'],
  all: [] as string[],
} as const satisfies Record<string, readonly string[]>;

export type BoardPart = keyof typeof BOARD_PARTS;
export const BOARD_PART_NAMES = Object.keys(BOARD_PARTS) as [BoardPart, ...BoardPart[]];
/** The parts a summary names, each once (aliases and groups left out). */
const LISTED_PARTS: BoardPart[] = ['html', 'threads', 'marks', 'projects', 'checks', 'choices', 'reminders',
  'section_seen', 'tasks', 'lanes', 'cards', 'team', 'kanban_seen'];

/** Keys every answer keeps, whatever parts it names. */
const ALWAYS = ['task_id', 'board_task_id', 'board_task_title', 'board_version'];

type Body = Record<string, unknown>;
interface Msg { id?: string; author?: string; text?: string; ts?: string }

const len = (v: unknown) => (v === undefined ? 0 : JSON.stringify(v).length);
const clip = (s: unknown, n: number) => {
  const t = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const map = (v: unknown): Record<string, Record<string, unknown>> =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, Record<string, unknown>> : {};

/** `parts` (and `thread` / `since`, which narrow `threads`) → the answer, or null for the default read. */
export function selectParts(full: Body, parts: BoardPart[] | undefined, thread?: string, since?: string): Body | null {
  const narrowed = !!thread || !!since;
  if (!parts?.length && !narrowed) return null;
  const want = parts?.length ? parts : ['threads' as BoardPart];
  if (want.includes('all')) return { ...full, ...(narrowed ? { threads: narrowThreads(full.threads, thread, since) } : {}) };
  const keys = new Set([...ALWAYS, ...want.flatMap((p) => BOARD_PARTS[p])]);
  const out: Body = {};
  for (const k of keys) if (full[k] !== undefined) out[k] = full[k];
  if (narrowed && keys.has('threads')) out.threads = narrowThreads(full.threads, thread, since);
  return out;
}

function narrowThreads(threads: unknown, thread?: string, since?: string): Record<string, Msg[]> {
  const sinceMs = since ? Date.parse(since) : NaN;
  const out: Record<string, Msg[]> = {};
  for (const [id, msgs] of Object.entries(threads && typeof threads === 'object' ? threads as Record<string, Msg[]> : {})) {
    if (thread && id !== thread) continue;
    const kept = Number.isNaN(sinceMs) ? msgs : msgs.filter((m) => Date.parse(m.ts ?? '') > sinceMs);
    if (!thread && !kept.length) continue;
    out[id] = kept;
  }
  return out;
}

/** JSON size of each part of the full answer, so the caller knows what a part costs. */
export function partSizes(full: Body): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of LISTED_PARTS) {
    const n = BOARD_PARTS[p].reduce((sum, k) => sum + len(full[k]), 0);
    if (n) out[p] = n;
  }
  return out;
}

function headings(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)) {
    const text = clip(m[2].replace(/<[^>]*>/g, ' '), 80);
    if (text) out.push(`${'#'.repeat(Number(m[1]))} ${text}`);
  }
  return out;
}

/** A list cut to `cap` items, with how many were left out. */
function listed<T>(items: T[], cap: number): { list: T[]; more?: number } {
  return items.length > cap ? { list: items.slice(0, cap), more: items.length - cap } : { list: items };
}

function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of items) { const k = key(t); out[k] = (out[k] ?? 0) + 1; }
  return out;
}

/** One row per thread, newest first: built once per read (each title is a scan of the html). */
function threadRowsOf(full: Body) {
  const board = map(full.board);
  const html = typeof board.html === 'string' ? board.html : '';
  const threads = Object.entries(full.threads && typeof full.threads === 'object' ? full.threads as Record<string, Msg[]> : {});
  const lastOf = (msgs: Msg[]) => msgs[msgs.length - 1];
  return threads
    .map(([id, msgs]) => {
      const last = lastOf(msgs);
      const title = html ? threadMeta(html, id)?.title : undefined;
      return {
        id, ...(title ? { title: clip(title, 80) } : {}), messages: msgs.length,
        ...(last ? { last_at: last.ts, last_author: last.author, last_text: clip(last.text, 200) } : {}),
      };
    })
    .sort((a, b) => String(b.last_at ?? '').localeCompare(String(a.last_at ?? '')));
}

/** Each part in counts and short lists, every list at most `cap` long. */
function summaryAt(full: Body, cap: number, dueIds: string[], threadRows: ReturnType<typeof threadRowsOf>) {
  const board = map(full.board);
  const html = typeof board.html === 'string' ? board.html : '';
  const threads = Object.entries(full.threads && typeof full.threads === 'object' ? full.threads as Record<string, Msg[]> : {});
  const projects = Object.entries(map(full.projects));
  const marks = Object.entries(map(full.marks));
  const checks = Object.values(map(full.checks));
  const choices = Object.entries(map(full.choices));
  const reminders = Object.entries(map(full.reminders));
  const refs = Array.isArray(full.refs) ? full.refs as Array<Record<string, unknown>> : [];
  const team = Array.isArray(full.team) ? full.team as Array<{ id?: string; phase?: string }> : [];
  const cards = map(full.cards);
  const sections = headings(html);
  return {
    page: {
      version: board.version ?? full.board_version ?? 0, html_chars: html.length,
      ...(board.updated_at ? { updated_at: board.updated_at, updated_by: board.updated_by } : {}),
      project_sections: (html.match(/\bdata-project\s*=/gi) ?? []).length,
      sections: sections.slice(0, cap * 2),
      ...(sections.length > cap * 2 ? { sections_more: sections.length - cap * 2 } : {}),
    },
    projects: {
      count: projects.length,
      by_status: countBy(projects, ([, p]) => String(p.status || 'none')),
      ...listed(projects.map(([id, p]) => ({
        id, title: clip(p.title, 80), status: p.status || '', ...(p.status_by === 'human' ? { status_by: 'human' } : {}),
        tasks: Array.isArray(p.tasks) ? p.tasks.length : 0,
      })), cap),
    },
    threads: {
      count: threads.length,
      messages: threads.reduce((n, [, m]) => n + m.length, 0),
      from_user: threads.reduce((n, [, m]) => n + m.filter((x) => x.author === 'user').length, 0),
      ...listed(threadRows, cap),
    },
    marks: { count: marks.length, ...listed(marks.map(([id, m]) => ({ id, state: m.state, note: clip(m.note, 200) })), cap) },
    checks: { count: checks.length, read: checks.filter((c) => c.read).length, changed: checks.filter((c) => c.changed).length },
    choices: {
      count: choices.length,
      ...listed(choices.map(([id, c]) => ({ id, option: c.option, label: c.label, text: clip(c.text, 120) })), cap),
    },
    reminders: {
      count: reminders.length, due: dueIds,
      ...listed(reminders.map(([id, r]) => ({ id, at: r.at, ...(r.fired_at ? { fired_at: r.fired_at } : {}) })), cap),
    },
    tasks: { count: refs.length, by_state: countBy(refs, (r) => String(r.user ?? r.phase ?? 'unknown')) },
    kanban: {
      team: team.length,
      open: team.filter((t) => t.phase !== 'COMPLETE').length,
      cards: Object.keys(cards).length,
      lanes: Array.isArray(full.lanes_effective)
        ? (full.lanes_effective as Array<{ id?: string; name?: string }>).map((l) => ({ id: l.id, name: l.name }))
        : [],
    },
  };
}

/**
 * The default read: `full` itself when it fits the budget, else a summary that
 * fits it (lists shortened until it does), with each left-out part's size.
 */
export function defaultView(full: Body, dueIds: string[]): { body: Body; fullChars: number; summarized: boolean } {
  const fullChars = len(full);
  if (fullChars <= BOARD_GET_BUDGET) return { body: full, fullChars, summarized: false };
  const head: Body = {};
  for (const k of ALWAYS) if (full[k] !== undefined) head[k] = full[k];
  const sizes = partSizes(full);
  const rows = threadRowsOf(full);
  let body: Body = {};
  // Room for outcome/next beside the body.
  for (const cap of [40, 20, 10, 5, 0]) {
    body = { ...head, summarized: true, full_chars: fullChars, part_chars: sizes, summary: summaryAt(full, cap, dueIds, rows) };
    if (len(body) <= BOARD_GET_BUDGET - 2_000) break;
  }
  return { body, fullChars, summarized: true };
}
