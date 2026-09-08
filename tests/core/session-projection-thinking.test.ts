/**
 * Transcript projection: `kind:'thinking'` rows, `inputPreview`, and the tail budget.
 *
 * `ProjectedTranscriptMessage.kind` has declared `'thinking'` — and the api-v1 doc has
 * promised those rows — since the shape was written, while NOBODY produced one: the
 * builder only iterated `m.tools` and `m.text`. So the phone had no reasoning to render
 * at all and fell back to a bare blinking "Thinking…". Same story one field over: a
 * `Bash` call's `detail` prefers the human `description`, so the COMMAND was on no
 * surface the phone could reach at any expansion level.
 *
 * Everything here goes through the REAL builder over a REAL fixture JSONL (parsed by
 * the real session-history reader), because the thing under test is precisely whether
 * the parse output reaches a row — a hand-built message array would assume it.
 *
 * The tail-budget claim these cases pin: TRANSCRIPT_TAIL slices `history`, i.e. source
 * MESSAGES, BEFORE the loop expands each into rows. Extra kind rows therefore cannot
 * crowd a real message out of any caller's tail (a message with 3 tool calls has always
 * produced 4 rows). What the slim path cannot afford is BYTES — it is pushed to the
 * cloud under a 1 MB frame cap and polled while a session view is open — so the two fat
 * expanded-card fields ride `full` reads only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-projection-thinking'));
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

const CWD = '/tmp/marina/workspace';

// The builder asks the tracker where the session lives; the JSONL itself is real.
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: async (id: string) => ({
    claudeSessionId: id,
    cwd: CWD,
    process_status: 'idle',
    startedAt: '2026-01-01T00:00:00Z',
    lastActiveAt: '2026-01-01T00:00:00Z',
  }),
}));

import { CLAUDE_HOME } from '../../src/constants.js';
import { encodeProjectPath } from '../../src/core/session-history.js';
import { buildSessionTranscript } from '../../src/core/session-projection.js';

const tmpBase = path.dirname(CLAUDE_HOME);

beforeEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true });
  await fsp.mkdir(tmpBase, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
});

async function writeJsonl(sessionId: string, lines: unknown[]): Promise<void> {
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
}

let seq = 0;
function at(): string {
  return `2026-01-01T00:00:${String(seq++).padStart(2, '0')}.000Z`;
}

function userLine(text: string): unknown {
  return { type: 'user', timestamp: at(), message: { role: 'user', content: [{ type: 'text', text }] } };
}

function assistantLine(id: string, blocks: unknown[]): unknown {
  return { type: 'assistant', timestamp: at(), message: { id, role: 'assistant', content: blocks } };
}

function toolResultLine(toolUseId: string, content: string): unknown {
  return {
    type: 'user', timestamp: at(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
  };
}

beforeEach(() => { seq = 0; });

describe('kind:"thinking" rows', () => {
  it('yields exactly one row per thinking block, collapsed to <=160 with a capped fuller excerpt', async () => {
    // Long enough that BOTH caps bite: >160 for the line, >2000 for the excerpt.
    const reasoning = 'Step one, read the config.\nStep two, ' + 'reason at length. '.repeat(300);
    await writeJsonl('sess-think', [
      userLine('why is the build red?'),
      assistantLine('msg_a', [
        { type: 'thinking', thinking: reasoning },
        { type: 'text', text: 'The build is red because of a stale lockfile.' },
      ]),
    ]);

    const t = await buildSessionTranscript('sess-think', { full: true });
    const thinking = t.messages.filter((m) => m.kind === 'thinking');
    expect(thinking).toHaveLength(1);
    expect(thinking[0].role).toBe('assistant');

    // The documented collapsed cap, ellipsis included, and folded onto one line.
    expect(thinking[0].text.length).toBeLessThanOrEqual(161);
    expect(thinking[0].text).not.toContain('\n');
    expect(thinking[0].text.startsWith('Step one, read the config. Step two,')).toBe(true);

    // The additive fuller excerpt, capped at 2000 (+1 for the ellipsis).
    expect(thinking[0].thinkingText).toBeDefined();
    expect(thinking[0].thinkingText!.length).toBeLessThanOrEqual(2001);
    expect(thinking[0].thinkingText!.length).toBeGreaterThan(1000);
    // Newlines are KEPT here — reasoning is paragraphs, not a one-liner.
    expect(thinking[0].thinkingText).toContain('\n');

    // The row lands BEFORE the answer it produced (thinking → tool → text).
    const order = t.messages.map((m) => m.kind ?? 'text');
    expect(order).toEqual(['text', 'thinking', 'text']); // the user's question, then the turn
  });

  it('a short thinking block is carried whole, in both fields', async () => {
    await writeJsonl('sess-short', [
      userLine('hi'),
      assistantLine('msg_a', [
        { type: 'thinking', thinking: 'Simple greeting.' },
        { type: 'text', text: 'Hello!' },
      ]),
    ]);
    const t = await buildSessionTranscript('sess-short', { full: true });
    const thinking = t.messages.find((m) => m.kind === 'thinking')!;
    expect(thinking.text).toBe('Simple greeting.');
    expect(thinking.thinkingText).toBe('Simple greeting.');
  });

  it('a message with no thinking block produces no thinking row', async () => {
    await writeJsonl('sess-none', [
      userLine('hi'),
      assistantLine('msg_a', [{ type: 'text', text: 'Hello!' }]),
    ]);
    const t = await buildSessionTranscript('sess-none', { full: true });
    expect(t.messages.some((m) => m.kind === 'thinking')).toBe(false);
  });

  it('orders thinking before the tool calls of the same message', async () => {
    await writeJsonl('sess-order', [
      userLine('check the docs'),
      assistantLine('msg_a', [
        { type: 'thinking', thinking: 'I will grep first.' },
        { type: 'tool_use', id: 'toolu_1', name: 'Grep', input: { pattern: 'TODO' } },
        { type: 'text', text: 'Found three.' },
      ]),
      toolResultLine('toolu_1', 'a.md:1:TODO'),
    ]);
    const t = await buildSessionTranscript('sess-order', { full: true });
    expect(t.messages.map((m) => m.kind ?? 'text')).toEqual(['text', 'thinking', 'tool', 'text']);
  });
});

describe('tail budget', () => {
  it('the slim tail caps source MESSAGES, so thinking rows displace nothing', async () => {
    // 120 assistant messages, each with a thinking block AND a tool call — i.e. the
    // shape that would "crowd out" real messages if the cap counted ROWS.
    const lines: unknown[] = [userLine('start')];
    for (let i = 0; i < 120; i++) {
      lines.push(assistantLine(`msg_${i}`, [
        { type: 'thinking', thinking: `reasoning ${i}` },
        { type: 'tool_use', id: `toolu_${i}`, name: 'Read', input: { file_path: `/tmp/marina/f${i}.ts` } },
        { type: 'text', text: `answer ${i}` },
      ]));
      lines.push(toolResultLine(`toolu_${i}`, `body ${i}`));
    }
    await writeJsonl('sess-budget', lines);

    const slim = await buildSessionTranscript('sess-budget');
    const texts = slim.messages.filter((m) => !m.kind).map((m) => m.text);
    // 100 SOURCE messages survive the tail, and every one of them still contributes
    // its prose row: the newest answer is present and so are 49 more before it.
    expect(texts).toContain('answer 119');
    expect(texts.length).toBeGreaterThanOrEqual(50);
    // ...alongside the new thinking rows, which is the whole claim.
    expect(slim.messages.filter((m) => m.kind === 'thinking').length).toBeGreaterThanOrEqual(49);
    expect(slim.truncated).toBe(true);

    // And a `full` read still reaches message 0 — no cap at all.
    const full = await buildSessionTranscript('sess-budget', { full: true });
    expect(full.messages.filter((m) => !m.kind).map((m) => m.text)).toContain('answer 0');
    expect(full.truncated).toBe(false);
  });

  it('keeps the fat expanded-card fields OFF the slim tail (it rides a 1MB bridge frame)', async () => {
    await writeJsonl('sess-slim', [
      userLine('run it'),
      assistantLine('msg_a', [
        { type: 'thinking', thinking: 'x'.repeat(5000) },
        { type: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: '/tmp/marina/big.ts', content: 'y'.repeat(50_000) } },
      ]),
      toolResultLine('toolu_1', 'written'),
    ]);

    const slim = await buildSessionTranscript('sess-slim');
    const slimThinking = slim.messages.find((m) => m.kind === 'thinking')!;
    const slimTool = slim.messages.find((m) => m.kind === 'tool')!;
    // The collapsed rows are there (the phone can SEE both), the fat fields are not.
    expect(slimThinking.text.length).toBeLessThanOrEqual(161);
    expect(slimThinking.thinkingText).toBeUndefined();
    expect(slimTool.text).toBe('Write');
    expect(slimTool.detail).toBe('/tmp/marina/big.ts');
    expect(slimTool.inputPreview).toBeUndefined();
    // A 50KB file body must not reach a payload that is pushed under a 1MB cap.
    expect(JSON.stringify(slim).length).toBeLessThan(10_000);

    // The `full` read — the one the mobile CHAT uses — carries both, capped.
    const full = await buildSessionTranscript('sess-slim', { full: true });
    const fullThinking = full.messages.find((m) => m.kind === 'thinking')!;
    const fullTool = full.messages.find((m) => m.kind === 'tool')!;
    expect(fullThinking.thinkingText!.length).toBeLessThanOrEqual(2001);
    expect(fullTool.inputPreview).toBeDefined();
    expect(fullTool.inputPreview!.length).toBeLessThanOrEqual(2001);
    expect(fullTool.inputPreview).toContain('file_path: /tmp/marina/big.ts');
    // `detail` is untouched by any of this — web depends on that ≤160 line.
    expect(fullTool.detail).toBe('/tmp/marina/big.ts');
  });
});

describe('inputPreview on the full read', () => {
  it("carries the Bash COMMAND that `detail` never had, and leaves `detail` alone", async () => {
    await writeJsonl('sess-bash', [
      userLine('list the docs'),
      assistantLine('msg_a', [
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la docs/', description: 'List docs' } },
      ]),
      toolResultLine('toolu_1', 'a.md\nb.md'),
    ]);
    const t = await buildSessionTranscript('sess-bash', { full: true });
    const tool = t.messages.find((m) => m.kind === 'tool')!;
    // Byte-identical to what shipped before this change (TOOL_DETAIL_KEYS.Bash
    // prefers `description`) — reordering it would change a documented field.
    expect(tool.detail).toBe('List docs');
    // ...and the command is now reachable, which it was not at ANY expansion level.
    expect(tool.inputPreview).toBe('command: ls -la docs/\ndescription: List docs');
  });

  it('masks a secret in a command line', async () => {
    await writeJsonl('sess-secret', [
      userLine('deploy'),
      assistantLine('msg_a', [
        {
          type: 'tool_use', id: 'toolu_1', name: 'Bash',
          input: { command: 'curl -H "Authorization: Bearer abc123supersecrettoken" https://example.test/api' },
        },
      ]),
    ]);
    const t = await buildSessionTranscript('sess-secret', { full: true });
    const tool = t.messages.find((m) => m.kind === 'tool')!;
    expect(tool.inputPreview).toContain('[REDACTED]');
    expect(tool.inputPreview).not.toContain('abc123supersecrettoken');
  });

  it('is absent when the input has nothing renderable', async () => {
    await writeJsonl('sess-empty', [
      userLine('go'),
      assistantLine('msg_a', [{ type: 'tool_use', id: 'toolu_1', name: 'Mystery', input: {} }]),
    ]);
    const t = await buildSessionTranscript('sess-empty', { full: true });
    const tool = t.messages.find((m) => m.kind === 'tool')!;
    expect(tool.inputPreview).toBeUndefined();
    expect(tool.detail).toBeUndefined();
  });
});

/**
 * All THREE preview fields go through one masking rule (tool-summary maskPreview).
 * `detail` is the frozen one: still ≤160, still one line, still taken from the same
 * key — only a value the masker matches changes. Two of three masked and the third
 * documented as a known hole is the shape that becomes a bug report.
 */
