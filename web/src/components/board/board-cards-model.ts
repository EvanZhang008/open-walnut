/**
 * The Board Overview as a project board (BoardProjectBoard.tsx): one card per
 * board project, read the way the leader's own page reads, from Walnut's data
 * rather than the page's html. Pure: no React, no DOM. Unit-pinned in
 * tests/web/board-cards-model.test.ts.
 *
 * A card is one section of the by-section reading (board-overview-model.ts
 * `buildSections`) plus what the board keeps for that project: the leader's
 * text (summary, latest, next, waiting, meta, from `board_project_set`), the
 * choices and threads the page shows inside the project's `[data-project]`
 * element (or that name one of its tasks), and the user's own state on them
 * (answers, unread messages).
 *
 * A thread whose id is a choice's id is that choice's discussion. A project's
 * own thread is the one carrying its id; a project whose page has none still
 * gets one under that id, so "Ask a question" works on every card (the server
 * names such a thread by its project when it delivers the message). Choices and
 * threads no project claims sit on a General card at the top.
 *
 * The strip counts cards by status the frame's way (board-runtime.frame.js
 * `sectionStatus`): a project that needs the user only for choices they have
 * answered counts as answered, which only All shows, until the leader moves it.
 */
import type { BoardChoice, BoardMessage, BoardProject, BoardProjectStatus, BoardReminder, BoardSeen } from './board-model';
import { reminderDue } from './board-items-model';
import { projectStatusOf, type BoardElement, type BoardElements, type OverviewSection, type PlacedRow, type SectionKind } from './board-overview-model';

export type CardKind = SectionKind | 'general';
/** Board project ids start with a letter or a digit, so this never collides with one. */
export const GENERAL_CARD_ID = '_general';

/** What a card counts as on the strip. */
export type CardBucket = BoardProjectStatus | 'answered' | 'none';
/** The strip's filter: '' is All. */
export type CardFilter = '' | BoardProjectStatus | 'none';

export const FILTER_ORDER: readonly Exclude<CardFilter, ''>[] = ['decide', 'wip', 'wait', 'done', 'none'];

export interface ChoiceOption {
  key: string;
  label: string;
}

export interface CardThread {
  id: string;
  /** The thread's own title on the page ('' when it has none). */
  title: string;
  messages: BoardMessage[];
  /** Messages newer than this browser read; the user's own never count. */
  unread: number;
  /** The newest message time that is not the user's ('' for none): what reading the thread marks seen. */
  newestOther: string;
}

export interface CardChoice {
  id: string;
  title: string;
  /** The text the author put inside the choice (its context), '' when none. */
  context: string;
  options: ChoiceOption[];
  recommended: string;
  answer: BoardChoice | null;
  /** The picked option in words: its label, the recorded label when the options no longer list it. */
  answerLabel: string;
  /** A reminder on it is due. */
  due: boolean;
  /** Its discussion (the thread with the choice's id), when the page has one. */
  thread: CardThread | null;
}

export interface ProjectCard {
  id: string;
  kind: CardKind;
  title: string;
  status: BoardProjectStatus | null;
  bucket: CardBucket;
  /** The user picked the status: the leader keeps it unless it overrides on purpose. */
  statusByUser: boolean;
  summary: string;
  latest: string;
  latestAt: string;
  next: string;
  waiting: string;
  meta: string;
  rows: PlacedRow[];
  /** Rows that need the user. */
  attention: number;
  done: number;
  choices: CardChoice[];
  /** A project's own thread first (always there for a project card), then the other threads inside it. */
  threads: CardThread[];
  /** Choices with no answer yet. */
  pendingChoices: number;
  /** Unread messages over every thread on the card, choice discussions included. */
  unread: number;
}

export interface CardsInput {
  sections: readonly OverviewSection[];
  projects: Record<string, BoardProject> | null | undefined;
  elements: BoardElements;
  board: {
    choices: Record<string, BoardChoice>;
    threads: Record<string, BoardMessage[]>;
    reminders: Record<string, BoardReminder>;
  } | null;
  seen: BoardSeen;
  now?: number;
}

/** "key:label,key:label" as the frame reads it (board-runtime.frame.js parsePairs), no fallback. */
export function parseOptions(attr: string | null | undefined): ChoiceOption[] {
  const out: ChoiceOption[] = [];
  const seen = new Set<string>();
  for (const part of String(attr ?? '').split(',')) {
    const i = part.indexOf(':');
    const key = (i < 0 ? part : part.slice(0, i)).trim();
    const label = (i < 0 ? part : part.slice(i + 1)).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label: label || key });
  }
  return out;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function isMessage(m: unknown): m is BoardMessage {
  const r = m as Partial<BoardMessage> | null;
  return !!r && typeof r === 'object' && typeof r.id === 'string' && typeof r.text === 'string'
    && typeof r.ts === 'string' && typeof r.author === 'string';
}

