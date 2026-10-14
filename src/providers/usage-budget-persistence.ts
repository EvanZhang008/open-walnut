import type fs from 'node:fs/promises';
import type path from 'node:path';

/** Self-contained factory: the source daemon embeds this function without imports. */
export function createBudgetPersistence(io: Pick<typeof fs, 'mkdir' | 'open'>,
  pathApi: Pick<typeof path, 'resolve' | 'dirname'>): { ensureDirectory(directory: string): Promise<void> } {
  const durable = new Map<string, Promise<void>>();
  async function syncDirectory(dir: string): Promise<void> {
    const handle = await io.open(dir, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  function ensureDirectory(directory: string): Promise<void> {
    const dir = pathApi.resolve(directory), cached = durable.get(dir);
    if (cached) return cached;
    const result = (async () => {
      const created = await io.mkdir(dir, { recursive: true, mode: 0o700 });
      // The first created path includes every descendant created by this mkdir.
      if (created) {
        for (let current = dir; ; current = pathApi.dirname(current)) {
          await syncDirectory(current);
          if (current === pathApi.dirname(created)) break;
        }
      } else {
        // Existing directories may be leftovers from an interrupted first save.
        for (let current = dir; ; current = pathApi.dirname(current)) {
          await syncDirectory(current);
          if (pathApi.dirname(current) === current) break;
        }
      }
    })();
    durable.set(dir, result);
    void result.catch(() => { if (durable.get(dir) === result) durable.delete(dir); });
    return result;
  }
  return { ensureDirectory };
}
