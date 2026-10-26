/**
 * The agent acknowledgement line (web/src/utils/turn-end-marker.ts). It hides a
 * whole turn, so the rule is strict: only the exact line, last, outside a code
 * fence, alone, in a turn no person started. Everything else stays on screen.
 */
import { describe, expect, it } from 'vitest';
import { LEGACY_NO_ACTION_TAG, NO_ACTION_TAG, noActionRows, readTurnMarker, stripTurnMarker } from '@/utils/turn-end-marker';

describe('readTurnMarker', () => {
  it('reads the marker as the last line and returns the text without it', () => {
    expect(readTurnMarker(`Done, nothing for you.\n\n${NO_ACTION_TAG}`)).toEqual({ text: 'Done, nothing for you.', noAction: true });
    expect(readTurnMarker(`Done.\n${NO_ACTION_TAG}\n\n  \n`)).toEqual({ text: 'Done.', noAction: true });
  });

  it('reads the line under its first name too: sessions spawned before the rename still write it', () => {
    expect(readTurnMarker(LEGACY_NO_ACTION_TAG)).toEqual({ text: '', noAction: true });
    expect(stripTurnMarker(`Done.\n\n${LEGACY_NO_ACTION_TAG}`)).toBe('Done.');
  });

  it('keeps several paragraphs, lists and code above the marker intact', () => {
    const body = 'Result one.\n\n- a\n- b\n\n```ts\nconst x = 1\n```\n\nResult two.';
    expect(readTurnMarker(`${body}\n\n${NO_ACTION_TAG}`).text).toBe(body);
  });

  it('is not the marker anywhere else', () => {
    for (const text of [
      `${NO_ACTION_TAG}\n\nBut here is what you need to do.`,
      `Quote:\n> ${NO_ACTION_TAG}`,
      `In code:\n\`\`\`\n${NO_ACTION_TAG}`,
      `The tag is ${NO_ACTION_TAG} inline.`,
      `${NO_ACTION_TAG.replace('agent-ack', 'other')}`,
      `<walnut-turn status="no-action">`,
      '',
    ]) expect(readTurnMarker(text).noAction, text).toBe(false);
  });

  it('a line of an indented code block, or inside a fence of the other kind, is code', () => {
    expect(readTurnMarker(`Code:\n\n    ${NO_ACTION_TAG}`).noAction).toBe(false)
    expect(readTurnMarker(`~~~\n\`\`\`\n${NO_ACTION_TAG}`).noAction).toBe(false)
    expect(readTurnMarker(`~~~\n\`\`\`\n~~~\n${NO_ACTION_TAG}`).noAction).toBe(true)
  })

  it('a delivery after an answer is its own turn; one that came in mid-work is part of it', () => {
    const go = { role: 'user' as const, text: 'Go.' }
    const notice = { role: 'user' as const, text: 'NOTICE' }
    const failed = { role: 'assistant' as const, text: '', tools: [{ name: 'Bash', isError: true }] }
    const lineOnly = { role: 'assistant' as const, text: NO_ACTION_TAG }
    const isPerson = (m: { text: string }) => m.text === 'Go.'
    const rows = (r: Parameters<typeof noActionRows>[0], isSent?: (m: { text: string; injected?: boolean }) => boolean) =>
      [...noActionRows(r, false, undefined, undefined, isSent, isPerson)]
    // Mid-work: the notice belongs to the person's turn, and that turn is never hidden.
    expect(rows([go, failed, notice, lineOnly])).toEqual([])
    expect(rows([go, { role: 'assistant' as const, text: '', tools: [{ name: 'Bash' }] }, notice, lineOnly])).toEqual([])
    // A person's message that came in mid-work of a notice's turn: theirs now, never hidden.
    expect(rows([notice, { role: 'assistant' as const, text: '', tools: [{ name: 'Bash' }] }, go, lineOnly])).toEqual([])
    // After an answer: the notice starts a turn of its own, the failure stays in the one before.
    expect(rows([go, failed, { role: 'assistant' as const, text: 'It failed.' }, notice, lineOnly])).toEqual([4])
    // The caller decides what counts as sent in: not sent, the notice is part of the person's turn.
    expect(rows([go, { role: 'assistant' as const, text: 'Answer.' }, notice, lineOnly], (m) => m.text !== 'NOTICE')).toEqual([])
  })

  it('an opening fence with an info string never closes a block', () => {
    expect(readTurnMarker(`\`\`\`\ncode\n\`\`\`js\n${NO_ACTION_TAG}`).noAction).toBe(false);
    expect(readTurnMarker(`\`\`\`js\ncode\n\`\`\`\n${NO_ACTION_TAG}`).noAction).toBe(true);
  });

  it('a closed fence before it does not count against it', () => {
    expect(readTurnMarker(`\`\`\`\ncode\n\`\`\`\n${NO_ACTION_TAG}`).noAction).toBe(true);
  });

  it('an unmarked text comes back unchanged', () => {
    expect(readTurnMarker('Plain answer.')).toEqual({ text: 'Plain answer.', noAction: false });
    expect(readTurnMarker(undefined)).toEqual({ text: '', noAction: false });
  });
});

