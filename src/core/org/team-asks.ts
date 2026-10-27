/**
 * Asks that go into a lead's team from outside it, kept for the lead's next team note
 * (team-note.ts). 2026-10-26: the main agent sent a project's worker a new request directly and
 * the project's lead never knew. A VP should know every new request into its teams: the user's
 * own message in a team task, the main agent's, another team's.
 *
 *   recorded   a message from a person (PERSON_SEND_SOURCES) or a peer note from a task outside
 *              the team, into a team task's session; never one from the lead or its own team
 *              (that is the team working), never a reply, never Walnut's own notices
 *   told       the lead's next team note lists them; then they are cleared
 *
 * One row per ask, not per message (2026-10-27, the org's reflection: one lead's note listed
 * "[Question Q12]" / "[Question Q13]" six times for one task, and the lead had to read the task to
 * learn what was asked). A person's message is read without what Walnut or the composer put
 * around it (askWords); a message in one of the task's questions is told as that question's own
 * words, and every later message of the same question, or of the person's chat with the task, is
 * counted on the row already pending (askKey).
 *
 * WALNUT_HOME/org/team-asks.json, at most MAX_PER_LEAD per lead (the newest).
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';
import { splitLeadingBanners } from '../../lib/history-injected-banner.js';
import { withoutLeadingRiders } from '../../lib/history-walnut-riders.js';
import { buildOrgTree, type OrgTaskNode } from './org-tree.js';
import type { TeamAsk } from './team-note.js';

const FILE = path.join(WALNUT_HOME, 'org', 'team-asks.json');
const MAX_PER_LEAD = 20;
const GIST_MAX = 200;

async function readAll(): Promise<Record<string, TeamAsk[]>> {
  try {
    const all = JSON.parse(await fs.readFile(FILE, 'utf8')) as Record<string, TeamAsk[]>;
    return all && typeof all === 'object' ? all : {};
  } catch {
    return {};
  }
}

let writing: Promise<unknown> = Promise.resolve();
function update(fn: (all: Record<string, TeamAsk[]>) => void): Promise<void> {
  const run = writing.then(async () => {
    const all = await readAll();
    fn(all);
    for (const k of Object.keys(all)) if (!all[k]?.length) delete all[k];
    const { writeFileAtomic } = await import('../config-manager.js');
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await writeFileAtomic(FILE, JSON.stringify(all, null, 2));
  });
  writing = run.catch(() => undefined);
  return run;
}

export async function pendingTeamAsks(leadId: string): Promise<TeamAsk[]> {
  const list = (await readAll())[leadId];
  return Array.isArray(list) ? list : [];
}

/**
 * Clear the asks a note told: each row as many messages as the note counted on it. A message
 * counted on a row after the note was built stays, as that row's news for the next note, told by
 * its own words.
 */
export function clearTeamAsks(leadId: string, told: readonly { id: string; count: number }[]): Promise<void> {
  const counts = new Map(told.map((t) => [t.id, t.count] as const));
  return update((all) => {
    all[leadId] = (all[leadId] ?? []).flatMap((a) => {
      const shown = counts.get(a.id);
      if (shown === undefined) return [a];
      const left = (a.count ?? 1) - shown;
      if (left <= 0) return [];
      const { latest, ...rest } = a;
      return [{ ...rest, count: left, ...(latest && !a.question ? { gist: latest } : {}) }];
    });
  });
}

