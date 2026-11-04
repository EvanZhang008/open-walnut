/**
 * A backup store in a local directory: the tests' destination, and the
 * simplest proof that the repository format needs nothing a store does not
 * offer. Keys map to paths under the root; writes go through a temp file and a
 * rename, so a crash never leaves a half-written object under its real name.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { StoreNotFoundError, type BackupStore, type StoredObject } from './types.js';

export class LocalStore implements BackupStore {
  readonly kind = 'local' as const;
  constructor(private readonly root: string) {}

  describe(): string {
    return `folder ${this.root}`;
  }

  private pathOf(key: string): string {
    const abs = path.resolve(this.root, key);
    if (!abs.startsWith(path.resolve(this.root) + path.sep)) throw new Error(`key escapes the store: ${key}`);
    return abs;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const dest = this.pathOf(key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${randomBytes(4).toString('hex')}`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, dest);
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await fs.readFile(this.pathOf(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new StoreNotFoundError(key);
      throw err;
    }
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const out: StoredObject[] = [];
    const walk = async (rel: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(path.join(this.root, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(childRel);
        else if (e.isFile() && !/\.tmp-[0-9a-f]{8}$/.test(e.name) && childRel.startsWith(prefix)) {
          const st = await fs.stat(path.join(this.root, childRel));
          out.push({ key: childRel, size: st.size, modifiedAt: st.mtimeMs });
        }
      }
    };
    await walk('');
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.pathOf(key), { force: true });
  }
}
