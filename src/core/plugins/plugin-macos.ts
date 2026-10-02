/**
 * `walnut.macos` for plugins: protected reads through Walnut's ONE Full Disk Access
 * grant (src/core/protected-reader.ts), instead of through whichever program runs the
 * server. A plugin that read `~/Library/DoNotDisturb` with fs.readFile made the person
 * grant `/opt/homebrew/bin/node`, a second Full Disk Access row next to Walnut's.
 *
 * A plugin must say why first (`useFullDiskAccess`), so the Settings row names every
 * use of the grant; a read without a live declaration is refused.
 */
import { toDisposable, type Disposable } from './disposable.js';
import { declareFullDiskAccessUse, holdsFullDiskAccessUse } from '../permissions/fda-uses.js';

const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_REASON = 200;

export interface PluginMacosOptions {
  pluginId: string;
  own: <T extends Disposable>(registration: T) => T;
  assertLive: (registration: string) => void;
}

export function createPluginMacos({ pluginId, own, assertLive }: PluginMacosOptions) {
  return {
    useFullDiskAccess(use: { reason: string; probe?: string }): Disposable {
      assertLive('macos.useFullDiskAccess');
      const reason = typeof use?.reason === 'string' ? use.reason.trim() : '';
      if (!reason) throw new Error('macos.useFullDiskAccess needs a reason (it is shown in Settings).');
      if (reason.length > MAX_REASON) {
        throw new Error(`macos.useFullDiskAccess reason exceeds ${MAX_REASON} characters`);
      }
      const probe = typeof use.probe === 'string' && use.probe.startsWith('/') ? use.probe : undefined;
      const release = declareFullDiskAccessUse({ owner: pluginId, reason, ...(probe ? { probe } : {}) });
      return own(toDisposable(release));
    },

    async readProtectedFile(file: string, options?: { maxBytes?: number }): Promise<string> {
      if (!holdsFullDiskAccessUse(pluginId)) {
        throw Object.assign(
          new Error('Call walnut.macos.useFullDiskAccess({ reason }) before reading protected files.'),
          { code: 'EACCES' },
        );
      }
      const requested = options?.maxBytes;
      const maxBytes = typeof requested === 'number' && Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), MAX_BYTES)
        : DEFAULT_MAX_BYTES;
      const { readProtectedFile } = await import('../protected-reader.js');
      return (await readProtectedFile(String(file), maxBytes)).toString('utf8');
    },

    async fullDiskAccessTarget(): Promise<string | null> {
      const { readerGrantTarget } = await import('../protected-reader.js');
      return readerGrantTarget();
    },
  };
}
