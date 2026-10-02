/**
 * `walnut.macos` for plugins: protected reads through Walnut's one Full Disk Access
 * grant, and only after the plugin has said why.
 *
 * The 2026-09-26 case it replaces: Rhythm read ~/Library/DoNotDisturb with
 * fs.readFile, so macOS judged the server's own `/opt/homebrew/bin/node` and the
 * person was asked to grant node a second Full Disk Access row next to Walnut's.
 * The reader itself is faked; the assertions are what reaches it and what comes back.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const reads: Array<{ file: string; maxBytes: number }> = [];
let answer: Buffer | NodeJS.ErrnoException = Buffer.from('{}');

vi.mock('../../src/core/protected-reader.js', () => ({
  readProtectedFile: async (file: string, maxBytes: number) => {
    reads.push({ file, maxBytes });
    if (answer instanceof Error) throw answer;
    return answer;
  },
  readerGrantTarget: async () => '/Applications/Walnut.app',
}));

const { createPluginMacos } = await import('../../src/core/plugins/plugin-macos.js');
const { fullDiskAccessUses, resetFullDiskAccessUses } = await import('../../src/core/permissions/fda-uses.js');

const FOCUS = '/Users/someone/Library/DoNotDisturb/DB/Assertions.json';

function plugin(id = 'walnut-rhythm', live = true) {
  const owned: Array<{ dispose(): unknown }> = [];
  const api = createPluginMacos({
    pluginId: id,
    own: (d) => { owned.push(d); return d; },
    assertLive: (registration) => { if (!live) throw new Error(`refused ${registration}`); },
  });
  return { api, owned };
}

beforeEach(() => {
  reads.length = 0;
  answer = Buffer.from('{}');
  resetFullDiskAccessUses();
});

describe('walnut.macos', () => {
  it('refuses a read before the plugin has said why', async () => {
    const { api } = plugin();
    await expect(api.readProtectedFile(FOCUS)).rejects.toMatchObject({ code: 'EACCES' });
    expect(reads).toEqual([]);
  });

  it('after useFullDiskAccess, reads through Walnut as UTF-8 text', async () => {
    const { api } = plugin();
    api.useFullDiskAccess({ reason: "mirror your Mac's Focus", probe: FOCUS });
    // A Focus mode named in Chinese ("sleep").
    const json = '{"name":"\u7761\u7720"}';
    answer = Buffer.from(json, 'utf8');

    expect(await api.readProtectedFile(FOCUS)).toBe(json);
    expect(reads).toEqual([{ file: FOCUS, maxBytes: 1024 * 1024 }]);
    expect(fullDiskAccessUses()).toEqual([{ owner: 'walnut-rhythm', reason: "mirror your Mac's Focus", probe: FOCUS }]);
  });

  it('caps maxBytes at 16 MB and ignores nonsense', async () => {
    const { api } = plugin();
    api.useFullDiskAccess({ reason: 'read a thing' });
    await api.readProtectedFile(FOCUS, { maxBytes: 1e12 });
    await api.readProtectedFile(FOCUS, { maxBytes: -5 });
    await api.readProtectedFile(FOCUS, { maxBytes: 4096.7 });
    expect(reads.map((r) => r.maxBytes)).toEqual([16 * 1024 * 1024, 1024 * 1024, 4096]);
  });

  it('passes a refusal through as EPERM, the code fs.readFile would give', async () => {
    const { api } = plugin();
    api.useFullDiskAccess({ reason: 'read a thing' });
    answer = Object.assign(new Error('refused'), { code: 'EPERM' });
    await expect(api.readProtectedFile(FOCUS)).rejects.toMatchObject({ code: 'EPERM' });
  });

  it('the declaration ends with its handle, and with the plugin (owned)', async () => {
    const { api, owned } = plugin();
    const handle = api.useFullDiskAccess({ reason: 'read a thing' });
    expect(owned).toHaveLength(1);
    handle.dispose();
    expect(fullDiskAccessUses()).toEqual([]);
    await expect(api.readProtectedFile(FOCUS)).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('one plugin\'s declaration does not open reads for another', async () => {
    plugin('walnut-rhythm').api.useFullDiskAccess({ reason: 'read a thing' });
    await expect(plugin('other-plugin').api.readProtectedFile(FOCUS)).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('a reason is required, kept short, and a relative probe is dropped', () => {
    const { api } = plugin();
    expect(() => api.useFullDiskAccess({ reason: '  ' })).toThrow(/needs a reason/);
    expect(() => api.useFullDiskAccess({ reason: 'x'.repeat(201) })).toThrow(/exceeds 200/);
    api.useFullDiskAccess({ reason: 'read a thing', probe: 'relative/file' });
    expect(fullDiskAccessUses()[0]).toEqual({ owner: 'walnut-rhythm', reason: 'read a thing' });
  });

  it('a stopped plugin cannot declare', () => {
    expect(() => plugin('walnut-rhythm', false).api.useFullDiskAccess({ reason: 'read a thing' })).toThrow(/refused/);
  });

  it('names what to grant without building anything', async () => {
    expect(await plugin().api.fullDiskAccessTarget()).toBe('/Applications/Walnut.app');
  });
});
