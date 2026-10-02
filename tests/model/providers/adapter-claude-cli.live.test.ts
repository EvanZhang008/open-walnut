/**
 * LIVE: the real `claude` binary through the adapter, against a real
 * subscription. Live tier only (vitest.live.config.ts lifts the mock guard and
 * keeps WALNUT_LIVE_CLAUDE_CLI); the fake-CLI coverage is
 * adapter-claude-cli.integration.test.ts.
 *
 *   WALNUT_LIVE_CLAUDE_CLI=1 npx vitest run --config vitest.live.config.ts tests/model/providers/adapter-claude-cli.live.test.ts
 */
import { describe, it, expect } from 'vitest';
import { ClaudeCliAdapter } from '../../../src/model/providers/adapter-claude-cli.js';
import { detectClaudeCli } from '../../../src/core/claude-cli-detect.js';
import type { AdapterCallOptions } from '../../../src/model/providers/types.js';

// ── LIVE: real `claude` subprocess against a real subscription ──
// Gated: only runs with WALNUT_LIVE_CLAUDE_CLI=1 AND a detected subscription.
const liveOptIn = process.env.WALNUT_LIVE_CLAUDE_CLI === '1';
const caps = detectClaudeCli();
const runLive = liveOptIn && caps.ready;

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

  it('PROTOCOL: real model calls a walnut tool, consumes the result, and replies (cache on turn 2)', async () => {
    const adapter = new ClaudeCliAdapter();
    const tools = [{
      name: 'get_secret_number',
      description: 'Returns the secret number. Call this when asked for the secret number.',
      input_schema: { type: 'object' as const, properties: {} },
    }];
    const system = 'You are a terse assistant.';
    const turn1: AdapterCallOptions['messages'] = [
      { role: 'user', content: 'What is the secret number? Use the tool.' },
    ];
    const r1 = await adapter.sendMessage({
      providerConfig: { api: 'claude-cli' }, model: 'haiku', maxTokens: 512,
      system, messages: turn1, tools,
    });
    // The model must have chosen the protocol tool-call form.
    expect(r1.stopReason).toBe('tool_use');
    const call = r1.content.find((b) => b.type === 'tool_use') as { id: string; name: string } | undefined;
    expect(call?.name).toBe('get_secret_number');

    // Feed the result back exactly the way loop.ts would.
    const turn2: AdapterCallOptions['messages'] = [
      ...turn1,
      { role: 'assistant', content: r1.content as never },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: call!.id, content: 'The secret number is 7391.' }] as never },
    ];
    const r2 = await adapter.sendMessage({
      providerConfig: { api: 'claude-cli' }, model: 'haiku', maxTokens: 512,
      system, messages: turn2, tools,
    });
    expect(r2.stopReason).toBe('end_turn');
    const text = r2.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('7391');
    // Turn 2 resumed the session → the CLI-side prefix cache must have hits.
    expect((r2.usage?.cache_read_input_tokens ?? 0)).toBeGreaterThan(0);
  }, 240_000);
});

if (!runLive) {
  describe('LIVE: real claude -p (skipped)', () => {
    it('is skipped without opt-in + a detected subscription', () => {
      const reason = !liveOptIn ? 'WALNUT_LIVE_CLAUDE_CLI!=1' : 'no subscription detected';
      expect(reason.length).toBeGreaterThan(0);
    });
  });
}
