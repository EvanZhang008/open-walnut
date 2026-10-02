/**
 * Model display names (web/src/utils/model-name.ts).
 *
 * shortModelName is what the composer's model pill shows in a narrow session
 * column: the one word that tells the user's models apart, instead of the
 * context percentage alone (2026-10-02: "38%" next to Bypass said nothing about
 * which model was running).
 */
import { describe, it, expect } from 'vitest';
import { formatModelName, shortModelName } from '../../web/src/utils/model-name';

describe('shortModelName', () => {
  it('keeps the family word of a Claude display name', () => {
    expect(shortModelName(formatModelName('claude-fable-5-1'))).toBe('Fable');
    expect(shortModelName(formatModelName('global.anthropic.claude-opus-4-6-v1[1m]'))).toBe('Opus');
    expect(shortModelName('Sonnet 4.6')).toBe('Sonnet');
    expect(shortModelName('Haiku')).toBe('Haiku');
  });

  it('finds the family word inside an advertised ACP name', () => {
    expect(shortModelName('Claude Sonnet 4.6 (US)')).toBe('Sonnet');
    expect(shortModelName('claude opus 5')).toBe('Opus');
  });

  it('uses the trailing word that names a GPT tier', () => {
    expect(shortModelName(formatModelName('gpt-5.6-sol'))).toBe('Sol');
    expect(shortModelName('GPT 5.6 Astra')).toBe('Astra');
    expect(shortModelName('GPT-5 Codex')).toBe('Codex');
  });

  it('returns a name with no distinguishing word whole, for the pill to clip', () => {
    expect(shortModelName('GPT-5.6')).toBe('GPT-5.6');
    expect(shortModelName('my-proxy-model-v2')).toBe('my-proxy-model-v2');
    expect(shortModelName('Kimi K2')).toBe('Kimi K2');
  });

  it('is Auto for an unresolved and a resolved Auto label alike', () => {
    expect(shortModelName('Auto')).toBe('Auto');
    expect(shortModelName('Auto (Opus 5 1M)')).toBe('Auto');
  });

  it('ignores an effort suffix and empty input', () => {
    expect(shortModelName('GPT 5.6 Sol · X-High')).toBe('Sol');
    expect(shortModelName('')).toBe('');
    expect(shortModelName(undefined)).toBe('');
  });
});