describe('detail redaction (the frozen field)', () => {
  it('masks a secret embedded in a description, and keeps the shape', async () => {
    // Bash's `detail` comes from `description` (TOOL_DETAIL_KEYS, not reordered),
    // so a model that narrates its own command is what puts the secret here.
    await writeJsonl('sess-detail-secret', [
      userLine('deploy it'),
      assistantLine('msg_a', [{
        type: 'tool_use', id: 'toolu_1', name: 'Bash',
        input: { description: 'Deploy using api_key=liveKeyValue123456', command: 'deploy.sh' },
      }]),
    ]);
    const t = await buildSessionTranscript('sess-detail-secret', { full: true });
    const tool = t.messages.find((m) => m.kind === 'tool')!;

    expect(tool.detail).toBe('Deploy using api_key=[REDACTED]');
    expect(tool.detail).not.toContain('liveKeyValue123456');
    // Frozen shape: one line, inside the documented cap, still the `description`
    // key rather than `command` (the preference order is untouched).
    expect(tool.detail).not.toContain('\n');
    expect(tool.detail!.length).toBeLessThanOrEqual(161);
    expect(tool.detail!.startsWith('Deploy using')).toBe(true);
    // The command still rides inputPreview, masked by the same rule.
    expect(tool.inputPreview).toContain('command: deploy.sh');
    expect(tool.inputPreview).toContain('[REDACTED]');
  });

  it('clips to 160 AFTER masking, because a mask can GROW the text', async () => {
    // Deliberately sized so the ORDER is the only thing that can produce the
    // result: two SHORT secret values, so each mask is longer than what it
    // replaces. Unmasked the line is 153 chars and would never be clipped; masked
    // it is 165 and must be. Clip-then-mask would leave the text un-clipped AND
    // still carrying the second value.
    const desc = 'x'.repeat(130) + ' token=zqx7 secret=vbn9';
    expect(desc.length).toBe(153);
    await writeJsonl('sess-detail-grow', [
      userLine('go'),
      assistantLine('msg_a', [{
        type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { description: desc, command: 'go.sh' },
      }]),
    ]);
    const t = await buildSessionTranscript('sess-detail-grow', { full: true });
    const detail = t.messages.find((m) => m.kind === 'tool')!.detail!;
    expect(detail).not.toContain('zqx7');
    expect(detail).not.toContain('vbn9');
    expect(detail).toContain('token=[REDACTED]'); // the mask ran before the cut
    expect(detail.endsWith('…')).toBe(true);      // ...and the growth was then cut
    expect(detail.slice(0, -1).length).toBe(160);
  });

  it('leaves ordinary descriptions and paths byte-identical', async () => {
    await writeJsonl('sess-detail-plain', [
      userLine('look'),
      assistantLine('msg_a', [
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { description: 'List docs', command: 'ls docs/' } },
        { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/tmp/marina/report.md' } },
      ]),
    ]);
    const t = await buildSessionTranscript('sess-detail-plain', { full: true });
    const tools = t.messages.filter((m) => m.kind === 'tool');
    expect(tools[0].detail).toBe('List docs');
    expect(tools[1].detail).toBe('/tmp/marina/report.md');
  });
});

