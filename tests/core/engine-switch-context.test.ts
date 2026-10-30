/**
 * What an engine switch carries into the new session (src/core/sessions/engine-switch-context.ts):
 * the summary and every turn after it, the oldest turns going first when the budget is short,
 * and an earlier switch's carried context kept on a round trip.
 */
import { describe, expect, it } from 'vitest';
import { estimateTokens, renderCarriedContext, ENGINE_SWITCH_HINT } from '../../src/core/sessions/engine-switch-context.js';
import type { SessionHistoryMessage } from '../../src/core/session-history.js';

const at = '2026-10-29T10:00:00.000Z';
const user = (text: string, extra: Partial<SessionHistoryMessage> = {}): SessionHistoryMessage => ({ role: 'user', text, timestamp: at, ...extra });
const asst = (text: string, extra: Partial<SessionHistoryMessage> = {}): SessionHistoryMessage => ({ role: 'assistant', text, timestamp: at, ...extra });
const meta = { fromEngine: 'claude', toEngine: 'codex', compacted: true, transcriptPath: '/x/transcript.md' };

describe('engine switch carried context', () => {
  it('carries the summary and every turn in full, tools included', async () => {
    const messages: SessionHistoryMessage[] = [
      { role: 'system', text: 'Context compacted', systemVariant: 'compact', timestamp: at },
      user('SUMMARY OF EARLIER WORK', { injected: true }),
      user('fix the parser'),
      asst('done', { tools: [{ name: 'Bash', input: { command: 'bun test parser' }, result: 'ALL 12 PASSED' }] }),
      user('now the docs'),
      asst('docs updated'),
    ];
    const out = await renderCarriedContext(messages, meta, 100_000);
    expect(out.trimmedTurns).toBe(0);
    expect(out.carriedTurns).toBe(2);
    for (const s of ['SUMMARY OF EARLIER WORK', 'fix the parser', 'bun test parser', 'ALL 12 PASSED', 'docs updated', '/x/transcript.md']) {
      expect(out.text).toContain(s);
    }
    expect(out.text.indexOf('fix the parser')).toBeLessThan(out.text.indexOf('now the docs'));
  });

  it('leaves the oldest turns out first and says how many', async () => {
    const messages: SessionHistoryMessage[] = [user('SUMMARY', { injected: true })];
    for (let i = 0; i < 20; i++) messages.push(user(`turn ${i} ${'x'.repeat(2000)}`), asst(`answer ${i}`));
    const out = await renderCarriedContext(messages, meta, 4_000);
    expect(out.trimmedTurns).toBeGreaterThan(0);
    expect(out.carriedTurns + out.trimmedTurns).toBe(20);
    expect(out.text).toContain('SUMMARY');
    expect(out.text).toContain('answer 19');
    expect(out.text).not.toContain('answer 0\n');
    expect(out.text).toMatch(/older turns? after the summary did not fit/);
  });

  it('keeps the newest turn even when it alone is over the budget', async () => {
    const out = await renderCarriedContext([user(`big ${'y'.repeat(50_000)}`), asst('LAST ANSWER')], meta, 1_000);
    expect(out.carriedTurns).toBe(1);
    expect(out.text).toContain('LAST ANSWER');
  });

  it('a round trip keeps the context an earlier switch carried in', async () => {
    const messages = [
      user('go on', { hints: [{ kind: ENGINE_SWITCH_HINT, text: 'CONTEXT FROM THE FIRST CLAUDE SESSION' }, { kind: 'reply-language', text: 'Chinese' }] }),
      asst('continuing on codex'),
    ];
    const out = await renderCarriedContext(messages, { ...meta, fromEngine: 'codex', toEngine: 'claude', compacted: false }, 100_000);
    expect(out.text).toContain('CONTEXT FROM THE FIRST CLAUDE SESSION');
    expect(out.text).not.toContain('reply-language');
  });

  it('counts CJK as about a token a character', () => {
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('a'.repeat(35))).toBe(10);
  });
});
