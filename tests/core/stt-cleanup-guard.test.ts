import { describe, it, expect } from 'vitest';
import { validateCleanup } from '../../src/core/stt/cleanup-guard.js';

describe('validateCleanup', () => {
  it('accepts a faithful filler removal', () => {
    const original = '呃,我们我们那个 deployment 呃现在怎么样了?';
    const cleaned = '我们那个 deployment 现在怎么样了?';
    expect(validateCleanup(original, cleaned)).toEqual({ ok: true });
  });

  it('accepts unchanged text (nothing to clean)', () => {
    const text = '把这个 button 往左边挪一点点。';
    expect(validateCleanup(text, text).ok).toBe(true);
  });

  it('rejects empty output', () => {
    const verdict = validateCleanup('说了一些话', '   ');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('empty');
  });

  it('rejects output that grew (model answered instead of editing)', () => {
    const original = '现在几点了?';
    const cleaned = '现在是下午三点二十五分,如果你需要设置提醒的话我可以帮你,请告诉我具体时间。';
    const verdict = validateCleanup(original, cleaned);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('grew');
  });

  it('rejects output that dropped a large chunk of content', () => {
    const original = '第一句话说了很多内容关于部署。第二句话说了很多内容关于测试。第三句话说了很多内容关于发布计划和回滚。';
    const cleaned = '第一句话说了很多内容关于部署。';
    const verdict = validateCleanup(original, cleaned);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('shrank');
  });

  it('rejects when an english/code token disappears', () => {
    // Length passes (only one short token lost) but the product name is gone —
    // exactly the observed Qwen3-4B failure mode.
    const original = '我们需要把 webhook 的重试逻辑改一下,还有那个 dashboard 的刷新频率也要调。';
    const cleaned = '我们需要把重试逻辑改一下,还有那个 dashboard 的刷新频率也要调。';
    const verdict = validateCleanup(original, cleaned);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('webhook');
  });

  it('allows removing english fillers and stutters', () => {
    const original = 'OK so um I think we should we should just deploy the the new version first, uh and then run the smoke tests.';
    const cleaned = 'OK so I think we should just deploy the new version first, and then run the smoke tests.';
    expect(validateCleanup(original, cleaned)).toEqual({ ok: true });
  });

  it('allows collapsing a stuttered english token', () => {
    const original = '我们不是有一个那个 computer computer user 什么的吗?';
    const cleaned = '我们不是有一个那个 computer user 什么的吗?';
    expect(validateCleanup(original, cleaned).ok).toBe(true);
  });

  it('is case-insensitive on latin tokens', () => {
    const original = '打开 GitHub 看一下那个 PR。';
    const cleaned = '打开 github 看一下那个 pr。';
    expect(validateCleanup(original, cleaned).ok).toBe(true);
  });

  it('tolerates minor punctuation-driven growth on short inputs', () => {
    const original = '好的没问题明天见';
    const cleaned = '好的,没问题,明天见。';
    expect(validateCleanup(original, cleaned).ok).toBe(true);
  });

  it('rejects a translation (latin tokens appear from nowhere is fine, chinese gone is shrink/loss)', () => {
    const original = '请把这个按钮往左边移动一点,间距稍微大一些,整体看起来更舒服。';
    const cleaned = 'Move the button left a bit.';
    expect(validateCleanup(original, cleaned).ok).toBe(false);
  });
});