/**
 * A tool's OUTPUT leaks as readily as its input (`cat .env`, an `aws configure`
 * echo, a curl that prints the request it sent), and unlike the two fields above
 * `resultPreview` has always shipped on BOTH paths — including the copy pushed to
 * the cloud replica. So the mask is unconditional.
 */
describe('resultPreview redaction', () => {
  it('masks a secret a tool echoed back, on the full AND the slim path', async () => {
    await writeJsonl('sess-out-secret', [
      userLine('show the env'),
      assistantLine('msg_a', [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'cat .env' } }]),
      toolResultLine('toolu_1', 'HOME=/tmp/marina\nAPI_KEY=liveKeyValue123456\nDEBUG=1'),
    ]);

    for (const opts of [{ full: true }, undefined]) {
      const t = await buildSessionTranscript('sess-out-secret', opts);
      const row = t.messages.find((m) => m.kind === 'tool')!;
      expect(row.resultPreview).toContain('[REDACTED]');
      expect(row.resultPreview).not.toContain('liveKeyValue123456');
      // Non-secret lines around it survive — this is a mask, not a drop.
      expect(row.resultPreview).toContain('DEBUG=1');
      // The cap still holds AFTER masking, which is why redaction runs first: a
      // mask can GROW the text ("API_KEY=x" is shorter than "API_KEY=[REDACTED]").
      expect(row.resultPreview!.length).toBeLessThanOrEqual(701);
    }
  });

  it('cuts a private key whose END marker sits past the redaction window', async () => {
    // The one secret shape longer than the window the masker gets to see, so the
    // block pattern cannot match and a naive window would ship the key's head.
    await writeJsonl('sess-pem', [
      userLine('read the key'),
      assistantLine('msg_a', [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/marina/key.pem' } }]),
      toolResultLine('toolu_1', 'reading…\n-----BEGIN RSA PRIVATE KEY-----\n' + 'MIIEow'.repeat(600) + '\n-----END RSA PRIVATE KEY-----'),
    ]);
    const t = await buildSessionTranscript('sess-pem', { full: true });
    const row = t.messages.find((m) => m.kind === 'tool')!;
    expect(row.resultPreview).toBe('reading…\n[REDACTED]');
    expect(row.resultPreview).not.toContain('MIIEow');
  });

  it('leaves ordinary output byte-identical', async () => {
    await writeJsonl('sess-plain-out', [
      userLine('list'),
      assistantLine('msg_a', [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }]),
      toolResultLine('toolu_1', 'a.md\nb.md\nREADME.md'),
    ]);
    const t = await buildSessionTranscript('sess-plain-out', { full: true });
    expect(t.messages.find((m) => m.kind === 'tool')!.resultPreview).toBe('a.md\nb.md\nREADME.md');
  });
});
