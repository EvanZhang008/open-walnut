/**
 * Format canary for Claude Code transcripts (src/core/transcript-line-types.ts).
 *
 * Claude Code 2.1.284 added `api-request-blob` lines to its transcript and the
 * history parser showed them as conversation rows; nothing in Walnut noticed a
 * new line kind until the user did (2026-10-28). The parser now warns once per
 * process about any line type or message content block type it does not know.
 *
 * REAL_* below are the distinct `type` values collected with jq from recent
 * local 2.1.284 transcripts and daemon stream files (type names only, no
 * content). When a CLI upgrade adds one, this file's canary test is the place
 * that says so: handle the kind in the parser, then add it to the known list.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { log } from '../../src/logging/index.js';
import { parseSessionMessages } from '../../src/core/session-history.js';
import {
  KNOWN_MESSAGE_BLOCK_TYPES,
  KNOWN_TRANSCRIPT_LINE_TYPES,
  _resetTranscriptCanaryForTesting,
} from '../../src/core/transcript-line-types.js';

/** Canonical transcript line types (~/.claude/projects/*.jsonl, CLI 2.1.284). */
const REAL_TRANSCRIPT_TYPES = [
  'user', 'assistant', 'system', 'attachment', 'queue-operation', 'last-prompt',
  'mode', 'atis-latch', 'permission-mode', 'ai-title', 'agent-name',
  'file-history-snapshot', 'file-history-delta', 'pr-link', 'cost-state',
  'api-request-blob', 'api-request-shape',
];
/** stream-json stdout line types (daemon stream files, CLI 2.1.284). */
const REAL_STREAM_TYPES = [
  'stream_event', 'system', 'assistant', 'user', 'control_response', 'control_request',
  'tool_progress', 'command_lifecycle', 'result',
];
/** user/assistant `message.content[].type` values in the same files. */
const REAL_BLOCK_TYPES = ['text', 'thinking', 'tool_use', 'tool_result', 'image'];

const SID = 'canary-sid';
const VERSION = '2.1.284';
const line = (o: Record<string, unknown>): string => JSON.stringify(o);

const seed = [
  line({ type: 'user', uuid: 'u1', parentUuid: null, sessionId: SID, version: VERSION, timestamp: '2026-10-28T10:00:00.000Z', message: { role: 'user', content: 'hello' } }),
  line({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: SID, version: VERSION, timestamp: '2026-10-28T10:00:01.000Z', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'hi there' }] } }),
];
const join = (ls: string[]): string => ls.join('\n') + '\n';

let warns: Array<[string, Record<string, unknown>]>;

beforeEach(() => {
  _resetTranscriptCanaryForTesting();
  warns = [];
  vi.spyOn(log.session, 'warn').mockImplementation((msg: string, data?: Record<string, unknown>) => {
    warns.push([msg, data ?? {}]);
  });
});
afterEach(() => { vi.restoreAllMocks(); });

const canaryWarns = () => warns.filter(([m]) => m.includes('the CLI format may have changed'));

describe('transcript format canary', () => {
  it('warns once about a line type it does not know, with the type, CLI version and session', () => {
    const unknown = line({ type: 'made-up-kind', sessionId: SID, payload: { x: 1 } });
    parseSessionMessages(join([seed[0]!, unknown, seed[1]!, unknown]));
    parseSessionMessages(join([unknown]));
    expect(canaryWarns()).toHaveLength(1);
    expect(canaryWarns()[0]![1]).toEqual({ kind: 'line', type: 'made-up-kind', cliVersion: VERSION, sessionId: SID });
  });

  it('warns once per distinct unknown type', () => {
    parseSessionMessages(join([...seed, line({ type: 'kind-a' }), line({ type: 'kind-b' }), line({ type: 'kind-a' })]));
    expect(canaryWarns().map(([, d]) => d.type)).toEqual(['kind-a', 'kind-b']);
  });

  it('warns once about an unknown content block type on a user or assistant line', () => {
    const odd = (id: string) => line({ type: 'assistant', uuid: id, sessionId: SID, version: VERSION, timestamp: '2026-10-28T10:00:02.000Z', message: { id: `msg_${id}`, role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'made_up_block', data: 1 }] } });
    parseSessionMessages(join([...seed, odd('a2'), odd('a3')]));
    expect(canaryWarns()).toHaveLength(1);
    expect(canaryWarns()[0]![1]).toEqual({ kind: 'block', type: 'made_up_block', cliVersion: VERSION, sessionId: SID });
  });

  it('does not change what the parser outputs', () => {
    const unknown = line({ type: 'made-up-kind', sessionId: SID, message: { role: 'user', content: 'not a row' } });
    const plain = parseSessionMessages(join(seed));
    const withUnknown = parseSessionMessages(join([seed[0]!, unknown, seed[1]!]));
    expect(withUnknown).toEqual(plain);
    expect(canaryWarns()).toHaveLength(1);
  });

  it('says nothing about a line with no type (an older capture)', () => {
    parseSessionMessages(join([line({ uuid: 'o1', timestamp: '2026-01-01T00:00:00.000Z', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'old row' }] } })]));
    expect(canaryWarns()).toHaveLength(0);
  });
});

describe('known types pinned against real CLI output', () => {
  it('every line type in current transcripts and stream files is known', () => {
    const missing = [...REAL_TRANSCRIPT_TYPES, ...REAL_STREAM_TYPES].filter((t) => !KNOWN_TRANSCRIPT_LINE_TYPES.has(t));
    expect(missing).toEqual([]);
    const missingBlocks = REAL_BLOCK_TYPES.filter((t) => !KNOWN_MESSAGE_BLOCK_TYPES.has(t));
    expect(missingBlocks).toEqual([]);
  });

  it('a transcript holding one line of every real type parses without a warning', () => {
    const lines = [...new Set([...REAL_TRANSCRIPT_TYPES, ...REAL_STREAM_TYPES])].map((type, i) =>
      line({ type, uuid: `l${i}`, sessionId: SID, version: VERSION, timestamp: '2026-10-28T10:00:00.000Z' }));
    const blocks = REAL_BLOCK_TYPES.map((type, i) => ({ type, ...(type === 'text' ? { text: `t${i}` } : {}) }));
    lines.push(line({ type: 'assistant', uuid: 'ab', sessionId: SID, version: VERSION, timestamp: '2026-10-28T10:00:03.000Z', message: { id: 'msg_b', role: 'assistant', content: blocks } }));
    parseSessionMessages(join([...seed, ...lines]));
    expect(canaryWarns()).toEqual([]);
  });
});
