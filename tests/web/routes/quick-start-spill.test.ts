import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { spillLargePromptToFile } from '../../../src/core/sessions/quick-start-spill.js';
import { QUICK_START_MESSAGE_SPILL_LIMIT } from '../../../src/constants.js';

const createdFiles: string[] = [];

afterEach(() => {
  for (const p of createdFiles.splice(0)) {
    try { fs.unlinkSync(p); } catch { /* best effort */ }
  }
});

describe('spillLargePromptToFile', () => {
  it('returns null when message is within the inline limit', () => {
    const small = 'x'.repeat(QUICK_START_MESSAGE_SPILL_LIMIT);
    expect(spillLargePromptToFile(small)).toBeNull();
  });

  it('spills to disk when message exceeds the inline limit', () => {
    const big = 'y'.repeat(QUICK_START_MESSAGE_SPILL_LIMIT + 1);
    const result = spillLargePromptToFile(big);
    expect(result).not.toBeNull();
    if (!result) return;
    createdFiles.push(result.filePath);

    // File exists and has the original content
    expect(fs.existsSync(result.filePath)).toBe(true);
    expect(fs.readFileSync(result.filePath, 'utf-8')).toBe(big);
    expect(result.originalLength).toBe(big.length);

    // Pointer prompt contains the file path and a head preview
    expect(result.promptWithPointer).toContain(result.filePath);
    expect(result.promptWithPointer).toContain('Read it with the Read tool first');
    expect(result.promptWithPointer).toContain('HEAD PREVIEW');
  });

  it('writes to /tmp with walnut-quick-start prefix and hex suffix', () => {
    // /tmp is hardcoded (not os.tmpdir()) so the path is identical on macOS and
    // Linux — required because remote sessions upload the file to the same
    // absolute path on a (Linux) remote host.
    const big = 'z'.repeat(QUICK_START_MESSAGE_SPILL_LIMIT + 100);
    const result = spillLargePromptToFile(big);
    expect(result).not.toBeNull();
    if (!result) return;
    createdFiles.push(result.filePath);
    expect(result.filePath).toMatch(/^\/tmp\/walnut-quick-start-\d+-[a-f0-9]+\.md$/);
  });

  it('generates unique paths for concurrent spills (no collisions)', () => {
    const big = 'a'.repeat(QUICK_START_MESSAGE_SPILL_LIMIT + 1);
    const r1 = spillLargePromptToFile(big);
    const r2 = spillLargePromptToFile(big);
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    if (!r1 || !r2) return;
    createdFiles.push(r1.filePath, r2.filePath);
    expect(r1.filePath).not.toBe(r2.filePath);
  });

  it('truncates head preview to 500 chars with ellipsis', () => {
    const big = 'b'.repeat(QUICK_START_MESSAGE_SPILL_LIMIT + 1000);
    const result = spillLargePromptToFile(big);
    expect(result).not.toBeNull();
    if (!result) return;
    createdFiles.push(result.filePath);
    // Preview ends with U+2026 ellipsis
    expect(result.promptWithPointer).toContain('\u2026');
  });
});
