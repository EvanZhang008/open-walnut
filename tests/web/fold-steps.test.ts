/**
 * A quiet fold's line (web/src/components/sessions/fold-steps.ts): counts only,
 * "Received 12 messages · Sent 3 · Ran 8 tools". 2026-10-28, the user, of a line
 * that named every sender, notice and command and ran past the screen: no titles
 * or commands. 2026-10-31, the user, of a line that named its senders: "just
 * Received 1 message". The opened fold shows each step with its sender and target.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { envelopeSteps, foldStepsPhrase, systemRunLabel, systemRunShows, type FoldStep } from '@/components/sessions/fold-steps';
import { parseSessionEnvelopes } from '../../src/lib/history-session-envelope';
import { parseSessionMessages } from '../../src/core/session-history';
import { CONTEXT_COMPACT_TEXT } from '../../src/core/sessions/context-full-recovery';
import { CONTEXT_COMPACT_HISTORY_TEXT, LEGACY_CONTEXT_COMPACT_HISTORY_TEXTS, WALNUT_COMMAND_HISTORY_TEXT } from '../../src/core/sessions/walnut-commands';

// The first argument names the sender in the test only: a step carries none.
const note = (_sender: string, title?: string): FoldStep => ({ kind: 'received', from: 'peer-note', ...(title ? { title } : {}) });
const notice = (_about: string, title: string): FoldStep => ({ kind: 'received', from: 'notification', title });
const bash = (command: string): FoldStep => ({ kind: 'calls', tools: [{ name: 'Bash', input: { command } }] });
const ack: FoldStep = { kind: 'ack' };
const thought: FoldStep = { kind: 'thought' };
const sent: FoldStep = { kind: 'sent' };

describe('foldStepsPhrase', () => {
  it('reads the reported dense stretch as three counts, no names, titles or commands', () => {
    const steps: FoldStep[] = [
      notice('Walnut VP', 'Team update (last note 18 min ago), from your teams\' own status'),
      notice('Board tags', 'Stopped without completing its task'),
      bash('git cat-file -p HEAD'), sent, ack,
      note('Walnut VP', 'Bun migration is top priority'), thought, ack,
      ...Array.from({ length: 10 }, (_, i) => note(`Sender ${i}`, 'A title long enough to matter')),
      bash('ls'), { kind: 'calls', tools: [{ name: 'Read', input: { file_path: '/a/b.ts' } }, { name: 'Grep', input: {} }] },
      sent, { kind: 'inbox' },
      ...Array.from({ length: 4 }, () => bash('bun test')),
    ];
    const line = foldStepsPhrase(steps);
    expect(line).toBe('Received 13 messages · Sent 3 · Ran 8 tools');
    for (const word of ['Bun migration', 'Team update', 'git', 'acknowledged', 'thought', 'Sender', 'Walnut VP', 'Board tags', 'inbox']) {
      expect(line).not.toContain(word);
    }
  });

  it('uses the singular for one and leaves out what did not happen', () => {
    expect(foldStepsPhrase([note('Team lead', 'Migration is top priority'), ack])).toBe('Received 1 message');
    expect(foldStepsPhrase([{ kind: 'received', from: 'other' }])).toBe('Received 1 message');
    expect(foldStepsPhrase([{ kind: 'sent', to: 'Brief task' }, { kind: 'sent', to: 'Task status foundation' }]))
      .toBe('Sent 2');
    expect(foldStepsPhrase([sent])).toBe('Sent 1');
    expect(foldStepsPhrase([bash('ls')])).toBe('Ran 1 tool');
    expect(foldStepsPhrase([note('A'), bash('ls'), thought, bash('pwd')])).toBe('Received 1 message · Ran 2 tools');
  });

  it('a title with its own dot or comma never reads as the line\'s separator or list', () => {
    expect(foldStepsPhrase([{ kind: 'sent', to: 'Brief: the letter, in three sections \u00b7 Tabs' }, { kind: 'sent', to: 'Docs' }, bash('ls')]))
      .toBe('Sent 2 \u00b7 Ran 1 tool');
  });

  it('names no one, whatever the steps carry (2026-10-31, the user: "just Received 1 message")', () => {
    const named: FoldStep[] = [note('Product regressions the browser suite caught'), { kind: 'sent', to: 'Brief task' }, { kind: 'inbox' }, bash('ls')];
    expect(foldStepsPhrase(named)).toBe('Received 1 message · Sent 2 · Ran 1 tool');
    expect(foldStepsPhrase(named)).not.toMatch(/ (from|to) /);
  });

  it('a letter to the inbox counts as sent', () => {
    expect(foldStepsPhrase([{ kind: 'inbox' }, sent])).toBe('Sent 2');
  });

  it('a stretch with nothing received, sent or run reads by what it was', () => {
    expect(foldStepsPhrase([{ kind: 'update' }])).toBe('An update');
    expect(foldStepsPhrase([{ kind: 'update' }, { kind: 'update' }])).toBe('2 updates');
    expect(foldStepsPhrase([ack])).toBe('Acknowledged');
    expect(foldStepsPhrase([thought])).toBe('Thinking');
    expect(foldStepsPhrase([])).toBe('Thinking');
    expect(foldStepsPhrase([{ kind: 'context', skill: true }])).toBe('Thinking');
  });

  // 2026-10-31, Main's chat: "Received 13 messages from CEO, from Trigger: Main daily
  // reflection +8". The org notices carry about="CEO" (Main itself), and the line read
  // that subject as their sender. The same structure, neutral names.
  it('the reported Main chat: notices about the session itself and a routine run name no one', () => {
    const text = [
      '<walnut-message kind="notification" from="Walnut" outcome="task-routing-policy" note="current default instructions">\nWalnut changed your default instructions.\n</walnut-message>',
      '<walnut-message kind="notification" from="Walnut" about="CEO" about-task="main-task-1" outcome="org-update">\nOrg update since 2 h ago\n</walnut-message>',
      '<walnut-message kind="trigger" from="Trigger: Main daily reflection">\nRoutine ran on schedule\n</walnut-message>',
    ].join('\n\n');
    const line = foldStepsPhrase(envelopeSteps(parseSessionEnvelopes(text)));
    expect(line).toBe('Received 3 messages');
  });

  it('no envelope kind lends its sender or its subject to the line', () => {
    // Every kind the parser accepts, read from its source, so a new one is covered.
    const src = readFileSync(new URL('../../src/lib/history-session-envelope.ts', import.meta.url), 'utf8');
    const kinds = [...(src.match(/const TAG_KINDS = new Set\(\[([^\]]+)\]\)/)?.[1] ?? '').matchAll(/'([\w-]+)'/g)].map((m) => m[1]);
    expect(kinds).toEqual(expect.arrayContaining(['peer-note', 'reply', 'notification', 'trigger', 'app-state']));
    for (const kind of kinds) {
      const text = `<walnut-message kind="${kind}" from="Sender Task [abcd1234]" from-task="t-from" about="Subject Task [abcd5678]" about-task="t-about" title="A title" outcome="done">\nbody\n</walnut-message>`;
      const segments = parseSessionEnvelopes(text);
      expect(segments.some((x) => x.kind === 'envelope'), kind).toBe(true);
      const line = foldStepsPhrase(envelopeSteps(segments));
      expect(line, kind).toBe('Received 1 message');
    }
  });

  // 2026-11-04 review: a compaction folded after the answer read "2 notices", and the reader had to
  // open two folds to learn the session was compacted.
  it('a compaction is named on the line, never counted as a notice', () => {
    expect(foldStepsPhrase([{ kind: 'notice', compact: 'cli' }])).toBe('Context compacted');
    expect(foldStepsPhrase([{ kind: 'notice', compact: 'idle' }, { kind: 'notice', compact: 'cli' }])).toBe('Compacted by Walnut while idle');
    expect(foldStepsPhrase([{ kind: 'notice', compact: 'cli' }, { kind: 'notice' }])).toBe('Context compacted \u00b7 1 notice');
    expect(foldStepsPhrase([{ kind: 'notice' }, { kind: 'notice' }])).toBe('2 notices');
    // Stopped halfway: Walnut's line stays a notice, and nothing says compacted.
    expect(foldStepsPhrase([{ kind: 'notice', compact: 'idle' }])).toBe('1 notice');
  });

  it('a run of runtime rows names a compaction only once it made its boundary', () => {
    const idle = { variant: 'info', message: 'Compacting this idle session (400K tokens) before its prompt cache expires in about 3 min' };
    const progress = { variant: 'compact', message: 'Compacting context...' };
    const done = { variant: 'compact', message: 'Context compacted', detail: '400K \u2192 18K tokens' };
    const error = { variant: 'error', message: 'API Error: 529 overloaded' };
    // 2026-11-04 review: the folded line read "2 system messages" while it ran, and hid the size.
    expect(systemRunLabel([idle, progress])).toBe('Compacting while idle');
    expect(systemRunLabel([error, progress])).toBe('Compacting context \u00b7 1 more');
    expect(systemRunLabel([idle, { variant: 'compact', message: 'Compaction stopped' }])).toBe('Compaction stopped');
    expect(systemRunLabel([idle, done])).toBe('Compacted by Walnut while idle \u00b7 400K \u2192 18K tokens');
    expect(systemRunLabel([error, done])).toBe('Context compacted \u00b7 400K \u2192 18K tokens \u00b7 1 more');
    expect(systemRunLabel([error, { variant: 'compact', message: 'Context compacted' }])).toBe('Context compacted \u00b7 1 more');
    expect(systemRunLabel([error, { variant: 'info', message: 'Retrying' }])).toBe('2 system messages');
  });

  // 2026-11-05 review: the recovery's compaction read "Context compacted · 178K → 18K · 1 more", its
  // reason one more fold down. Walnut's notice names the compaction, as the idle one does.
  it('Walnut\'s compaction for a conversation that no longer fit says so on its line', () => {
    const done = { variant: 'compact', message: 'Context compacted', detail: '178K \u2192 18K tokens' };
    const progress = { variant: 'compact', message: 'Compacting context...' };
    for (const message of [CONTEXT_COMPACT_HISTORY_TEXT, ...LEGACY_CONTEXT_COMPACT_HISTORY_TEXTS]) {
      const notice = { variant: 'info', message };
      expect(systemRunLabel([notice, done])).toBe('Compacted by Walnut to fit the context window \u00b7 178K \u2192 18K tokens');
      expect(systemRunLabel([notice, progress])).toBe('Compacting to fit the context window');
    }
    expect(systemRunLabel([{ variant: 'info', message: WALNUT_COMMAND_HISTORY_TEXT }, done])).toBe('Compacted by Walnut \u00b7 178K \u2192 18K tokens');
    // No boundary, an error instead: the line says it failed, never compacted.
    const failed = { variant: 'error', message: 'Error during compaction: API Error: 529 overloaded' };
    expect(systemRunLabel([{ variant: 'info', message: CONTEXT_COMPACT_HISTORY_TEXT }, failed])).toBe('Compaction failed');
    expect(systemRunLabel([failed, { variant: 'info', message: 'Retrying' }])).toBe('2 system messages');
    expect(foldStepsPhrase([{ kind: 'notice', compact: 'context' }, { kind: 'notice', compact: 'cli' }])).toBe('Compacted by Walnut to fit the context window');
    expect(foldStepsPhrase([{ kind: 'notice', compact: 'context' }])).toBe('1 notice');
  });

  it('a reloaded Walnut compaction that failed reads "Compaction failed", from the transcript to its line', () => {
    // 2026-11-05 review: only the absence of "compacted" was checked, never the line a reader sees.
    const base = { sessionId: 's', isSidechain: false, userType: 'external', entrypoint: 'sdk-cli', cwd: '/w' };
    const args = CONTEXT_COMPACT_TEXT.slice('/compact'.length).trim();
    const jsonl = [
      { type: 'user', uuid: 'u-1', parentUuid: null, timestamp: '2026-11-05T21:37:20.000Z', ...base, message: { role: 'user', content: 'hi' } },
      { type: 'assistant', uuid: 'a-1', parentUuid: 'u-1', timestamp: '2026-11-05T21:37:21.000Z', ...base, message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Prompt is too long' }] } },
      { type: 'user', uuid: 'c-1', parentUuid: 'a-1', timestamp: '2026-11-05T21:37:29.549Z', ...base, message: { role: 'user', content: `<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>${args}</command-args>` } },
      // How Claude Code files a failed local command (the mock CLI's failed-compact-command, same shape).
      { type: 'system', subtype: 'local_command', uuid: 'o-1', parentUuid: 'c-1', timestamp: '2026-11-05T21:37:34.634Z', ...base, content: '<local-command-stderr>Error during compaction: API Error: 400 Input is too long.</local-command-stderr>', commandRun: { command: 'compact', args }, commandOutcome: { kind: 'failed' } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n';
    const rows = parseSessionMessages(jsonl);
    const at = rows.findIndex((r) => r.role === 'system' && r.text === CONTEXT_COMPACT_HISTORY_TEXT);
    expect(at).toBeGreaterThan(-1);
    const run = [];
    for (let k = at; k < rows.length && rows[k]!.role === 'system'; k++) run.push({ variant: rows[k]!.systemVariant ?? 'info', message: rows[k]!.text });
    expect(systemRunLabel(run)).toBe('Compaction failed');
  });

  it('a live compaction that failed says so, as the reloaded one does', () => {
    expect(systemRunLabel([{ variant: 'compact', message: 'Compacting context...' }, { variant: 'compact', message: 'Compaction failed', detail: 'API Error: 529 overloaded' }])).toBe('Compaction failed');
  });

  it('an opened run says the size once: the line has it when it names Walnut\'s compaction', () => {
    const done = { variant: 'compact', message: 'Context compacted', detail: '178K \u2192 18K tokens' };
    const notice = { variant: 'info', message: CONTEXT_COMPACT_HISTORY_TEXT };
    expect(systemRunShows([notice, done])).toEqual([notice]);
    // The CLI's own compaction, one with no size, or two of them: every row stays.
    const error = { variant: 'error', message: 'API Error: 529 overloaded' };
    expect(systemRunShows([error, done])).toEqual([error, done]);
    expect(systemRunShows([notice, { variant: 'compact', message: 'Context compacted' }])).toHaveLength(2);
    expect(systemRunShows([notice, done, done])).toHaveLength(3);
  });
});


describe('foldStepsPhrase counts calls by outcome', () => {
  const call = (id: string, extra: { result?: string; isError?: boolean } = {}): FoldStep => ({ kind: 'calls', tools: [{ name: 'Bash', input: { command: 'x' }, toolUseId: id, ...extra }] });
  it('a call held by an open prompt has not run, and the line leads with it; a denied one did not run either', () => {
    const waiting = new Set(['b'])
    expect(foldStepsPhrase([call('a', { result: 'ok' }), call('b'), call('c')], waiting)).toBe('Waiting for approval · Ran 1 tool')
    expect(foldStepsPhrase([call('a', { result: 'ok' }), call('b', { result: "The user doesn't want to proceed with this tool use.", isError: true })])).toBe('Ran 1 tool · Denied 1 tool')
    // No prompt open: a call without a result is still running, and counts as one that runs.
    expect(foldStepsPhrase([call('a'), call('b', { result: 'ok' })])).toBe('Ran 2 tools')
  })
})
