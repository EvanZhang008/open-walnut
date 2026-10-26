/**
 * Which CLI-injected user lines are context rows (web/src/components/sessions/injected-context.ts):
 * the rows that render as a muted "Loaded skill … ›" / "Injected context ›" line and
 * fold with the steps beside them. A person's words and a message from another
 * session never count, so the fold can never hide them.
 */
import { describe, expect, it } from 'vitest';
import { injectedContextKind } from '@/components/sessions/injected-context';
import { createEnvelopeKit } from '../../src/core/peers/envelope-kit';
import type { SessionHistoryMessage } from '@/types/session';

const user = (text: string, injected?: boolean): SessionHistoryMessage => ({ role: 'user', text, timestamp: '2026-01-01T00:00:00.000Z', ...(injected ? { injected } : {}) }) as SessionHistoryMessage;
const skillText = 'Base directory for this skill: /home/sample/.claude/skills/sample-plan\n\n# Sample plan';

describe('injectedContextKind', () => {
  it('a loaded skill, with or without the injected flag', () => {
    expect(injectedContextKind(user(skillText, true))).toBe('skill');
    // Histories parsed before the server learned the flag still read as one.
    expect(injectedContextKind(user(skillText))).toBe('skill');
  });

  it('any other injected line is context', () => {
    expect(injectedContextKind(user('(Re-invocation of /sample-plan: the skill instructions were previously loaded.)', true))).toBe('context');
    expect(injectedContextKind(user('This session is being continued from a previous conversation.', true))).toBe('context');
  });

  it('a person\'s words, an interrupt and a message from another session are not', () => {
    expect(injectedContextKind(user('please run the checks'))).toBeNull();
    expect(injectedContextKind(user('[Request interrupted by user]', true))).toBeNull();
    const note = createEnvelopeKit().buildWalnutMessage({ kind: 'peer-note', attrs: { from: 'Sample lead [abcd1234]', title: 'check' }, body: 'Please check.' });
    expect(injectedContextKind(user(note, true))).toBeNull();
    expect(injectedContextKind({ role: 'assistant', text: skillText, timestamp: '2026-01-01T00:00:00.000Z' } as SessionHistoryMessage)).toBeNull();
  });

  it('a skill text that quotes an envelope is still the skill', () => {
    const note = createEnvelopeKit().buildWalnutMessage({ kind: 'peer-note', attrs: { from: 'Sample lead [abcd1234]', title: 'x' }, body: 'y' });
    expect(injectedContextKind(user(`${skillText}\n\nExample:\n${note}`, true))).toBe('skill');
  });
});
