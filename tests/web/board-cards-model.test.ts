/**
 * The Overview's project board (web/src/components/board/board-cards-model.ts):
 * which card each choice and thread lands on, the leader's card text, what
 * counts as unread, the strip's buckets and filters, and the reader's "Show:"
 * picks. The board itself is proven in a real browser:
 * tests/e2e/browser/board-overview.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '@open-walnut/core';
import {
  GENERAL_CARD_ID, authorLabel, buildProjectCards, cardThread, cardsFor, choiceAnswered, foldedByDefault,
  parseCardParts, parseOptions, statusCounts, type CardsInput, type ProjectCard,
} from '../../web/src/components/board/board-cards-model';
import {
  REST_DONE_SECTION_ID, REST_SECTION_ID, buildTeamOverview, type BoardElement, type BoardElements,
} from '../../web/src/components/board/board-overview-model';
import type { BoardChoice, BoardMessage, BoardProject, BoardReminder } from '../../web/src/components/board/board-model';
import { subtasksOf } from '../../web/src/components/tasks/subtask-index';

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id, title: `Task ${id}`, status: 'todo', phase: 'TODO', priority: 'none', project: 'Orchard', source: 'local',
    description: '', summary: '', note: '', created_at: ago(900), updated_at: ago(600), ...extra,
  } as Task;
}

const project = (p: Partial<BoardProject>): BoardProject => ({ updated_at: ago(30), updated_by: 'task:lead-0001', ...p });
const msg = (id: string, author: BoardMessage['author'], min: number, text = `m ${id}`): BoardMessage => ({ id, author, text, ts: ago(min) });
const el = (id: string, extra: Partial<BoardElement> = {}): BoardElement => ({ id, title: '', task: '', ...extra });

function cards(opts: {
  tasks: Task[];
  projects: Record<string, BoardProject>;
  elements?: Partial<BoardElements>;
  choices?: Record<string, BoardChoice>;
  threads?: Record<string, BoardMessage[]>;
  reminders?: Record<string, BoardReminder>;
  seen?: Record<string, string>;
}): ProjectCard[] {
  const elements: BoardElements = { choices: [], threads: [], projects: Object.keys(opts.projects), ...opts.elements };
  const board = { choices: opts.choices ?? {}, threads: opts.threads ?? {}, reminders: opts.reminders ?? {} };
  const all = [task('lead-0001'), ...opts.tasks];
  const overview = buildTeamOverview({
    ownerId: 'lead-0001', owner: all[0], childrenOf: (id) => subtasksOf(all, id), statusOf: () => null,
    elements, board, projects: opts.projects, seen: opts.seen ?? {}, now: NOW,
  });
  return buildProjectCards({ sections: overview.sections!, projects: opts.projects, elements, board, seen: opts.seen ?? {}, now: NOW });
}

const byId = (list: ProjectCard[], id: string) => list.find((c) => c.id === id)!;

describe('parseOptions', () => {
  it('reads key:label pairs the frame\'s way, a bare key as its own label, each key once', () => {
    expect(parseOptions('now:Run it now, later : After the deploy ,skip')).toEqual([
      { key: 'now', label: 'Run it now' }, { key: 'later', label: 'After the deploy' }, { key: 'skip', label: 'skip' },
    ]);
    expect(parseOptions('a:One,a:Again,:nokey,,b:')).toEqual([{ key: 'a', label: 'One' }, { key: 'b', label: 'b' }]);
    expect(parseOptions('')).toEqual([]);
    expect(parseOptions(undefined)).toEqual([]);
    // A label may hold a colon of its own: only the first one splits.
    expect(parseOptions('t:At 10:00')).toEqual([{ key: 't', label: 'At 10:00' }]);
  });
});

describe('cardThread', () => {
  it('counts unread past the seen mark, never the user\'s own, and names the newest other message', () => {
    const t = cardThread('sec-a', 'Area', [msg('1', 'task:lead-0001', 50), msg('2', 'user', 40), msg('3', 'task:w-0001', 30), msg('4', 'user', 5)], { 'sec-a': ago(45) });
    expect(t.unread).toBe(1);
    expect(t.newestOther).toBe(ago(30));
    expect(t.messages.map((m) => m.id)).toEqual(['1', '2', '3', '4']);
    expect(cardThread('x', '', [msg('1', 'user', 5)], {})).toMatchObject({ unread: 0, newestOther: '' });
  });

  it('drops malformed messages instead of crashing on them', () => {
    const t = cardThread('x', '', [null, { id: 'a' }, 'text', msg('ok', 'task:lead-0001', 3)], {});
    expect(t.messages.map((m) => m.id)).toEqual(['ok']);
    expect(cardThread('x', '', { not: 'a list' }, {}).messages).toEqual([]);
  });
});

describe('buildProjectCards', () => {
  const tasks = [
    task('wa-0001', { parent_task_id: 'lead-0001' }), task('wb-0001', { parent_task_id: 'lead-0001' }),
    task('wc-0001', { parent_task_id: 'lead-0001', phase: 'COMPLETE', status: 'done' }), task('loose-0001', { parent_task_id: 'lead-0001' }),
  ];

  it('makes one card per project in the page\'s order with the leader\'s text trimmed, and the rest after', () => {
    const out = cards({
      tasks,
      projects: {
        'sec-b': project({ title: 'Bus race', status: 'wait', tasks: ['wb-0001'], summary: '  A race.  ', latest: 'Fix in review.', latest_at: ago(20), next: 'Deploy Monday', waiting: '3 CRs', meta: '6 tickets' }),
        'sec-a': project({ title: 'Memory', status: 'decide', tasks: ['wa-0001'], status_by: 'human' }),
        'sec-c': project({ title: 'Done one', status: 'done', tasks: ['wc-0001'], summary: 42 as unknown as string }),
      },
      elements: { projects: ['sec-a', 'sec-b', 'sec-c'] },
    });
    expect(out.map((c) => [c.kind, c.id, c.title, c.status])).toEqual([
      ['project', 'sec-a', 'Memory', 'decide'],
      ['project', 'sec-b', 'Bus race', 'wait'],
      ['project', 'sec-c', 'Done one', 'done'],
      ['rest', REST_SECTION_ID, 'Other tasks', null],
    ]);
    expect(byId(out, 'sec-b')).toMatchObject({
      summary: 'A race.', latest: 'Fix in review.', latestAt: ago(20), next: 'Deploy Monday', waiting: '3 CRs', meta: '6 tickets', statusByUser: false,
    });
    expect(byId(out, 'sec-a')).toMatchObject({ summary: '', latest: '', next: '', statusByUser: true });
    expect(byId(out, 'sec-c').summary).toBe('');
    expect(byId(out, 'sec-b').rows.map((r) => r.id)).toEqual(['wb-0001']);
    expect(byId(out, REST_SECTION_ID).rows.map((r) => r.id)).toEqual(['loose-0001']);
  });

  it('puts a choice and a thread on the project around them, else the one holding their task, else General first', () => {
    const out = cards({
      tasks,
      projects: { 'sec-a': project({ status: 'decide', tasks: ['wa-0001'] }), 'sec-b': project({ status: 'wip', tasks: ['wb-0001'] }) },
      elements: {
        choices: [
          el('pick-a', { project: 'sec-a', title: 'Ship it?', options: 'go:Go,wait:Wait', recommended: 'go', context: 'Two ways.' }),
          el('pick-b', { task: 'wb-00' }),
          el('pick-loose'),
          el('pick-a', { project: 'sec-b' }), // the same id again: the first one wins
        ],
        threads: [
          el('sec-a', { project: 'sec-a' }),
          el('sec-b'), // a project's own thread, outside its section: still that project's
          el('pick-a', { project: 'sec-a' }), // a choice's discussion
          el('side-b', { project: 'sec-b', title: 'Side talk' }),
          el('overall', { title: 'Overall' }),
          el('ghost', { project: 'sec-gone' }),
        ],
      },
      threads: { 'pick-a': [msg('d1', 'task:lead-0001', 9)] },
    });
    expect(out[0]).toMatchObject({ kind: 'general', id: GENERAL_CARD_ID, title: 'General', status: null, bucket: 'none' });
    expect(out[0].choices.map((c) => c.id)).toEqual(['pick-loose']);
    expect(out[0].threads.map((t) => t.id)).toEqual(['overall', 'ghost']);
    const a = byId(out, 'sec-a');
    expect(a.choices).toHaveLength(1);
    expect(a.choices[0]).toMatchObject({
      id: 'pick-a', title: 'Ship it?', context: 'Two ways.', recommended: 'go', answer: null, answerLabel: '',
      options: [{ key: 'go', label: 'Go' }, { key: 'wait', label: 'Wait' }],
    });
    expect(a.choices[0].thread?.messages.map((m) => m.id)).toEqual(['d1']);
    expect(a.threads.map((t) => t.id)).toEqual(['sec-a']);
    const b = byId(out, 'sec-b');
    expect(b.choices.map((c) => c.id)).toEqual(['pick-b']);
    expect(b.threads.map((t) => [t.id, t.title])).toEqual([['sec-b', ''], ['side-b', 'Side talk']]);
  });

  it('gives every project its own thread, the page showing one or not, with the messages already stored under its id', () => {
    const out = cards({
      tasks,
      projects: { 'sec-a': project({ tasks: ['wa-0001'] }), 'sec-b': project({}) },
      threads: { 'sec-b': [msg('q1', 'user', 30), msg('a1', 'task:lead-0001', 20)] },
    });
    expect(byId(out, 'sec-a').threads.map((t) => [t.id, t.messages.length])).toEqual([['sec-a', 0]]);
    expect(byId(out, 'sec-b').threads.map((t) => [t.id, t.messages.length, t.unread])).toEqual([['sec-b', 2, 1]]);
    expect(out.some((c) => c.kind === 'general')).toBe(false);
    // The rest card is no project: it gets no thread of its own.
    expect(byId(out, REST_SECTION_ID).threads).toEqual([]);
  });

  it('sums unread over the card\'s threads and its choices\' discussions, and counts pending choices', () => {
    const out = cards({
      tasks,
      projects: { 'sec-a': project({ status: 'decide', tasks: ['wa-0001'] }) },
      elements: { choices: [el('c1', { project: 'sec-a' }), el('c2', { project: 'sec-a' })], threads: [el('c1', { project: 'sec-a' })] },
      choices: { c2: { option: 'x', at: ago(3) } },
      threads: { 'sec-a': [msg('1', 'task:lead-0001', 10), msg('2', 'task:lead-0001', 5)], c1: [msg('3', 'task:wa-0001', 4)] },
      seen: { 'sec-a': ago(7) },
    });
    const a = byId(out, 'sec-a');
    expect(a.unread).toBe(2);
    expect(a.pendingChoices).toBe(1);
    expect(a.bucket).toBe('decide');
  });

  it('names an answer by its option\'s label, the recorded label when the options moved on, and flags a due reminder', () => {
    const out = cards({
      tasks,
      projects: { 'sec-a': project({ status: 'decide', tasks: ['wa-0001'] }) },
      elements: {
        choices: [
          el('c1', { project: 'sec-a', options: 'go:Go now,no:Hold', recommended: 'maybe' }),
          el('c2', { project: 'sec-a', options: 'a:A' }),
          el('c3', { project: 'sec-a', options: 'a:A' }),
          el('c4', { project: 'sec-a' }),
        ],
      },
      choices: {
        c1: { option: 'go', at: ago(5) },
        c2: { option: 'old', label: 'An old option', at: ago(5) },
        c3: { option: 'gone', at: ago(5) },
        c4: { option: '', text: 'Only after the backup', at: ago(5) },
      },
      reminders: { c1: { at: ago(1), set_at: ago(60), set_by: 'human' }, c2: { at: new Date(NOW + 3_600_000).toISOString(), set_at: ago(60), set_by: 'human' } },
    });
    const [c1, c2, c3, c4] = byId(out, 'sec-a').choices;
    expect(c1).toMatchObject({ answerLabel: 'Go now', recommended: '', due: true });
    expect(c2).toMatchObject({ answerLabel: 'An old option', due: false });
    expect(c3.answerLabel).toBe('gone');
    expect(c4.answerLabel).toBe('');
    expect(choiceAnswered(c4.answer)).toBe(true);
    // Every choice answered: the project no longer needs the user until the leader moves it.
    expect(byId(out, 'sec-a').bucket).toBe('answered');
  });
});

describe('the strip', () => {
  function board(): ProjectCard[] {
    return cards({
      tasks: [task('w1-0001', { parent_task_id: 'lead-0001' }), task('w2-0001', { parent_task_id: 'lead-0001' })],
      projects: {
        d1: project({ status: 'decide' }), d2: project({ status: 'decide' }), d3: project({ status: 'decide' }),
        p1: project({ status: 'wip' }), w1: project({ status: 'wait', tasks: ['w1-0001'] }), f1: project({ status: 'done' }),
        n1: project({ title: 'No status yet' }), odd: project({ status: 'later' as BoardProject['status'] }),
      },
      elements: { choices: [el('ask-d3', { project: 'd3' }), el('loose-ask')], threads: [el('loose-talk')] },
      choices: { 'ask-d3': { option: 'yes', at: ago(1) } },
    });
  }

  it('counts project cards by status, an answered one in All only, an unknown status as none', () => {
    expect(statusCounts(board())).toEqual({ decide: 2, wip: 1, wait: 1, done: 1, none: 2, all: 8 });
  });

  it('filters by status; General joins Needs you while it holds an open choice; the other tasks show under All only', () => {
    const all = board();
    const ids = (f: Parameters<typeof cardsFor>[1]) => cardsFor(all, f).map((c) => c.id);
    expect(ids('')).toEqual([GENERAL_CARD_ID, 'd1', 'd2', 'd3', 'p1', 'w1', 'f1', 'n1', 'odd', REST_SECTION_ID]);
    expect(ids('decide')).toEqual([GENERAL_CARD_ID, 'd1', 'd2']);
    expect(ids('wait')).toEqual(['w1']);
    expect(ids('none')).toEqual(['n1', 'odd']);
    expect(ids('done')).toEqual(['f1']);
    // General with nothing open is not a Needs-you card.
    const quiet = all.map((c) => (c.kind === 'general' ? { ...c, pendingChoices: 0, unread: 0 } : c));
    expect(cardsFor(quiet, 'decide').map((c) => c.id)).toEqual(['d1', 'd2']);
  });

  it('folds the done ones by default', () => {
    expect(foldedByDefault({ kind: 'project', status: 'done' })).toBe(true);
    expect(foldedByDefault({ kind: 'rest-done', status: null })).toBe(true);
    expect(foldedByDefault({ kind: 'project', status: 'decide' })).toBe(false);
    expect(foldedByDefault({ kind: 'rest', status: null })).toBe(false);
  });

  it('keeps the done rest as its own card, after the open one', () => {
    const out = cards({
      tasks: [task('a-0001', { parent_task_id: 'lead-0001' }), task('b-0001', { parent_task_id: 'lead-0001', phase: 'COMPLETE', status: 'done' })],
      projects: { p: project({ status: 'wip' }) },
    });
    expect(out.map((c) => [c.kind, c.id, c.title])).toEqual([
      ['project', 'p', 'p'], ['rest', REST_SECTION_ID, 'Other tasks'], ['rest-done', REST_DONE_SECTION_ID, 'Other tasks, done'],
    ]);
  });
});

describe('a board at real density', () => {
  it('21 projects, 42 workers, a thread each, 3 choices with their discussions: nothing lost, nothing on General', () => {
    // Non-Latin titles, as a real board has them (CJK test data as escapes).
    const NODE = '\u8282\u70b9';
    const PROJECT = '\u9879\u76ee';
    const ids = Array.from({ length: 21 }, (_, i) => `sec-${String.fromCharCode(97 + i)}`);
    const tasks: Task[] = [];
    const projects: Record<string, BoardProject> = {};
    const statuses = ['decide', 'wip', 'wait', 'done'] as const;
    ids.forEach((id, i) => {
      const a = `w${i}a-0001`;
      const b = `w${i}b-0001`;
      tasks.push(task(a, { parent_task_id: 'lead-0001', title: `${NODE} ${i} a` }), task(b, { parent_task_id: 'lead-0001' }));
      projects[id] = project({
        title: `${PROJECT} ${i}`, status: statuses[i % 4], tasks: [a, b],
        summary: `Summary ${i}: ${'long text '.repeat(40)}`, latest: `Latest ${i}`, latest_at: ago(i), next: `Next ${i}`,
      });
    });
    const out = cards({
      tasks,
      projects,
      elements: {
        projects: ids,
        threads: [...ids.map((id) => el(id, { project: id })), ...['c0', 'c1', 'c2'].map((c) => el(c, { project: 'sec-a' }))],
        choices: ['c0', 'c1', 'c2'].map((c) => el(c, { project: 'sec-a', options: 'y:Yes,n:No' })),
      },
    });
    expect(out.filter((c) => c.kind === 'project')).toHaveLength(21);
    expect(out.some((c) => c.kind === 'general' || c.kind === 'rest')).toBe(false);
    expect(out.every((c) => c.rows.length === 2 && c.threads.length === 1 && c.threads[0].id === c.id)).toBe(true);
    expect(byId(out, 'sec-a').choices.map((c) => c.thread?.id)).toEqual(['c0', 'c1', 'c2']);
    expect(out[0].title).toBe(`${PROJECT} 0`);
    expect(statusCounts(out)).toEqual({ decide: 6, wip: 5, wait: 5, done: 5, none: 0, all: 21 });
  });
});

describe('the reader\'s picks and words', () => {
  it('"Show:" reads what was stored and shows anything it cannot read', () => {
    expect(parseCardParts(null)).toEqual({ summary: true, latest: true, next: true, tasks: true, questions: true });
    expect(parseCardParts('{"latest":false,"tasks":false,"bogus":false,"next":"no"}'))
      .toEqual({ summary: true, latest: false, next: true, tasks: false, questions: true });
    expect(parseCardParts('not json')).toEqual(parseCardParts(null));
    expect(parseCardParts('[false]')).toEqual(parseCardParts(null));
  });

  it('names a message\'s author: You, Leader, a teammate by title, else Agent', () => {
    const titleOf = (id: string) => (id === 'w-0001' ? 'Menu page' : '');
    expect(authorLabel('user', 'lead-0001', titleOf)).toBe('You');
    expect(authorLabel('task:lead-0001', 'lead-0001', titleOf)).toBe('Leader');
    expect(authorLabel('task:w-0001', 'lead-0001', titleOf)).toBe('Menu page');
    expect(authorLabel('task:gone-0001', 'lead-0001', titleOf)).toBe('Agent');
    expect(authorLabel('odd', 'lead-0001', titleOf)).toBe('Agent');
  });
});
