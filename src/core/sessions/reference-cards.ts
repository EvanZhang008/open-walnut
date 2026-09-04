/**
 * Reference cards — the context block that rides a human message carrying entity
 * refs.
 *
 * The web composer lets the human drop a pill into what they type
 * (`<task-ref/>`, `<session-ref/>`, `<project-ref/>`). The pill's markup reaches
 * the CLI unchanged, but the markup alone is an opaque id: the model would have
 * to spend a tool call (task_get / session_send / project_list) just to learn
 * what the human pointed AT, and in practice it often answers without asking. So
 * the send path appends a compact card per referenced entity — one line each,
 * resolved from the local store, costing no round trip.
 *
 * Same three conventions as the output-mode wrapper (./output-mode.ts), for the
 * same reasons:
 *   · The block lands AFTER the user's text — the human's words stay first, and
 *     recency serves the model.
 *   · It is MACHINE text, so every display surface must strip it back out. The
 *     CLI echoes what it received into its JSONL, so without stripping, every
 *     bubble/notification/search snippet would show the card block as if the
 *     human had typed it.
 *   · Slash commands are exempt at the call site: the CLI only treats input as a
 *     command when the raw string startsWith('/'), and appending text lands it
 *     inside the command's argument string.
 *
 * Best-effort by construction: a card is a nicety, never a precondition for
 * delivery. Every loader failure degrades to "that card is missing" and
 * buildReferenceCards NEVER throws — a store hiccup must not be able to fail the
 * human's send.
 */

import { log } from '../../logging/index.js';
import { listEntityRefs } from '../../utils/entity-refs.js';
import { stripOutputModeWrappers } from './output-mode.js';

/** Block markers, each on its OWN line. Line-anchored like the output-mode
 *  markers so a human sentence quoting one survives the stripper. */
export const REFERENCE_CARDS_OPEN = '---walnut-refs---';
export const REFERENCE_CARDS_CLOSE = '---/walnut-refs---';

/** Longest a free-text field may run inside a card. Counted in CODE POINTS (not
 *  UTF-16 units) so a truncation can never split an emoji or a CJK surrogate
 *  pair into invalid halves. */
const FIELD_LIMIT = 240;

/** How many refs one message may resolve. A pill costs the human one click, so a
 *  pasted-in wall of them is possible; the cap keeps the block a card list rather
 *  than a second copy of the task store. */
const MAX_REFS = 8;

export interface TaskCard {
  id: string;
  title: string;
  phase: string;
  project: string;
  description?: string;
  sessionId?: string;
  sessionStatus?: string;
}

export interface SessionCard {
  id: string;
  title: string;
  status: string;
  taskId?: string;
  host?: string;
  lastActiveAt?: string;
}

export interface ProjectCard {
  name: string;
  counts: { todo: number; active: number; done: number };
  summary?: string;
}

/**
 * The store reads a card block needs. Injectable so the renderer can be tested
 * as pure logic (no DB, no config, no live session registry) and so a caller in
 * another process could resolve refs its own way.
 */
export interface ReferenceCardLoaders {
  loadTasks(ids: string[]): Promise<TaskCard[]>;
  loadSession(id: string): Promise<SessionCard | null>;
  /** Resolve every named project in ONE pass (names match case-insensitively);
   *  unknown names are simply absent from the result. */
  loadProjects(names: string[]): Promise<ProjectCard[]>;
}

/**
 * The real loaders, reading the same helpers the REST surfaces read so a card can
 * never disagree with what the UI shows.
 *
 * Every import is DYNAMIC on purpose: this module is pulled in by the display
 * projection (core/session-history.ts, core/echo-claims.ts), which sits below the
 * task/session/project layers. A static import would drag the whole store —
 * SQLite init included — into every history parse, and echo-claims documents
 * itself as sitting below session-history for exactly that reason.
 */