export function cardThread(id: string, title: string, messages: unknown, seen: BoardSeen): CardThread {
  const list = Array.isArray(messages) ? messages.filter(isMessage) : [];
  const read = seen[id] ?? '';
  let unread = 0;
  let newestOther = '';
  for (const m of list) {
    if (m.author === 'user') continue;
    if (m.ts > read) unread += 1;
    if (m.ts > newestOther) newestOther = m.ts;
  }
  return { id, title, messages: list, unread, newestOther };
}

/** A choice is answered by a pick or by the user's own words. */
export function choiceAnswered(answer: BoardChoice | null | undefined): boolean {
  return !!answer && (!!answer.option || !!answer.text);
}

function bucketOf(status: BoardProjectStatus | null, choices: readonly CardChoice[]): CardBucket {
  if (!status) return 'none';
  if (status === 'decide' && choices.length > 0 && choices.every((c) => choiceAnswered(c.answer))) return 'answered';
  return status;
}

/** The row a `task` attribute names among `rowIds`: the exact id, else the one id it is a prefix of (4+ chars). */
function rowNamed(ref: string, rowIds: readonly string[]): string {
  if (!ref) return '';
  if (rowIds.includes(ref)) return ref;
  if (ref.length < 4) return '';
  const hits = rowIds.filter((id) => id.startsWith(ref));
  return hits.length === 1 ? hits[0] : '';
}

export function buildProjectCards(input: CardsInput): ProjectCard[] {
  const { sections, elements, seen } = input;
  const data = input.board ?? { choices: {}, threads: {}, reminders: {} };
  const projects = input.projects ?? {};
  const now = input.now ?? Date.now();

  // Which card each element belongs to: its `[data-project]`, else the card holding its task, else General.
  const cardIds = new Set(sections.map((s) => s.id));
  const projectIds = new Set(sections.filter((s) => s.kind === 'project').map((s) => s.id));
  const cardOfRow = new Map<string, string>();
  for (const s of sections) for (const r of s.rows) if (!cardOfRow.has(r.id)) cardOfRow.set(r.id, s.id);
  const rowIds = [...cardOfRow.keys()];
  const home = (el: BoardElement): string => {
    if (el.project && cardIds.has(el.project)) return el.project;
    const row = rowNamed(el.task, rowIds);
    return (row && cardOfRow.get(row)) || GENERAL_CARD_ID;
  };

  const choiceIds = new Set<string>();
  const choicesOf = new Map<string, CardChoice[]>();
  for (const el of elements.choices) {
    if (!el.id || choiceIds.has(el.id)) continue;
    choiceIds.add(el.id);
    const options = parseOptions(el.options);
    const answer = data.choices[el.id] ?? null;
    const picked = answer?.option ? options.find((o) => o.key === answer.option) : undefined;
    const choice: CardChoice = {
      id: el.id,
      title: el.title,
      context: el.context ?? '',
      options,
      recommended: options.some((o) => o.key === el.recommended) ? el.recommended ?? '' : '',
      answer,
      answerLabel: answer?.option ? picked?.label || answer.label || answer.option : '',
      due: reminderDue(data.reminders[el.id], now),
      thread: null,
    };
    const at = home(el);
    const list = choicesOf.get(at);
    if (list) list.push(choice); else choicesOf.set(at, [choice]);
  }
  const choiceById = new Map<string, CardChoice>();
  for (const list of choicesOf.values()) for (const c of list) choiceById.set(c.id, c);

  const threadIds = new Set<string>();
  const threadsOf = new Map<string, CardThread[]>();
  for (const el of elements.threads) {
    if (!el.id || threadIds.has(el.id)) continue;
    threadIds.add(el.id);
    const thread = cardThread(el.id, el.title, data.threads[el.id], seen);
    const choice = choiceById.get(el.id);
    if (choice) { choice.thread = thread; continue; }
    // A project's own thread is its card's wherever the page puts it.
    const at = projectIds.has(el.id) ? el.id : home(el);
    const list = threadsOf.get(at);
    if (list) list.push(thread); else threadsOf.set(at, [thread]);
  }

  const card = (
    kind: CardKind, id: string, title: string, section: OverviewSection | null, project: Partial<BoardProject> | null,
  ): ProjectCard => {
    const choices = choicesOf.get(id) ?? [];
    let threads = threadsOf.get(id) ?? [];
    if (kind === 'project') {
      // Its own thread leads; a page that shows none still has one under the project's id.
      const own = threads.find((t) => t.id === id) ?? cardThread(id, '', data.threads[id], seen);
      threads = [own, ...threads.filter((t) => t !== own)];
    }
    const status = kind === 'project' ? projectStatusOf(project as BoardProject | null) : null;
    const unread = threads.reduce((n, t) => n + t.unread, 0) + choices.reduce((n, c) => n + (c.thread?.unread ?? 0), 0);
    return {
      id,
      kind,
      title,
      status,
      bucket: bucketOf(status, choices),
      statusByUser: kind === 'project' && project?.status_by === 'human',
      summary: text(project?.summary),
      latest: text(project?.latest),
      latestAt: text(project?.latest_at),
      next: text(project?.next),
      waiting: text(project?.waiting),
      meta: text(project?.meta),
      rows: section?.rows ?? [],
      attention: section?.attention ?? 0,
      done: section?.done ?? 0,
      choices,
      threads,
      pendingChoices: choices.filter((c) => !choiceAnswered(c.answer)).length,
      unread,
    };
  };

  const out: ProjectCard[] = [];
  if (choicesOf.has(GENERAL_CARD_ID) || threadsOf.has(GENERAL_CARD_ID)) {
    out.push(card('general', GENERAL_CARD_ID, 'General', null, null));
  }
  for (const s of sections) {
    const raw = projects[s.id];
    const project = s.kind === 'project' && raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Partial<BoardProject> : null;
    out.push(card(s.kind, s.id, s.title, s, project));
  }
  return out;
}

