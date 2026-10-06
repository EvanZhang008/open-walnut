/**
 * Kanban ops of a Board (skill walnut-board): the leader keeps every worker's
 * card current (board_card_set) and, rarely, the lanes (board_lanes_set).
 * Routes: src/web/routes/board-kanban-v1.ts. The board defaults to the team's
 * shared board like every other board_* op. A card the user placed keeps their
 * lane: the route answers 409 status_set_by_user, whose message (it says the
 * lane was recorded as a suggestion) reaches the session as the op's error.
 */
import { z } from 'zod';
import { defineOp } from './registry.js';
import { withOutcome } from './outcome.js';
import { boardOfPossessive, boardPath, resolveBoardTask, TASK_ARG } from './boards.js';

interface LaneBody { id?: string; name?: string; kind?: string }

const KIND = z.enum(['todo', 'active', 'wait', 'review', 'done']);

/** `task` or `task_id` names the board; both default to the team's board. */
const BOARD_ARGS = { task: TASK_ARG, task_id: TASK_ARG };

defineOp({
  name: 'board_lanes_set',
  title: 'Set the lanes of a board\'s kanban',
  description:
    'Replace the whole lane list of your team\'s Board kanban (or of the task you name): order is column order, ' +
    'an entry without id is a new lane, an id you leave out is deleted (its cards go back to automatic placement). ' +
    'Kinds: todo, active, wait, review, done; a board keeps one done lane. Only when the team\'s process really ' +
    'differs from the template; the user edits lanes too and a session\'s write over theirs is refused unless ' +
    'override_user.',
  input: {
    ...BOARD_ARGS,
    lanes: z.array(z.object({
      id: z.string().min(1).max(40).optional().describe('An existing lane id to keep; omit for a new lane'),
      name: z.string().min(1).max(40).describe('The lane name (unique, ignoring case)'),
      kind: KIND.describe('todo, active, wait, review or done'),
    })).min(1).max(12).describe('Every lane, in column order'),
    override_user: z.boolean().optional().describe('true: replace lanes the user set; without it their lanes stay'),
  },
  handler: async (args, call) => {
    const target = await resolveBoardTask(args, call);
    const body = await call('PUT', boardPath(target.taskId, '/lanes'), {
      lanes: args.lanes,
      ...(args.override_user === true ? { override_user: true } : {}),
    }) as { lanes?: LaneBody[]; cards_unplaced?: string[] };
    const names = (body.lanes ?? []).map((l) => l.name).join(', ');
    const unplaced = body.cards_unplaced?.length ?? 0;
    return withOutcome(
      { task_id: target.taskId, ...body },
      `Lanes of ${boardOfPossessive(target)}: ${names}.${unplaced ? ` ${unplaced} card${unplaced === 1 ? '' : 's'} lost a deleted lane and went back to automatic placement.` : ''}`,
      'Keep each card current with board_card_set (summary, lane, waiting_on).',
    );
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'board_card_set',
  title: 'Update one card of a board\'s kanban',
  description:
    'Update the card of one subtask on your team\'s Board kanban (or of the task you name). Keep every worker\'s ' +
    'card current: set summary (<= 300 chars, what the ticket is and where it stands) when a worker reports, set ' +
    'lane when the ticket moves in the process, set waiting_on when it blocks on a CR, a team or a customer; a card ' +
    'the user placed keeps their lane unless override_user. Plain text, no markdown; the first 100 characters are ' +
    'what a card shows. "" clears a field (lane "" = back to automatic placement).',
  input: {
    ...BOARD_ARGS,
    card: z.string().min(1).describe('The subtask whose card this is (full id or unique prefix)'),
    lane: z.string().max(64).optional().describe('A lane id from board_get lanes_effective; "" = automatic'),
    summary: z.string().max(300).optional().describe('What the ticket is and where it stands; "" clears'),
    waiting_on: z.string().max(80).optional().describe('Who or what it waits on (a CR, a team, a customer); "" clears'),
    override_user: z.boolean().optional().describe('true: replace a lane the user picked; without it their lane stays'),
  },
  handler: async (args, call) => {
    const target = await resolveBoardTask(args, call);
    const card = String(args.card);
    const body = await call('PUT', boardPath(target.taskId, `/cards/${encodeURIComponent(card)}`), {
      ...(args.lane !== undefined ? { lane: args.lane } : {}),
      ...(args.summary !== undefined ? { summary: args.summary } : {}),
      ...(args.waiting_on !== undefined ? { waiting_on: args.waiting_on } : {}),
      ...(args.override_user === true ? { override_user: true } : {}),
    }) as { card?: Record<string, unknown>; lane_effective?: string };
    const lanes = await call('GET', `${boardPath(target.taskId)}?fields=kanban`)
      .then((b) => (b as { lanes_effective?: LaneBody[] }).lanes_effective ?? [], () => [] as LaneBody[]);
    const laneId = body.lane_effective ?? '';
    const name = lanes.find((l) => l.id === laneId)?.name ?? laneId;
    const parts = [
      ...(args.summary !== undefined ? [args.summary ? 'summary set' : 'summary cleared'] : []),
      ...(args.waiting_on !== undefined ? [args.waiting_on ? `waiting on ${String(args.waiting_on)}` : 'waiting on cleared'] : []),
    ];
    return withOutcome(
      { task_id: target.taskId, ...body },
      `Card ${card} on ${boardOfPossessive(target)} is in ${name ? `"${name}"` : 'no lane'}${parts.length ? `; ${parts.join(', ')}` : ''}.`,
      'Update it again when the worker reports or the ticket moves.',
    );
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});