export const defaultReferenceCardLoaders: ReferenceCardLoaders = {
  async loadTasks(ids: string[]): Promise<TaskCard[]> {
    const { listTasksByIds } = await import('../task-manager.js');
    const tasks = await listTasksByIds(ids);
    return tasks.map((task) => ({
      id: task.id,
      title: task.title,
      phase: task.phase,
      // '' means Inbox — the renderer prints the word, the card keeps the raw value.
      project: task.project || '',
      // `summary` is the derived short text ("what the session did"); it is the
      // better one-liner when the human never wrote a description.
      ...(task.description || task.summary ? { description: task.description || task.summary } : {}),
      ...(task.session_id ? { sessionId: task.session_id } : {}),
      ...(task.session_status?.process_status ? { sessionStatus: task.session_status.process_status } : {}),
    }));
  },

  async loadSession(id: string): Promise<SessionCard | null> {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const record = await getSessionByClaudeId(id);
    if (!record) return null;
    return {
      id: record.claudeSessionId,
      title: record.title || '',
      status: record.process_status,
      ...(record.taskId ? { taskId: record.taskId } : {}),
      ...(record.host ? { host: record.host } : {}),
      ...(record.lastActiveAt ? { lastActiveAt: record.lastActiveAt } : {}),
    };
  },

  async loadProjects(names: string[]): Promise<ProjectCard[]> {
    // buildProjectsPayload owns the counts pass (its collectCounts is route-local
    // — deliberately NOT duplicated here), so the card reports exactly the numbers
    // GET /api/projects reports. It scans every task once, which is why all the
    // project refs of one message resolve from a single call.
    const { buildProjectsPayload } = await import('../../web/routes/projects.js');
    const payload = await buildProjectsPayload();
    const wanted = new Set(names.map((n) => n.trim().toLowerCase()));
    const out: ProjectCard[] = [];
    for (const row of payload.projects) {
      const name = String(row.name);
      if (!wanted.has(name.trim().toLowerCase())) continue;
      const counts = row.counts as ProjectCard['counts'];
      const metadata = row.metadata as { summary?: unknown } | undefined;
      const summary = typeof metadata?.summary === 'string' ? metadata.summary : undefined;
      out.push({
        name,
        counts: { todo: counts?.todo ?? 0, active: counts?.active ?? 0, done: counts?.done ?? 0 },
        ...(summary ? { summary } : {}),
      });
    }
    return out;
  },
};

/** Collapse whitespace and cut to FIELD_LIMIT code points, marking the cut. A
 *  card is one LINE per entity, so an embedded newline would break the shape. */
function condense(value: string | undefined, limit = FIELD_LIMIT): string {
  if (!value) return '';
  const flat = value.replace(/\s+/g, ' ').trim();
  const points = [...flat];
  return points.length <= limit ? flat : `${points.slice(0, limit).join('')}…`;
}

/** Join ` · `-separated segments, dropping the empty ones — an absent field
 *  disappears rather than showing as a dangling separator. */
function segments(...parts: Array<string | undefined>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p !== '').join(' · ');
}

/** `kind id "title"`, or just `kind id` when the entity has no title — an empty
 *  pair of quotes reads as a rendering bug rather than as missing data. */
function head(kind: string, id: string, title: string): string {
  return title.trim() ? `${kind} ${id} "${title.trim()}"` : `${kind} ${id}`;
}

function renderTaskCard(card: TaskCard): string {
  return `- ${segments(
    head('task', card.id, card.title),
    card.phase ? `phase ${card.phase}` : '',
    `project ${card.project || 'Inbox'}`,
    card.sessionId ? `session ${card.sessionId}${card.sessionStatus ? ` (${card.sessionStatus})` : ''}` : '',
    condense(card.description),
  )}`;
}

function renderSessionCard(card: SessionCard): string {
  return `- ${segments(
    head('session', card.id, card.title),
    card.status,
    card.taskId ? `task ${card.taskId}` : '',
    card.host ? `host ${card.host}` : '',
    card.lastActiveAt ? `last active ${card.lastActiveAt}` : '',
  )}`;
}

function renderProjectCard(card: ProjectCard): string {
  return `- ${segments(
    `project "${card.name}"`,
    `${card.counts.active} active`,
    `${card.counts.todo} todo`,
    `${card.counts.done} done`,
    condense(card.summary),
  )}`;
}

/**
 * Build the card block for one outgoing message, or '' when there is nothing to
 * say (no refs, or nothing resolved).
 *
 * Resolution is per-kind and best-effort: a loader that throws or returns null
 * costs exactly its own card. Never throws — the caller is a send path, and a
 * missing card is invisible while a failed send is not.
 */