export type StatusCounts = Record<Exclude<CardFilter, ''>, number> & { all: number };

/** The strip's numbers: project cards by bucket ('answered' counts in All only), and All. */
export function statusCounts(cards: readonly ProjectCard[]): StatusCounts {
  const counts: StatusCounts = { decide: 0, wip: 0, wait: 0, done: 0, none: 0, all: 0 };
  for (const c of cards) {
    if (c.kind !== 'project') continue;
    counts.all += 1;
    if (c.bucket !== 'answered') counts[c.bucket] += 1;
  }
  return counts;
}

/**
 * The cards a filter shows. All shows every card; a status shows the project
 * cards in it. General (choices and threads no project claims) also shows under
 * Needs you while it holds an unanswered choice or an unread message; the
 * tasks no project names show under All only.
 */
export function cardsFor(cards: readonly ProjectCard[], filter: CardFilter): ProjectCard[] {
  if (!filter) return [...cards];
  return cards.filter((c) => {
    if (c.kind === 'project') return c.bucket === filter;
    if (c.kind === 'general') return filter === 'decide' && (c.pendingChoices > 0 || c.unread > 0);
    return false;
  });
}

/** A card folds by default when its work is over: a done project, the done rest. */
export function foldedByDefault(card: Pick<ProjectCard, 'kind' | 'status'>): boolean {
  return card.status === 'done' || card.kind === 'rest-done';
}

/** The parts of a card the reader can hide ("Show:" on the board). */
export type CardPart = 'summary' | 'latest' | 'next' | 'tasks' | 'questions';
export const CARD_PARTS: readonly CardPart[] = ['summary', 'latest', 'next', 'tasks', 'questions'];
export const CARD_PART_LABELS: Record<CardPart, string> = {
  summary: 'Overview', latest: 'Latest', next: 'Next step', tasks: 'Tasks', questions: 'Questions',
};
export type CardParts = Record<CardPart, boolean>;
export const ALL_CARD_PARTS: CardParts = { summary: true, latest: true, next: true, tasks: true, questions: true };

export const CARD_PARTS_KEY = 'walnut:board-card-parts';

/** The stored "Show:" picks; anything unreadable or unknown is shown. */
export function parseCardParts(raw: string | null | undefined): CardParts {
  const out: CardParts = { ...ALL_CARD_PARTS };
  if (!raw) return out;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
    for (const p of CARD_PARTS) {
      const on = (v as Record<string, unknown>)[p];
      if (typeof on === 'boolean') out[p] = on;
    }
  } catch { /* unreadable: everything shows */ }
  return out;
}

/** The author of a message in the card's words: You, Leader, a teammate's title, else Agent. */
export function authorLabel(author: string, ownerId: string, titleOf: (id: string) => string): string {
  if (author === 'user') return 'You';
  const id = author.startsWith('task:') ? author.slice(5) : '';
  if (id && id === ownerId) return 'Leader';
  return (id && titleOf(id)) || 'Agent';
}
