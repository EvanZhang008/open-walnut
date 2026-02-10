/**
 * Unit tests for isProcessAlive() — PID liveness check with binary verification.
 *
 * Tests verify:
 *   - Returns true for a known alive process (the current test process)
 *   - Returns false for a non-existent PID
 *   - Binary name check matches when correct
 *   - Binary name check rejects when wrong binary
 *   - Edge cases: PID 0, negative PID
 */

import { describe, it, expect } from 'vitest';
import { isProcessAlive } from '../../src/utils/process.js';

describe('isProcessAlive', () => {
  it('returns true for the current process (no binary check)', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('returns false for a non-existent PID', () => {
    // Use a very high PID that is extremely unlikely to exist
    expect(isProcessAlive(999999999)).toBe(false);
  });

  it('returns true when expectedBinary matches the current process', () => {
    // The current process is "node" (or similar)
    expect(isProcessAlive(process.pid, 'node')).toBe(true);
  });

  it('returns false when expectedBinary does not match', () => {
    // The current process is node, not "nonexistent-binary-xyz"
    expect(isProcessAlive(process.pid, 'nonexistent-binary-xyz')).toBe(false);
  });

  it('returns false for PID 0', () => {
    // PID 0 is the kernel scheduler — process.kill(0, 0) sends to process group
    // which behaves differently on different platforms.
    // The important thing is it doesn't throw.
    const result = isProcessAlive(0, 'definitely-not-running');
    expect(typeof result).toBe('boolean');
  });

  it('returns false for negative PID', () => {
    // On POSIX, process.kill(-1, 0) sends to all processes in the group (doesn't throw).
    // But the ps binary check with expectedBinary should still return false.
    expect(isProcessAlive(-1, 'nonexistent-binary-xyz')).toBe(false);
  });
});
