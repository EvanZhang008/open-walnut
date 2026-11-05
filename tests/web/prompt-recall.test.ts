/**
 * ArrowUp in an empty session composer brings back the person's earlier
 * messages (web/src/components/chat/prompt-recall.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  _resetPromptRecallForTests, mergeRecentSends, noteSentPrompt, promptsOfRows, publishRecallRows, recallPrompts,
  sentPromptOf, stepRecall,
} from '@/components/chat/prompt-recall';

const user = (text: string, extra: Record<string, unknown> = {}) => ({ role: 'user', text, ...extra });

describe('which rows are prompts', () => {
  it('keeps what a person typed and leaves out everything else', () => {
    expect(sentPromptOf(user('run the tests'))).toBe('run the tests');
    expect(sentPromptOf({ role: 'assistant', text: 'done' })).toBe('');
    expect(sentPromptOf(user('context', { injected: true }))).toBe('');
    expect(sentPromptOf(user('from another task', { agentOrigin: true }))).toBe('');
    expect(sentPromptOf(user('[Request interrupted by user]'))).toBe('');
    expect(sentPromptOf(user('Base directory for this skill: /x'))).toBe('');
    expect(sentPromptOf(user('[Walnut retry automated message, not from the user] go on'))).toBe('');
  });

  it('a run of the same prompt is one entry', () => {
    expect(promptsOfRows([user('continue'), user('continue'), { role: 'assistant', text: 'ok' }, user('commit it')]))
      .toEqual(['continue', 'commit it']);
  });

  it('a prompt sent again later is a stop each time, in the order it was sent', () => {
    expect(promptsOfRows([user('run the tests'), user('fix it'), user('run the tests'), user('commit it'), user('run the tests')]))
      .toEqual(['run the tests', 'fix it', 'run the tests', 'commit it', 'run the tests']);
  });
});

describe('recent sends', () => {
  beforeEach(() => _resetPromptRecallForTests());

  it('a send the transcript does not show yet is the newest entry', () => {
    expect(mergeRecentSends(['a', 'b'], ['c'])).toEqual(['a', 'b', 'c']);
    expect(mergeRecentSends(['a', 'b', 'c'], ['c'])).toEqual(['a', 'b', 'c']);
    // An old prompt sent again is the newest stop, and its old one stays.
    const old = ['again', ...Array.from({ length: 15 }, (_, i) => `p${i}`)];
    expect(mergeRecentSends(old, ['again']).slice(-2)).toEqual(['p14', 'again']);
    expect(mergeRecentSends(old, ['again']).filter((p) => p === 'again')).toHaveLength(2);
  });

  it('recallPrompts reads the published rows and forgets sends once they show', () => {
    let rows = [user('first'), user('second')];
    const off = publishRecallRows('s1', () => rows);
    noteSentPrompt('s1', 'third');
    expect(recallPrompts('s1')).toEqual(['first', 'second', 'third']);
    rows = [...rows, user('third')];
    expect(recallPrompts('s1')).toEqual(['first', 'second', 'third']);
    off();
    expect(recallPrompts('s1')).toEqual([]);
    expect(recallPrompts('other')).toEqual([]);
  });

  it('a send the transcript never shows is forgotten after a while', () => {
    const off = publishRecallRows('s2', () => [user('a')]);
    noteSentPrompt('s2', 'lost', 1_000);
    expect(recallPrompts('s2', 2_000)).toEqual(['a', 'lost']);
    expect(recallPrompts('s2', 1_000 + 11 * 60_000)).toEqual(['a']);
    off();
  });

  it('the newest mounted timeline answers, and an older one still does after it unmounts', () => {
    const a = publishRecallRows('s1', () => [user('from a')]);
    const b = publishRecallRows('s1', () => [user('from b')]);
    expect(recallPrompts('s1')).toEqual(['from b']);
    b();
    expect(recallPrompts('s1')).toEqual(['from a']);
    a();
  });
});

describe('stepRecall', () => {
  const entries = ['one', 'two', 'three'];
  const base = { entries, pos: null, current: '', empty: true, atEdge: () => true };
  const at = (index: number) => ({ index, entry: entries[index]!, text: entries[index]! });

  it('ArrowUp in an empty box brings the newest, again goes further back, stops at the oldest', () => {
    expect(stepRecall({ ...base, dir: -1 })).toEqual({ index: 2, entry: 'three' });
    expect(stepRecall({ ...base, dir: -1, pos: at(2), current: 'three', empty: false })).toEqual({ index: 1, entry: 'two' });
    expect(stepRecall({ ...base, dir: -1, pos: at(1), current: 'two', empty: false })).toEqual({ index: 0, entry: 'one' });
    expect(stepRecall({ ...base, dir: -1, pos: at(0), current: 'one', empty: false })).toBeNull();
  });

  it('ArrowDown comes forward and past the newest empties the box', () => {
    expect(stepRecall({ ...base, dir: 1, pos: at(1), current: 'two', empty: false })).toEqual({ index: 2, entry: 'three' });
    expect(stepRecall({ ...base, dir: 1, pos: at(2), current: 'three', empty: false })).toEqual({ index: -1, entry: '' });
  });

  it('does nothing in a box with a draft, or after the recalled text was edited', () => {
    expect(stepRecall({ ...base, dir: -1, current: 'my draft', empty: false })).toBeNull();
    expect(stepRecall({ ...base, dir: -1, pos: at(2), current: 'three!', empty: false })).toBeNull();
    expect(stepRecall({ ...base, dir: 1, current: '', empty: true })).toBeNull();
  });

  it('an image alone makes the box not empty', () => {
    expect(stepRecall({ ...base, dir: -1, current: '', empty: false })).toBeNull();
  });

  it('leaves the arrow to the caret when it is not on the edge line, and lays nothing out otherwise', () => {
    expect(stepRecall({ ...base, dir: -1, pos: at(2), current: 'three', empty: false, atEdge: () => false })).toBeNull();
    expect(stepRecall({ ...base, dir: 1, pos: at(2), current: 'three', empty: false, atEdge: () => false })).toBeNull();
    let asked = 0;
    stepRecall({ ...base, dir: -1, current: 'a long draft', empty: false, atEdge: () => { asked++; return true; } });
    expect(asked).toBe(0);
  });

  it('finds its place again by text when the list grew under it (older turns loaded)', () => {
    const grown = ['zero', 'older', ...entries];
    expect(stepRecall({ ...base, entries: grown, dir: -1, pos: at(2), current: 'three', empty: false })).toEqual({ index: 3, entry: 'two' });
  });

  it('keeps its own stop among the same words sent more than once when older turns load', () => {
    // The first 'go' is on screen; two older prompts load in front of it.
    const before = ['fix', 'go', 'test', 'go'];
    const pos = { index: 1, entry: 'go', text: 'go', total: before.length };
    const grown = ['a', 'b', ...before];
    expect(stepRecall({ ...base, entries: grown, dir: -1, pos, current: 'go', empty: false })).toEqual({ index: 2, entry: 'fix' });
    expect(stepRecall({ ...base, entries: grown, dir: 1, pos, current: 'go', empty: false })).toEqual({ index: 4, entry: 'test' });
  });

  it('a recalled entry shown with its references as tokens still counts as untouched', () => {
    const pos = { index: 0, entry: 'see <task-ref id="t1"/>', text: 'see @[Task one]' };
    expect(stepRecall({ ...base, entries: [pos.entry, 'b'], dir: 1, pos, current: 'see @[Task one]', empty: false }))
      .toEqual({ index: 1, entry: 'b' });
  });

  it('nothing sent yet: the arrow stays the arrow', () => {
    expect(stepRecall({ ...base, entries: [], dir: -1 })).toBeNull();
  });
});
