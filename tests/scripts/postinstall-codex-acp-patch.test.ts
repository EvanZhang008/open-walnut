/**
 * A published install (npm, a global bun install) applies no dependency patches,
 * so scripts/postinstall.mjs applies the codex-acp patch itself: without it Codex
 * 0.166 and newer refuse every resume and turn of a thread on a configured
 * provider (2026-10-30). Pinned against the real patch and the real adapter: the
 * checkout's adapter is patched by bun, so the pristine file is made by undoing
 * the patch's own hunks.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain .mjs script, no types
import { applyCodexAcpPatch, applyHunks, diffHunks } from '../../scripts/postinstall.mjs';

const repoRoot = path.resolve(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { patchedDependencies: Record<string, string> };
const [patchKey, patchFile] = Object.entries(pkg.patchedDependencies).find(([k]) => k.startsWith('@agentclientprotocol/codex-acp@'))!;
const patchText = fs.readFileSync(path.join(repoRoot, patchFile), 'utf8');
const patched = fs.readFileSync(path.join(repoRoot, 'node_modules/@agentclientprotocol/codex-acp/dist/index.js'), 'utf8');

type Hunk = { before: string; after: string };
const hunks = diffHunks(patchText) as Hunk[];
const reversed = hunks.map((h) => ({ before: h.after, after: h.before }));
const pristine = (applyHunks(patched, reversed) as { content: string }).content;

let tmp = '';
afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); tmp = ''; });

/** A published-install layout: our package.json + the patch, and the adapter as installed. */
function install(adapterSource: string, version = patchKey.split('@').pop()!): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-acp-postinstall-'));
  fs.mkdirSync(path.join(tmp, 'patches'));
  fs.copyFileSync(path.join(repoRoot, patchFile), path.join(tmp, patchFile));
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'open-walnut', patchedDependencies: { [patchKey]: patchFile } }));
  const adapter = path.join(tmp, 'node_modules/@agentclientprotocol/codex-acp');
  fs.mkdirSync(path.join(adapter, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(adapter, 'package.json'), JSON.stringify({ name: '@agentclientprotocol/codex-acp', version, main: 'dist/index.js' }));
  fs.writeFileSync(path.join(adapter, 'dist/index.js'), adapterSource);
  return tmp;
}

const resolvePkg = () => path.join(tmp, 'node_modules/@agentclientprotocol/codex-acp/dist/index.js');
const adapterText = () => fs.readFileSync(resolvePkg(), 'utf8');

describe('codex-acp patch on a published install', () => {
  it('the patch reads as hunks that undo to an upstream file without the provider startup args', () => {
    expect(hunks.length).toBeGreaterThan(0);
    expect(pristine).toBeTruthy();
    expect(pristine).not.toContain('walnutProviderStartupArgs');
    expect(patched).toContain('walnutProviderStartupArgs');
  });

  it('patches the upstream adapter to exactly what bun makes, and a second run leaves it', () => {
    const root = install(pristine);
    const warnings: string[] = [];
    expect(applyCodexAcpPatch(root, { resolvePkg, warn: (m: string) => warnings.push(m) })).toBe('patched');
    expect(adapterText()).toBe(patched);
    expect(applyCodexAcpPatch(root, { resolvePkg, warn: (m: string) => warnings.push(m) })).toBe('already');
    expect(adapterText()).toBe(patched);
    expect(warnings).toEqual([]);
  });

  it('leaves another version or an unknown file alone, with a warning, never a throw', () => {
    const warnings: string[] = [];
    install(pristine, '9.9.9');
    applyCodexAcpPatch(tmp, { resolvePkg, warn: (m: string) => warnings.push(m) });
    expect(adapterText()).toBe(pristine);
    fs.rmSync(tmp, { recursive: true, force: true });
    install('// some other build\n');
    applyCodexAcpPatch(tmp, { resolvePkg, warn: (m: string) => warnings.push(m) });
    expect(adapterText()).toBe('// some other build\n');
    expect(warnings).toHaveLength(2);
  });
});