describe('stripTurnMarker', () => {
  it('never prints the marker line', () => {
    expect(stripTurnMarker(`Done.\n\n${NO_ACTION_TAG}`)).toBe('Done.');
  });

  it('holds back a half-written marker while streaming, and only then', () => {
    expect(stripTurnMarker('Done.\n\n<walnut-tu', true)).toBe('Done.\n');
    expect(stripTurnMarker('Done.\n\n<', true)).toBe('Done.\n');
    expect(stripTurnMarker('Done.\n\n<walnut-tu', false)).toBe('Done.\n\n<walnut-tu');
    expect(stripTurnMarker('Use a < b', true)).toBe('Use a < b');
    expect(stripTurnMarker('Done.\n<b>bold</b>', true)).toBe('Done.\n<b>bold</b>');
  });
});

describe('noActionRows: only a finished, clean agent turn ending in the line alone', () => {
  // `user()` rows here are notices: no person wrote them.
  const user = (text = 'NOTICE') => ({ role: 'user' as const, text });
  const said = (text: string, tools?: { name: string; isError?: boolean }[]) => ({ role: 'assistant' as const, text, ...(tools ? { tools } : {}) });
  const marked = said(NO_ACTION_TAG);
  const ok = (rows: Parameters<typeof noActionRows>[0], streaming = false) => [...noActionRows(rows, streaming)];

  it('never a turn a person started, never a line with words before it (2026-10-25)', () => {
    const person = (m: { text: string }) => m.text === 'Does it have to be a Mac?';
    // The answer to the person's own question, line and all, is an answer.
    expect([...noActionRows([user('Does it have to be a Mac?'), said(`Yes. Here is why...\n\n${NO_ACTION_TAG}`)], false, undefined, undefined, undefined, person)]).toEqual([]);
    expect([...noActionRows([user('Does it have to be a Mac?'), marked], false, undefined, undefined, undefined, person)]).toEqual([]);
    // Words before the line, in a notice's turn: still words for the reader.
    expect(ok([user(), said(`All done, nothing for you.\n\n${NO_ACTION_TAG}`)])).toEqual([]);
  });

  it('folds the last row of a clean finished turn', () => {
    expect(ok([user(), said('', [{ name: 'Read' }]), said('Middle result.'), marked])).toEqual([3]);
    expect(ok([user(), marked, user('Next.'), said('Plain.')])).toEqual([1]);
  });

  it('never the turn still streaming, but an earlier finished one yes', () => {
    expect(ok([user(), marked], true)).toEqual([]);
    expect(ok([user(), marked, user('Next.'), said('...')], true)).toEqual([1]);
  });

  it('never when the marked row is not the turn\'s last word', () => {
    expect(ok([user(), marked, said('', [{ name: 'Bash' }])])).toEqual([]);
    expect(ok([user(), marked, said('One more thing you must do.')])).toEqual([]);
  });

  it('never with a failure, a question, a plan or an error line in the turn', () => {
    expect(ok([user(), said('', [{ name: 'Bash', isError: true }]), marked])).toEqual([]);
    expect(ok([user(), said('', [{ name: 'AskUserQuestion' }]), marked])).toEqual([]);
    expect(ok([user(), said('', [{ name: 'ExitPlanMode' }]), marked])).toEqual([]);
    expect(ok([user(), { role: 'system', text: 'API error', systemVariant: 'error' }, marked])).toEqual([]);
  });

  it('an info line after the answer does not hide it; a CLI-injected line does not start a turn', () => {
    expect(ok([user(), marked, { role: 'system', text: 'Compacted', systemVariant: 'compact' }])).toEqual([1]);
    expect(ok([user(), said('', [{ name: 'Bash', isError: true }]), { role: 'user', text: 'skill dump', injected: true }, marked])).toEqual([]);
  });

  it('a turn whose start is outside the window is never folded', () => {
    expect(ok([said('', [{ name: 'Bash', isError: true }]), marked])).toEqual([]);
    // A message that came in while that unseen turn was still working: same answer.
    expect(ok([said('', [{ name: 'Bash', isError: true }]), user(), marked])).toEqual([]);
    // One after its answer starts a turn the window holds whole.
    expect(ok([said('Earlier answer.'), user(), marked])).toEqual([2]);
  });

  it('an unmarked answer is never folded', () => {
    expect(ok([user(), said('Here is what you need to decide.')])).toEqual([]);
  });
});
