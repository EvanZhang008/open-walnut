/**
 * An Ask here question names its thread id and name in its send, and its answer must sit in a tag
 * with the same id and name (2026-11-03, the user: "we must make it strict ... the thread-id and
 * thread name in a html tag format, in the first send"; "each question has a thread id and thread
 * name, and they must match, each ask from us in that thread also remind model about this, the
 * thread can be nested"). A turn that ends with one still answered outside its tag is held by the
 * Stop hook, which reads the ids from the session's own transcript.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { askHintText, askNameOf, ASK_THREAD_RE } from '../../../src/core/sessions/ask-thread.js';
import { askStopReason, asksToName, parseThreadList, withAskSent, ASKS_SENT_MAX } from '../../../src/core/sessions/ask-unanswered.js';
import { STOP_UNANSWERED_HOOK_COMMAND } from '../../../src/providers/stop-unanswered-hook.js';
import { effectiveHints } from '../../../src/core/hints/hint-registry.js';

const NOW = Date.parse('2026-11-03T10:00:00Z');

describe('the question hint names the thread and the tag its answer must sit in', () => {
  it('names id and name in both tags, for a nested id too', () => {
    const text = askHintText('6.1', 'guestbook deployer');
    expect(text).toContain('<walnut-ask thread="6.1" name="guestbook deployer">');
    expect(text).toContain('<walnut-ask-answer thread="6.1" name="guestbook deployer">');
    expect(text).toContain('</walnut-ask-answer>');
    expect(text).toMatch(/does not match is not filed/);
  });

  it('accepts nested ids and nothing else', () => {
    for (const ok of ['6', '6.1', '6.1.2', '12.3.4.5']) expect(ASK_THREAD_RE.test(ok), ok).toBe(true);
    for (const bad of ['', '6.', '.1', 'a', '6..1', '6,1', '6 1']) expect(ASK_THREAD_RE.test(bad), bad).toBe(false);
  });

  it('a name never carries a quote, an angle bracket or an ampersand, and is short', () => {
    expect(askNameOf({ title: 'a "b" <c> & d' })).toBe('a b c d');
    expect(askNameOf(undefined, 'x'.repeat(100)).length).toBe(60);
    expect(askNameOf({ question: 'from the words' })).toBe('from the words');
  });

  it('the registry renders it from the thread id; a follow-up keeps the name of the first send', () => {
    const hint = effectiveHints(null).find((h) => h.kind === 'question')!;
    const first = hint.render({ config: null, record: { threadMeta: [{ seq: 9, thread: '6.1', title: 'nested title' }] }, request: { arg: '6.1' } }, new Set(['on_request']));
    expect(first?.arg).toBe('6.1');
    expect(first?.text).toContain('<walnut-ask thread="6.1" name="nested title">');
    // The title was renamed later: the follow-up still names the thread as its first send did.
    const again = hint.render({
      config: null,
      record: { threadMeta: [{ seq: 9, thread: '6.1', title: 'renamed' }], asksSent: [{ thread: '6.1', name: 'nested title' }] },
      request: { arg: '6.1' },
    }, new Set(['on_request']));
    expect(again?.text).toContain('name="nested title"');
    // An old question with no path is named by its number.
    const old = hint.render({ config: null, record: { threadMeta: [{ seq: 4, title: 'four' }] }, request: { arg: '4' } }, new Set(['on_request']));
    expect(old?.text).toContain('<walnut-ask thread="4" name="four">');
    expect(hint.render({ config: null, record: null, request: { arg: 'x y' } }, new Set(['on_request']))).toBeNull();
  });
});

describe('the record keeps the questions sent', () => {
  it('a follow-up replaces its entry and keeps its first name; the list is bounded', () => {
    let list = withAskSent(undefined, { thread: '6', name: 'six', words: 'first   words', at: NOW });
    list = withAskSent(list, { thread: '6', name: 'other', words: 'follow-up', at: NOW + 1000 });
    expect(list).toEqual([{ thread: '6', name: 'six', preview: 'follow-up', at: new Date(NOW + 1000).toISOString() }]);
    for (let i = 0; i < ASKS_SENT_MAX + 5; i++) list = withAskSent(list, { thread: String(100 + i), name: 'n', words: 'w', at: NOW });
    expect(list).toHaveLength(ASKS_SENT_MAX);
  });
});

describe('which questions the Stop hook names', () => {
  const sent = [
    { thread: '6', name: 'six', preview: 'p6', at: new Date(NOW - 60_000).toISOString() },
    { thread: '6.1', name: 'nested', preview: 'p61', at: new Date(NOW - 60_000).toISOString() },
    { thread: '7', name: 'seven', preview: 'p7', at: new Date(NOW - 60_000).toISOString() },
    { thread: '2', name: 'old', preview: 'p2', at: new Date(NOW - 30 * 3600_000).toISOString() },
  ];

  it('asked and not answered in a tag, sent within a day; one not delivered yet is not named', () => {
    const open = asksToName(sent, new Set(['6', '6.1', '2']), new Set(['6.1']), NOW);
    expect(open.map((a) => a.thread)).toEqual(['6']);
  });

  it('the reason restates the tag with the id and the name', () => {
    const reason = askStopReason([sent[0], sent[2]], NOW);
    expect(reason).toContain('<walnut-ask thread="6" name="six">');
    expect(reason).toContain('<walnut-ask-answer thread="6" name="six">');
    expect(reason).toContain('each with its own thread id and name');
    expect(reason).toContain('"p7"');
  });

  it('reads the hook\'s lists; no list from an older hook', () => {
    expect(parseThreadList('6,6.1, 7,bad,')).toEqual(new Set(['6', '6.1', '7']));
    expect(parseThreadList('')).toEqual(new Set());
    expect(parseThreadList(undefined)).toBeNull();
  });
});

describe('the Stop hook reads the ids from the transcript on its own host', () => {
  function run(input: string, dir: string): string {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    // A walnut that answers a block with the arguments it got.
    fs.writeFileSync(path.join(bin, 'walnut'), '#!/bin/sh\nprintf \'{"decision":"block","args":%s}\\n\' "$4"\n', { mode: 0o755 });
    return execFileSync('sh', ['-c', STOP_UNANSWERED_HOOK_COMMAND], { input, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }).toString();
  }

  function withTranscript(lines: string[], body: (input: (extra?: object) => string, dir: string) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-hook-'));
    try {
      const transcript = path.join(dir, 't.jsonl');
      fs.writeFileSync(transcript, lines.join('\n') + '\n');
      body((extra = {}) => JSON.stringify({ transcript_path: transcript, stop_hook_active: false, ...extra }), dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const user = (text: string) => JSON.stringify({ type: 'user', message: { content: text } });
  const assistant = (text: string) => JSON.stringify({ parentUuid: 'a', type: 'assistant', message: { content: [{ type: 'text', text }] } });
  const argsOf = (out: string) => (out ? JSON.parse(out).args : null);

  it('open questions from user lines, answers from assistant text only, nested ids; nothing without a transcript; nothing on a continuation', () => {
    withTranscript([
      // The hint itself names the answer tag: a user line never counts as an answer.
      user(askHintText('6', 'six')),
      user(askHintText('6.1', 'nested')),
      user(askHintText('7', 'seven')),
      assistant('<walnut-ask-answer thread="6.1" name="nested">\nyes\n</walnut-ask-answer>'),
      // Thinking and a tool call that quote the tag are no answer.
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '<walnut-ask-answer thread="7" name="seven">' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', input: { command: 'echo \'<walnut-ask-answer thread="7" name="seven">\'' } }] } }),
    ], (input, dir) => {
      const args = argsOf(run(input(), dir));
      expect(args.hook).toBe('stop');
      expect(args.asked.split(',').sort()).toEqual(['6', '7']);
      expect(args.answered).toBe('6.1');
      expect(argsOf(run(JSON.stringify({ transcript_path: path.join(dir, 'none') }), dir))).toEqual({ hook: 'stop' });
      expect(run(input({ stop_hook_active: true }), dir)).toBe('');
    });
  });

  it('nothing open sends no lists, so an older server is asked as before', () => {
    withTranscript([
      user(askHintText('6', 'six')),
      assistant('<walnut-ask-answer name="Six" thread="6">\nyes\n</walnut-ask-answer>'),
    ], (input, dir) => {
      // Attributes in either order; the name compared without case.
      expect(argsOf(run(input(), dir))).toEqual({ hook: 'stop' });
    });
  });

  it('an answer counts only after the latest ask of its thread and only under its name', () => {
    withTranscript([
      user(askHintText('6', 'six')),
      assistant('<walnut-ask-answer thread="6" name="six">\nfirst\n</walnut-ask-answer>'),
      // A follow-up in the same thread: the first answer does not cover it.
      user(askHintText('6', 'six')),
      user(askHintText('8', 'eight')),
      assistant('<walnut-ask-answer thread="8" name="not eight">\nwrong name\n</walnut-ask-answer>'),
    ], (input, dir) => {
      const args = argsOf(run(input(), dir));
      expect(args.asked.split(',').sort()).toEqual(['6', '8']);
      expect(args.answered).toBe('');
    });
  });

  // 2026-11-07: the CLI ran the Stop hook before it wrote the turn's final answer to the
  // transcript, so a question answered inside its tag was named as open and answered twice.
  it('the turn\'s final text in the hook input counts as the newest answer, written to the transcript or not', () => {
    const answer = '<walnut-ask-answer thread="6" name="six">\nyes\n</walnut-ask-answer>';
    withTranscript([user(askHintText('6', 'six')), user(askHintText('7', 'seven'))], (input, dir) => {
      // Only 6 is answered, by the text the transcript does not hold yet.
      const args = argsOf(run(input({ hook_event_name: 'Stop', last_assistant_message: answer }), dir));
      expect(args.asked).toBe('7');
      expect(args.answered).toBe('6');
      // The same, as the CLI may print it: spaced, over several lines.
      const spaced = JSON.stringify(JSON.parse(input({ last_assistant_message: answer })), null, 2);
      expect(argsOf(run(spaced, dir)).answered).toBe('6');
      // Text outside the tag, or under another name, answers nothing.
      expect(argsOf(run(input({ last_assistant_message: 'yes' }), dir)).asked.split(',').sort()).toEqual(['6', '7']);
      expect(argsOf(run(input({ last_assistant_message: answer.replace('six', 'other') }), dir)).answered).toBe('');
    });
    withTranscript([user(askHintText('6', 'six'))], (input, dir) => {
      expect(argsOf(run(input({ last_assistant_message: answer }), dir))).toEqual({ hook: 'stop' });
    });
  });

  it('a tool result quoting the ask tag is no ask', () => {
    withTranscript([
      user(askHintText('6', 'six')),
      assistant('<walnut-ask-answer thread="6" name="six">\nyes\n</walnut-ask-answer>'),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '<walnut-ask thread="6" name="six">' }] } }),
    ], (input, dir) => {
      expect(argsOf(run(input(), dir))).toEqual({ hook: 'stop' });
    });
  });

  it('an older server that refuses the lists is asked again without them', () => {
    withTranscript([user(askHintText('6', 'six'))], (input, dir) => {
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, 'walnut'), '#!/bin/sh\ncase "$4" in *asked*) echo \'{"error":"Unrecognized key: asked"}\';; *) printf \'{"decision":"block","args":%s}\\n\' "$4";; esac\n', { mode: 0o755 });
      const out = execFileSync('sh', ['-c', STOP_UNANSWERED_HOOK_COMMAND], { input: input(), env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }).toString();
      expect(argsOf(out)).toEqual({ hook: 'stop' });
    });
  });
});

// The class of 2026-11-07's double answer: a Stop hook that reads the turn from the transcript
// runs before the CLI wrote the turn's final message there. Every Walnut hook module that reads
// the transcript in a Stop hook also reads the input's own copy of that message.
describe('every Stop hook that reads the transcript also reads the turn\'s final text', () => {
  it('holds for each hook module in src/providers', () => {
    const dir = path.join(__dirname, '../../../src/providers');
    const readers = fs.readdirSync(dir).filter((f) => f.endsWith('-hook.ts')).filter((f) => {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      return /\bStop:/.test(src) && src.includes('transcript_path');
    });
    expect(readers).toContain('stop-unanswered-hook.ts');
    for (const f of readers) {
      expect(fs.readFileSync(path.join(dir, f), 'utf8'), `${f} reads the transcript at Stop`).toMatch(/walnut-stop-input|last_assistant_message/);
    }
  });
});

