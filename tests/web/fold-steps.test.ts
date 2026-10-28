/**
 * A quiet fold's line (web/src/components/sessions/fold-steps.ts): what the steps
 * did, in order, never a count of turns. The reported shape (2026-10-27): a Main
 * session's "Show 4 hidden turns" held a lead's note, a notice, a reply and a
 * second note, each answered with the no-action line; the user asked for "run xxx
 * command, receive xxx, and then ack xx".
 */
import { describe, expect, it } from 'vitest';
import { commandHead, foldStepsPhrase, type FoldStep } from '@/components/sessions/fold-steps';

const note = (name: string, title?: string): FoldStep => ({ kind: 'received', from: 'peer-note', name, ...(title ? { title } : {}) });
const bash = (command: string): FoldStep => ({ kind: 'calls', tools: [{ name: 'Bash', input: { command } }] });
const ack: FoldStep = { kind: 'ack' };
const thought: FoldStep = { kind: 'thought' };

describe('foldStepsPhrase', () => {
  it('says what happened in order: who wrote, what about, and the acknowledgement', () => {
    expect(foldStepsPhrase([note('Team lead', 'Migration is top priority'), ack]))
      .toBe('From Team lead: Migration is top priority, acknowledged');
  });

  it('runs the four hidden turns of the report as one line, in order', () => {
    expect(foldStepsPhrase([
      note('Team lead', 'Migration is top priority'), thought, ack,
      { kind: 'received', from: 'notification', name: 'Team lead', title: 'Its turn ended without a reply.' }, { kind: 'sent' }, ack,
      { kind: 'received', from: 'reply', name: 'Login script', title: 'Fixed and verified' }, ack,
    ])).toBe('From Team lead: Migration is top priority, thought, acknowledged, notice about Team lead: Its turn ended without a reply, sent a message, acknowledged, reply from Login script: Fixed and verified, acknowledged');
  });

  it('names a single command by its leading words', () => {
    expect(foldStepsPhrase([bash("walnut tools call task_get '{\"id\":\"t1\"}'"), note('Team lead'), ack]))
      .toBe('Ran walnut tools call task_get, received a message from Team lead, acknowledged');
  });

  it('counts a stretch of calls the way a tool run does; reasoning between them is theirs', () => {
    expect(foldStepsPhrase([bash('ls'), thought, bash('git status'), { kind: 'calls', tools: [{ name: 'Read', input: { file_path: '/a/b.ts' } }] }]))
      .toBe('Ran 2 commands, read a file');
  });

  it('reasoning on its own reads "thought": a message, then the answer\'s reasoning', () => {
    expect(foldStepsPhrase([note('Reviews'), thought])).toBe('Received a message from Reviews, thought');
  });

  it('two messages from one sender are one piece; a different sender is its own', () => {
    expect(foldStepsPhrase([note('Reviews', 'One'), note('Reviews', 'Two'), { kind: 'sent' }]))
      .toBe('Received 2 messages from Reviews, sent a message');
    expect(foldStepsPhrase([note('Reviews', 'One'), note('Lead', 'Two')]))
      .toBe('From Reviews: One, from Lead: Two');
  });

  it('a trigger says which one fired, and how often', () => {
    expect(foldStepsPhrase([{ kind: 'received', from: 'trigger', name: 'Trigger: #dev new messages' }, ack]))
      .toBe('Trigger #dev new messages fired, acknowledged');
    expect(foldStepsPhrase([{ kind: 'received', from: 'trigger', name: 'Trigger: #dev' }, { kind: 'received', from: 'trigger', name: 'Trigger: #dev' }]))
      .toBe('Trigger #dev fired 2 times');
  });

  it('clips a long title at a word, with an ellipsis', () => {
    const phrase = foldStepsPhrase([note('Reviews', 'Question: the ten-minute limit can be tuned later by the operator, but it changes nothing today')]);
    expect(phrase.startsWith('From Reviews: Question: the ten-minute limit')).toBe(true);
    expect(phrase.endsWith('…')).toBe(true);
    expect(phrase.length).toBeLessThan(90);
  });

  it('keeps the context and update pieces, and an empty fold still has a line', () => {
    expect(foldStepsPhrase([{ kind: 'context', skill: true }, { kind: 'update' }, { kind: 'update' }])).toBe('Loaded a skill, 2 updates');
    expect(foldStepsPhrase([])).toBe('Thinking');
  });
});

describe('commandHead', () => {
  it('drops a leading cd and env assignments and stops at the first flag or argument that is not a plain word', () => {
    expect(commandHead('cd /repo && FOO=1 npm run test:quick -- --reporter dot')).toBe('npm run test:quick');
    expect(commandHead('node scripts/tools/eval.mjs --json out.json')).toBe('node eval.mjs');
    expect(commandHead('"quoted" thing')).toBeUndefined();
  });

  it('reads past a quoted or semicolon cd and wrappers, and keeps an address whole', () => {
    expect(commandHead('cd "/a b" && make check')).toBe('make check');
    expect(commandHead('cd /repo; npm test')).toBe('npm test');
    expect(commandHead('env foo=1 sudo make install')).toBe('make install');
    expect(commandHead('curl https://example.com/x/y')).toBe('curl https://example.com/x/y');
  });
});

describe('Walnut sends', () => {
  const mcp = (op: string): FoldStep => ({ kind: 'calls', tools: [{ name: `mcp__plugin_w__walnut__${op}` }] });
  it('one send reads as many do, and an inbox letter says so', () => {
    expect(foldStepsPhrase([mcp('board_post')])).toBe('Sent a message');
    expect(foldStepsPhrase([mcp('board_post'), mcp('board_post')])).toBe('Sent 2 messages');
    expect(foldStepsPhrase([note('Lead', 'Ship it'), { kind: 'inbox' }, ack])).toBe('From Lead: Ship it, wrote to your inbox, acknowledged');
    expect(foldStepsPhrase([mcp('task_get')])).toBe('Used task_get');
  });
});
