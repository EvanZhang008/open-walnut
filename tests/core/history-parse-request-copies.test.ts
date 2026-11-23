/**
 * Request-copy lines (api-request-blob) are not JSON-parsed (src/core/history-parse.ts
 * isRequestCopyLine): a stub with only their type takes their place.
 *
 * 2026-11-23: in a long session they were three quarters of the bytes each history read
 * parsed, and their parse was most of the garbage behind the server's memory peaks. Rows must
 * be exactly what the full parse gave: the copies carry a role and whole request messages (tool
 * results included), and the parser's windows count lines (PATTERN_A_LOOKAHEAD), so a copy left
 * out instead of stubbed moved which enqueue found its twin. The oracle is the same transcript
 * with every copy written with another key order: those lines are parsed whole, as before.
 */
import { describe, it, expect, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { parseSessionMessages } from '../../src/core/session-history.js';
import { isRequestCopyLine } from '../../src/core/history-parse.js';

const sid = 'sess-copies';
const at = (s: number) => new Date(Date.UTC(2026, 10, 23, 10, 0, s)).toISOString();
const line = (o: object) => JSON.stringify(o);

// Real key order: the CLI writes `type` first on these lines.
let n = 0;
const blob = (role: 'user' | 'assistant', content: unknown) =>
  `{"type":"api-request-blob","sessionId":"${sid}","hash":"h${n++}","message":${JSON.stringify({ role, content })}}`;
/** The oracle: the same line, `type` second, so it is parsed whole as before the change. */
const parsedWhole = (text: string) => text.split('\n').map((l) => (isRequestCopyLine(l)
  ? `{"sessionId":"${sid}",${l.slice(1).replace(`,"sessionId":"${sid}"`, '')}` : l)).join('\n');
const shape = `{"type":"api-request-shape","sessionId":"${sid}","timestamp":"${at(0)}","version":"2.1.322","shapeHash":"s","shape":{"system":["x"]}}`;
const request = line({ type: 'api-request', sessionId: sid, id: 'r1', timestamp: at(1), version: '2.1.322', params: { model: 'm' }, keep: 0, tail: [] });

function transcript(): string {
  const rows: string[] = [shape];
  rows.push(line({ type: 'user', uuid: 'u1', parentUuid: null, sessionId: sid, timestamp: at(2), version: '2.1.322', message: { role: 'user', content: 'list the files' } }));
  rows.push(blob('user', [{ type: 'text', text: 'CLAUDE.md contents merged in\nlist the files' }]), request);
  rows.push(line({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: sid, timestamp: at(3), message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } }));
  // A copy between a tool call and its result, carrying that result.
  rows.push(blob('user', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'COPY OF THE RESULT' }]));
  rows.push(line({ type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId: sid, timestamp: at(4), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'a.txt\nb.txt' }] } }));
  rows.push(blob('assistant', [{ type: 'text', text: 'an earlier answer, as sent back' }]), shape);
  rows.push(line({ type: 'queue-operation', operation: 'enqueue', sessionId: sid, timestamp: at(5), content: 'and the sizes?' }));
  rows.push(blob('user', 'and the sizes?'));
  rows.push(line({ type: 'assistant', uuid: 'a2', parentUuid: 'u2', sessionId: sid, timestamp: at(6), message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Two files: a.txt and b.txt.' }] } }));
  rows.push(line({ type: 'queue-operation', operation: 'dequeue', sessionId: sid, timestamp: at(7) }));
  rows.push(line({ type: 'user', uuid: 'u3', parentUuid: 'a2', sessionId: sid, timestamp: at(8), message: { role: 'user', content: 'and the sizes?' } }));
  rows.push(blob('user', [{ type: 'text', text: 'and the sizes?' }]));
  rows.push(line({ type: 'assistant', uuid: 'a3', parentUuid: 'u3', sessionId: sid, timestamp: at(9), message: { id: 'm3', role: 'assistant', content: [{ type: 'text', text: 'Both are empty.' }] } }));
  return rows.join('\n') + '\n';
}

/** An enqueue whose user twin sits 61 lines later: 30 tool lines and 30 copies in between. */
function farTwin(): string {
  const rows: string[] = [line({ type: 'user', uuid: 'u0', parentUuid: null, sessionId: sid, timestamp: at(0), message: { role: 'user', content: 'start' } })];
  rows.push(line({ type: 'queue-operation', operation: 'enqueue', sessionId: sid, timestamp: at(1), content: 'continue' }));
  let parent = 'u0';
  for (let i = 0; i < 15; i++) {
    rows.push(line({ type: 'assistant', uuid: `a${i}`, parentUuid: parent, sessionId: sid, timestamp: at(2 + i), message: { id: `m${i}`, role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: 'true' } }] } }));
    rows.push(blob('user', [{ type: 'text', text: 'continue' }]));
    rows.push(line({ type: 'user', uuid: `r${i}`, parentUuid: `a${i}`, sessionId: sid, timestamp: at(2 + i), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }] } }));
    rows.push(blob('assistant', [{ type: 'text', text: 'context' }]));
    parent = `r${i}`;
  }
  rows.push(line({ type: 'queue-operation', operation: 'dequeue', sessionId: sid, timestamp: at(20) }));
  rows.push(line({ type: 'user', uuid: 'u9', parentUuid: parent, sessionId: sid, timestamp: at(21), message: { role: 'user', content: 'continue' } }));
  return rows.join('\n') + '\n';
}

describe('request-copy lines', () => {
  it('are named by their first bytes, as the CLI writes them', () => {
    expect(isRequestCopyLine(blob('user', 'x'))).toBe(true);
    expect(isRequestCopyLine(shape)).toBe(false);
    expect(isRequestCopyLine(request)).toBe(false);
    expect(isRequestCopyLine(line({ type: 'user', message: { role: 'user', content: 'api-request-blob' } }))).toBe(false);
    expect(isRequestCopyLine(parsedWhole(blob('user', 'x')))).toBe(false);
  });

  it('give exactly the rows of the full parse, windows that count lines included', () => {
    for (const text of [transcript(), farTwin()]) {
      const full = parseSessionMessages(parsedWhole(text));
      expect(full.length).toBeGreaterThan(1);
      expect(JSON.stringify(parseSessionMessages(text))).toBe(JSON.stringify(full));
      expect(JSON.stringify(parseSessionMessages(text, { chainFilter: 'auto' }))).toBe(JSON.stringify(parseSessionMessages(parsedWhole(text), { chainFilter: 'auto' })));
    }
  });

  it('are never handed to JSON.parse', () => {
    const spy = vi.spyOn(JSON, 'parse');
    try {
      parseSessionMessages(transcript());
      expect(spy.mock.calls.some((c) => typeof c[0] === 'string' && isRequestCopyLine(c[0] as string))).toBe(false);
      expect(spy.mock.calls.some((c) => typeof c[0] === 'string' && (c[0] as string).startsWith('{"type":"user"'))).toBe(true);
    } finally { spy.mockRestore(); }
  });

  it('a copy written with another key order still never shows as a row', () => {
    const rows = parseSessionMessages(parsedWhole(transcript()));
    expect(rows.some((m) => m.text?.includes('COPY OF THE RESULT') || m.text?.includes('merged in'))).toBe(false);
  });
});