const ATTR = (name: string) => new RegExp(`\\b${name}="([^"]*)"`);
const ENTITIES: Record<string, string> = { '&quot;': '"', '&#39;': "'", '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };
/** An attribute value as written (the envelope escapes it). */
const unescapeAttr = (v: string) => v.replace(/&(?:quot|#39|apos|lt|gt|amp);/g, (e) => ENTITIES[e] ?? e);

/** A peer note's sender and title, from its envelope; null for anything else (a reply, a notice). */
export function peerNoteSender(enqueued: string): { taskId: string; from: string; title: string } | null {
  const open = /^\s*<walnut-message\b[^>]*>/.exec(enqueued)?.[0];
  if (!open || !/\bkind="peer-note"/.test(open)) return null;
  const attr = (name: string) => unescapeAttr(ATTR(name).exec(open)?.[1] ?? '');
  const taskId = attr('from-task');
  // "Main [3ea08ceb]": the handle without its short id.
  const from = attr('from').replace(/\s*\[[0-9a-f]{6,}\]\s*$/i, '').trim();
  return { taskId, from: from || 'another task', title: attr('title').trim() };
}

function walk(nodes: readonly OrgTaskNode[], out: string[] = []): string[] {
  for (const n of nodes) { out.push(n.id); walk(n.workers, out); }
  return out;
}

/** The lead whose team holds `task`, and the ids of that team (the lead included); null when none. */
export function teamOf(tasks: readonly Task[], task: Task): { lead: Task; team: Set<string> } | null {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const tree = buildOrgTree(tasks);
  for (const p of tree.projects) {
    if (!p.lead) continue;
    const ids = walk(p.teams);
    if (!ids.includes(task.id)) continue;
    const lead = byId.get(p.lead.id);
    if (!lead || lead.phase === 'COMPLETE') return null;
    const team = new Set(ids);
    // Every project this lead leads is its team.
    for (const q of tree.projects) if (q.lead?.id === lead.id) for (const id of walk(q.teams)) team.add(id);
    team.add(lead.id);
    return { lead, team };
  }
  const parent = task.parent_task_id ? byId.get(task.parent_task_id) : undefined;
  if (parent?.org_role === 'lead' && parent.phase !== 'COMPLETE') return { lead: parent, team: new Set([parent.id, task.id]) };
  return null;
}

const clip = (line: string) => (line.length > GIST_MAX ? `${line.slice(0, GIST_MAX - 1)}…` : line);
const firstLine = (text: string | undefined) => (text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';

/** A question's banner (`[Question Q4]`, web/src/utils/question-tag.ts) and its number. */
const QUESTION_BANNER = /^Question Q(\d{1,5})$/;
/** What an old row kept of a question's message: the banner's first line. */
const QUESTION_PLACEHOLDER = /^\[Question Q(\d{1,5})\]$/;
/** Lines the composer puts before the words (web/src/utils/thread-tree.ts): where the message goes
 *  back to, and the file it is about; then the passage, as a quote block. */
const FRAME_LINE = /^(?:\(Back to the (?:main conversation|earlier (?:question|thread) about .*)\)|About `[^`\n]+`:)$/;
/** A line of the composer's quote block (quoteBlockOf: "> " before each line, ">" alone for a blank). */
const QUOTE_LINE = /^>(?: |$)/;

/**
 * What a message says, in one line, without what Walnut or the composer put around it: Walnut's
 * notes riding in front, its `[Name]…[/Name]` blocks (a question's banner among them, whose number
 * comes back as `question`), and the composer's framing lines. A message that is only a quoted
 * passage says that passage.
 */
export function askWords(text: string): { words: string; question?: number } {
  const own = withoutLeadingRiders(text);
  const split = splitLeadingBanners(own);
  const seq = split?.banners.map((b) => QUESTION_BANNER.exec(b.name.trim())?.[1]).find(Boolean);
  const lines = (split ? split.body : own).replace(/<[^>]+>/g, ' ').split('\n').map((l) => l.trim()).filter(Boolean);
  // Only what leads the message is framing; the same shapes further down are the person's words.
  let i = 0;
  while (i < lines.length && FRAME_LINE.test(lines[i]!)) i++;
  const quote: string[] = [];
  while (i < lines.length && QUOTE_LINE.test(lines[i]!)) quote.push(lines[i++]!.slice(1).trim());
  const said = lines[i] ?? quote.find(Boolean) ?? '';
  return { words: clip(said), ...(seq ? { question: Number(seq) } : {}) };
}

/** An ask as a row reads it. A row an older Walnut wrote (no `by`) kept the first line as it came:
 *  a question's placeholder line becomes its number with no words, a framing line no words. */
export function readAsk(a: TeamAsk): TeamAsk {
  if (a.by) return a;
  const placeholder = QUESTION_PLACEHOLDER.exec(a.gist.trim());
  if (placeholder) return { ...a, gist: '', question: a.question ?? Number(placeholder[1]) };
  if (FRAME_LINE.test(a.gist.trim())) return { ...a, gist: '' };
  return a;
}

const byUser = (a: TeamAsk) => (a.by ? a.by === 'user' : a.from === 'the user');
const norm = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** Asks that are one: the same task, the same sender, and the same question (numbered per
 *  session); a person's other messages to the task are one chat; a peer's notes are one ask per subject. */
export function askKey(a: TeamAsk): string {
  const r = readAsk(a);
  const what = r.question ? `q${r.sessionId ?? ''}:${r.question}` : byUser(r) ? 'chat' : `n:${norm(r.gist)}`;
  return `${r.taskId}|${byUser(r) ? 'user' : `peer:${r.from}`}|${what}`;
}

/**
 * Record a message into `sessionId` when it is an ask into a lead's team from outside the team.
 * `message` is what was said, `enqueued` the row as queued (a peer note's envelope), `messageId`
 * its queue row (a resend with the same id is the same ask). Never throws.
 */
export async function noteTeamAsk(
  sessionId: string, message: string, enqueued: string, source: string | undefined, messageId?: string,
): Promise<void> {
  try {
    const { PERSON_SEND_SOURCES } = await import('../session-message-queue.js');
    const person = PERSON_SEND_SOURCES.has(source ?? '');
    const peer = source === 'peer' ? peerNoteSender(enqueued) : null;
    if (!person && !peer) return;
    // The leader keeps the notes (pendingOrgDigest's rule): a replica's file nobody reads.
    const { role } = await import('../server-role.js');
    if (role() !== 'leader') return;
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const record = await getSessionByClaudeId(sessionId);
    const taskId = record?.taskId;
    if (!taskId) return;
    const { listTasks } = await import('../task-manager.js');
    const tasks = await listTasks();
    const task = tasks.find((t) => t.id === taskId);
    // A plugin's own task (Task.plugin_only) is no team's work: what the user says there stays there.
    if (!task || task.org_role === 'lead' || task.org_role === 'main' || task.plugin_only || task.phase === 'COMPLETE') return;
    // Every person's and peer's send passes here: no open lead, no team.
    if (!tasks.some((t) => t.org_role === 'lead' && t.phase !== 'COMPLETE')) return;
    const owner = teamOf(tasks, task);
    if (!owner) return;
    if (peer && (!peer.taskId || owner.team.has(peer.taskId))) return; // the team working, or no sender to name
    const said = askWords(peer?.title || message);
    // A question is told in its own words, as its thread keeps them; a follow-up's are not the question.
    const meta = said.question ? record?.threadMeta?.find((m) => m.seq === said.question) : undefined;
    const questionWords = clip(firstLine(meta?.question) || firstLine(meta?.title));
    const gist = questionWords || said.words;
    if (!gist && !said.question) return;
    const at = new Date().toISOString();
    const ask: TeamAsk = {
      id: randomUUID(), taskId: task.id, title: task.title, from: peer ? peer.from : 'the user', by: peer ? 'peer' : 'user', gist, at,
      ...(said.question ? { question: said.question, sessionId } : {}),
      ...(questionWords ? { questionWords: true } : {}),
      ...(messageId ? { messageId } : {}),
    };
    let outcome = 'new' as 'new' | 'counted' | 'seen';
    await update((all) => {
      const list = all[owner.lead.id] ?? [];
      if (messageId && list.some((a) => a.messageId === messageId || a.messageIds?.includes(messageId))) { outcome = 'seen'; return; }
      // The same ask again (the question's next message, the chat's next line): counted on its row.
      const key = askKey(ask);
      const same = list.find((a) => askKey(a) === key);
      if (same) {
        outcome = 'counted';
        same.count = (same.count ?? 1) + 1;
        // Recordings run beside their sends, so an older message may come in second.
        const newest = at >= (same.lastAt ?? same.at);
        if (newest) same.lastAt = at;
        // The question's own words win over a follow-up's that stood in for them.
        if (questionWords && !same.questionWords) { same.gist = questionWords; same.questionWords = true; }
        else if (!readAsk(same).gist && gist) same.gist = gist;
        if (!same.question && newest && said.words) same.latest = said.words;
        if (said.question && !same.question) same.question = said.question;
        if (messageId) same.messageIds = [...(same.messageIds ?? []), messageId].slice(-MAX_PER_LEAD);
        all[owner.lead.id] = [...list.filter((a) => a !== same), same];
        return;
      }
      all[owner.lead.id] = [...list, ask].slice(-MAX_PER_LEAD);
    });
    if (outcome === 'seen') return;
    log.session.info('team ask recorded', { sessionId, taskId: task.id, leadTaskId: owner.lead.id, from: peer ? peer.taskId : 'user', outcome });
  } catch (err) {
    log.session.debug('team ask not recorded', { sessionId, error: err instanceof Error ? err.message : String(err) });
  }
}
