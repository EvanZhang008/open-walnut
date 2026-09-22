import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../src/core/types';
import { dragBus } from '../../web/src/utils/drag-bus';

afterEach(() => {
  dragBus.cancel();
  vi.unstubAllGlobals();
});

describe('hidden companion drop targets', () => {
  it.each([{ width: 0, height: 0, inert: false }, { width: 100, height: 100, inert: true }])('ignores an unavailable target at the origin: %j', ({ width, height, inert }) => {
    let move: (event: { clientX: number; clientY: number }) => void = () => {};
    vi.stubGlobal('window', { addEventListener: (_type: string, listener: typeof move) => { move = listener; }, removeEventListener: vi.fn() });
    const onDrop = vi.fn();
    const unregister = dragBus.register({
      element: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, right: width, bottom: height, width, height }), closest: () => inert ? {} : null }) as unknown as HTMLElement,
      onDrop,
    });
    try {
      dragBus.begin({ kind: 'task', task: { id: 'example-task' } as Task });
      move({ clientX: 0, clientY: 0 });
      expect(dragBus.end()).toBe(false);
      expect(onDrop).not.toHaveBeenCalled();
    } finally { unregister(); }
  });
});
