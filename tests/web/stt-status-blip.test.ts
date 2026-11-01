/**
 * A status read that fails must not tell the mic voice is unavailable when it
 * last worked, also right after a settings refresh cleared the cache; and a
 * recording mic is never blocked by the status (2026-10-31 voice flake).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchSttStatus = vi.fn();
vi.mock('@/api/stt', () => ({ fetchSttStatus: () => fetchSttStatus() }));
vi.mock('@/utils/page-visibility', () => ({ visibleInterval: () => () => {} }));

const mod = await import('../../web/src/hooks/useSttStatus.js');

const GOOD = { engine: 'mlx', available: true };

describe('stt status blips', () => {
  beforeEach(() => { fetchSttStatus.mockReset(); mod.invalidateSttStatusCache(); });

  it('a failed read after an invalidation answers with the last working status', async () => {
    fetchSttStatus.mockResolvedValueOnce(GOOD);
    expect(await mod.getStatus()).toEqual(GOOD);
    mod.invalidateSttStatusCache();
    fetchSttStatus.mockRejectedValueOnce(new Error('GET /api/stt/status rejected after 20000ms in the connection queue'));
    expect(await mod.getStatus()).toEqual(GOOD);
  });

  it('sttBlocksMic: never while recording or transcribing, otherwise what the status says', () => {
    const down = { isLoading: false, isConfigured: true, isAvailable: false };
    const none = { isLoading: false, isConfigured: false, isAvailable: false };
    const up = { isLoading: false, isConfigured: true, isAvailable: true };
    expect(mod.sttBlocksMic(down, true)).toBe(false);
    expect(mod.sttBlocksMic(none, true)).toBe(false);
    expect(mod.sttBlocksMic(down, false)).toBe(true);
    expect(mod.sttBlocksMic(none, false)).toBe(true);
    expect(mod.sttBlocksMic(up, false)).toBe(false);
    expect(mod.sttBlocksMic({ ...down, isLoading: true }, false)).toBe(false);
  });
});

describe('stt status: a real "voice off" is not hidden', () => {
  beforeEach(() => { fetchSttStatus.mockReset(); mod.invalidateSttStatusCache(); });

  it('a read that names no engine forgets the working one, so a later failed read stays off', async () => {
    fetchSttStatus.mockResolvedValueOnce(GOOD);
    await mod.getStatus();
    mod.invalidateSttStatusCache();
    fetchSttStatus.mockResolvedValueOnce({ engine: null, available: false, error: 'No STT engine configured' });
    expect((await mod.getStatus()).engine).toBeNull();
    mod.invalidateSttStatusCache();
    fetchSttStatus.mockRejectedValueOnce(new Error('network'));
    expect((await mod.getStatus()).engine).toBeNull();
  });
});
