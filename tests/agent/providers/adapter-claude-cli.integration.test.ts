/**
 * Integration test — spawns a FAKE `claude` binary through the real adapter
 * run() path, proving the full chain: spawn → stream-json parse → onTextDelta →
 * ModelResult (text + usage). No real subscription needed; a shell script stands
 * in for the CLI and emits the same stream-json shape the fork produces.
 *
 * A separate LIVE test (gated on a real subscription) exercises the actual
 * `claude` binary.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeCliAdapter } from '../../../src/agent/providers/adapter-claude-cli.js';
import { detectClaudeCli } from '../../../src/core/claude-cli-detect.js';
import type { AdapterCallOptions } from '../../../src/agent/providers/types.js';

let tmpDir: string;

/** Write a fake `claude` script that emits stream-json lines like the fork. */
function writeFakeClaude(body: string): string {
  const p = path.join(tmpDir, 'fake-claude.sh');
  fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return p;
}

function baseOpts(command: string, over: Partial<AdapterCallOptions> = {}): AdapterCallOptions {
  return {
    providerConfig: { api: 'claude-cli', claude_cli_command: command },
    model: 'default',
    maxTokens: 4096,
    system: 'You are the butler.',
    messages: [{ role: 'user', content: 'say hi' }],
    ...over,
  };
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-clicli-'));
});
afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('ClaudeCliAdapter.run — fake CLI subprocess', () => {
  it('streams text deltas and returns a text ModelResult with usage', async () => {
    // Emit a partial text delta, a final assistant line, and a result line w/ usage.
    const cmd = writeFakeClaude(`
cat <<'JSONL'
{"type":"system","subtype":"init","session_id":"s1","model":"claude-opus-4-8"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}}
{"type":"result","subtype":"success","result":"Hello there","total_cost_usd":0.0009,"usage":{"input_tokens":11,"output_tokens":3,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}
JSONL
`);
    const adapter = new ClaudeCliAdapter();
    const deltas: string[] = [];
    const result = await adapter.sendMessageStream({
      ...baseOpts(cmd),
      onTextDelta: (d) => deltas.push(d),
    });

    // Streamed deltas arrived.
    expect(deltas.join('')).toContain('Hello');
    // Final content prefers the canonical result text.
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'Hello there' });
    expect(result.stopReason).toBe('end_turn');
    // Usage came off the result line.
    expect(result.usage?.input_tokens).toBe(11);
    expect(result.usage?.output_tokens).toBe(3);
  });

  it('reads the prompt from stdin (the CLI receives our serialized messages)', async () => {
    // Echo whatever arrived on stdin back inside a result line so we can assert
    // the adapter actually piped the prompt in.
    const cmd = writeFakeClaude(`
IN="$(cat)"
printf '{"type":"result","subtype":"success","result":%s}\\n' "$(printf '%s' "$IN" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
`);
    const adapter = new ClaudeCliAdapter();
    const result = await adapter.sendMessage(baseOpts(cmd, {
      messages: [{ role: 'user', content: 'PROMPT_MARKER_42' }],
    }));
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect((result.content[0] as { text: string }).text).toContain('PROMPT_MARKER_42');
  });

  it('rejects with an honest error when the CLI reports an error result', async () => {
    const cmd = writeFakeClaude(`
echo '{"type":"result","subtype":"error","error":"Not logged in"}'
exit 1
`);
    const adapter = new ClaudeCliAdapter();
    await expect(adapter.sendMessage(baseOpts(cmd))).rejects.toThrow(/Not logged in|error/i);
  });

  it('rejects (does not hang) when the binary does not exist', async () => {
    const adapter = new ClaudeCliAdapter();
    await expect(
      adapter.sendMessage(baseOpts('/nonexistent/definitely-not-claude-xyz')),
    ).rejects.toThrow(/spawn failed|ENOENT/i);
  });

  it('returns aborted result when the signal fires', async () => {
    // A CLI that sleeps so the abort lands mid-turn.
    const cmd = writeFakeClaude(`
echo '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}}'
sleep 5
echo '{"type":"result","subtype":"success","result":"too late"}'
`);
    const adapter = new ClaudeCliAdapter();
    const ac = new AbortController();
    const p = adapter.sendMessageStream({ ...baseOpts(cmd), signal: ac.signal });
    // Abort shortly after the first delta.
    setTimeout(() => ac.abort(), 300);
    const result = await p;
    expect(result.aborted).toBe(true);
  });
});

// ── LIVE: real `claude` subprocess against a real subscription ──
// Gated: only runs with WALNUT_LIVE_CLAUDE_CLI=1 AND a detected subscription.
const liveOptIn = process.env.WALNUT_LIVE_CLAUDE_CLI === '1';
const caps = detectClaudeCli();
const runLive = liveOptIn && caps.subscriptionReady;

(runLive ? describe : describe.skip)('LIVE: real claude -p text-only', () => {
  it('gets a real text reply from the subscription (no tools, no Bedrock)', async () => {
    const adapter = new ClaudeCliAdapter();
    const result = await adapter.sendMessage({
      providerConfig: { api: 'claude-cli' },
      model: 'haiku',
      maxTokens: 64,
      system: 'You are a terse assistant. Answer in one word.',
      messages: [{ role: 'user', content: 'Reply with exactly: WALNUT_CLI_OK' }],
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text.length).toBeGreaterThan(0);
    expect(result.stopReason).toBe('end_turn');
  }, 120_000);
});

if (!runLive) {
  describe('LIVE: real claude -p (skipped)', () => {
    it('is skipped without opt-in + a detected subscription', () => {
      const reason = !liveOptIn ? 'WALNUT_LIVE_CLAUDE_CLI!=1' : 'no subscription detected';
      expect(reason.length).toBeGreaterThan(0);
    });
  });
}
