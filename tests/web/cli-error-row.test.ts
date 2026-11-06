/**
 * A row of Claude Code's own error reply draws as its error line: the notice grey, a "!" (the
 * server's half: tests/core/sessions/cli-error-rows.test.ts). 2026-11-06: it drew as an answer.
 */
import { describe, it, expect } from 'vitest';
import { CLI_ERROR_VARIANT, systemRowVariant } from '../../web/src/components/sessions/fold-steps';
import { appendSystemBlock } from '../../web/src/stream/stream-reducer';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('the CLI error line', () => {
  it('history and the live stream both draw it with the CLI error variant', () => {
    const row = { role: 'system' as const, text: 'Claude Code: Prompt is too long', timestamp: '2026-11-06T09:00:00Z', systemVariant: 'error' as const, cliError: true as const, msgId: 'm1' };
    expect(systemRowVariant(row)).toBe(CLI_ERROR_VARIANT);
    expect(systemRowVariant({ ...row, cliError: undefined })).toBe('error');
    // The history row's member and the live block both go through it (SessionMessage.tsx, StreamingBlockView.tsx).
    const src = (f: string) => readFileSync(path.resolve(__dirname, '../../web/src/components/sessions', f), 'utf8');
    expect(src('SessionMessage.tsx')).toMatch(/variant: systemRowVariant\(message\)/);
    expect(src('StreamingBlockView.tsx')).toMatch(/block\.cliError \? CLI_ERROR_VARIANT/);
    const blocks = appendSystemBlock([], { variant: 'error', message: row.text, uuid: 'u1', cliError: true });
    expect(blocks).toEqual([expect.objectContaining({ type: 'system', variant: 'error', cliError: true })]);
  });

  it('notice lines are 13px in the notice grey, which reads 4.5:1 or more on the light theme', () => {
    const css = readFileSync(path.resolve(__dirname, '../../web/src/styles/globals.css'), 'utf8');
    const line = css.match(/\.session-system-line \{[^}]*\}/)?.[0] ?? '';
    expect(line).toMatch(/font-size: 13px/);
    expect(line).toMatch(/color: var\(--fg-notice\)/);
    const light = css.match(/--fg-notice: (#[0-9A-Fa-f]{6})/)?.[1];
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    expect((1.05) / (lum(light!) + 0.05)).toBeGreaterThanOrEqual(4.5);
    expect(css).toMatch(/\.session-system-line--cli-error \.session-system-icon \{ color: var\(--warning\); \}/);
  });
});