export async function buildReferenceCards(
  text: string,
  loaders: ReferenceCardLoaders = defaultReferenceCardLoaders,
): Promise<string> {
  const refs = listEntityRefs(text);
  if (refs.length === 0) return '';

  // Dedupe by kind+id, first-seen order preserved: the same pill dropped twice is
  // one entity, and the human's ORDER is the only priority signal we have.
  const seen = new Set<string>();
  const wanted: typeof refs = [];
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.kind === 'project' ? ref.id.toLowerCase() : ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    wanted.push(ref);
    if (wanted.length >= MAX_REFS) break;
  }

  const taskIds = wanted.filter((r) => r.kind === 'task').map((r) => r.id);
  const projectNames = wanted.filter((r) => r.kind === 'project').map((r) => r.id);
  const lines: string[] = [];

  // Tasks and projects each resolve in ONE batched call, so a message with eight
  // pills of either kind still costs one query / one scan.
  let tasksById = new Map<string, TaskCard>();
  if (taskIds.length > 0) {
    try {
      tasksById = new Map((await loaders.loadTasks(taskIds)).map((card) => [card.id, card]));
    } catch (err) {
      log.session.debug('reference card task load failed — cards skipped', {
        taskIds, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  let projectsByName = new Map<string, ProjectCard>();
  if (projectNames.length > 0) {
    try {
      projectsByName = new Map((await loaders.loadProjects(projectNames)).map((card) => [card.name.trim().toLowerCase(), card]));
    } catch (err) {
      log.session.debug('reference card project load failed — cards skipped', {
        projectNames, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const ref of wanted) {
    if (ref.kind === 'task') {
      const card = tasksById.get(ref.id);
      if (card) lines.push(renderTaskCard(card));
      else log.session.debug('reference card task unresolved', { taskId: ref.id });
      continue;
    }
    if (ref.kind === 'session') {
      try {
        const card = await loaders.loadSession(ref.id);
        if (card) lines.push(renderSessionCard(card));
        else log.session.debug('reference card session unresolved', { sessionId: ref.id });
      } catch (err) {
        log.session.debug('reference card session load failed — card skipped', {
          sessionId: ref.id, error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }
    const card = projectsByName.get(ref.id.trim().toLowerCase());
    if (card) lines.push(renderProjectCard(card));
    else log.session.debug('reference card project unresolved', { project: ref.id });
  }

  if (lines.length === 0) return '';
  return [
    REFERENCE_CARDS_OPEN,
    // Naming the tools is what keeps the block SHORT: it is a summary, and the
    // model needs to know where the rest lives.
    'Referenced by the user (Walnut context; use task_get / session_send / project_list for more):',
    ...lines,
    REFERENCE_CARDS_CLOSE,
  ].join('\n');
}

/** Append a card block to the text the CLI will receive. A blank line separates
 *  the human's words from the machine text; '' leaves the text untouched. */
export function appendReferenceCards(text: string, cards: string): string {
  return cards ? `${text}\n\n${cards}` : text;
}

/** Is this whole LINE one of our markers? Line-anchored for the same reason the
 *  output-mode stripper is: a human sentence merely MENTIONING the marker does
 *  not start with it, so it survives. */
function isOpenMarker(line: string): boolean {
  return line.trim() === REFERENCE_CARDS_OPEN;
}

function isCloseMarker(line: string): boolean {
  return line.trim() === REFERENCE_CARDS_CLOSE;
}

/**
 * Undo the append for DISPLAY. Every block, from an OPEN marker line through its
 * matching CLOSE line inclusive, plus the ONE blank line we wrote next to it
 * (preferring the one BEFORE, so two of the user's own paragraphs never fuse).
 *
 * A block with no CLOSE marker strips to the end of the text: the only way to
 * see one is a truncated/interrupted delivery, and half a card block is machine
 * text too.
 */
export function stripReferenceCards(text: string): string {
  // Fast path: this runs per user message of every history parse (a whale JSONL
  // has thousands), and the overwhelming majority carry no refs at all.
  if (!text.includes(REFERENCE_CARDS_OPEN) && !text.includes(REFERENCE_CARDS_CLOSE)) {
    return text;
  }

  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isOpenMarker(lines[i])) {
      out.push(lines[i]);
      continue;
    }
    // Swallow through the matching close marker (or to the end when absent).
    let j = i + 1;
    while (j < lines.length && !isCloseMarker(lines[j])) j++;
    i = j; // the close line itself (or one past the end) is consumed
    if (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
    else if (lines[i + 1]?.trim() === '') i++;
  }
  const stripped = out.join('\n').trim();
  // Never strip a message down to NOTHING: our block always accompanies the
  // user's own words, so an "all block" message is someone quoting the literal
  // markers at us — showing it is right, deleting their message is not.
  return stripped === '' ? text : stripped;
}

/**
 * THE projection of a delivered user line to what every display surface shows.
 *
 * A user message can carry BOTH machine wrappers (the output-mode instruction or
 * reminder, and a reference-card block), and the CLI echoes all of it into its
 * JSONL. Surfaces built from a history parse — web bubbles, the phone, the
 * notification feed, search snippets, auto-titles — must show only what the human
 * typed, so they go through this one function rather than each remembering which
 * strippers exist.
 */
export function toDisplayedUserText(text: string): string {
  return stripReferenceCards(stripOutputModeWrappers(text));
}
