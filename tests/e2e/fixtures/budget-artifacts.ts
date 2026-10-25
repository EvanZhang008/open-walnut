/**
 * The daemon artifacts a budget E2E runs, tied to the sources they were built
 * from. `writeBudgetManifest` runs right after scripts/build-daemon.sh, in the
 * same command: it records the source version (the hash of the daemon's source
 * files) and the sha256 of every artifact. `checkBudgetArtifacts` fails the test
 * when an artifact is missing, its bytes differ from the manifest, or the
 * sources moved since that build. Nothing here relies on file times.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { computeExpectedDaemonVersion } from '../../../src/providers/daemon-version-check.js';

export const BUDGET_ARTIFACTS = ['usage-core.cjs', 'acp-daemon-core.cjs', 'acp-worker.js', 'daemon-darwin-arm64'] as const;
const MANIFEST = 'budget-e2e-manifest.json';

const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function writeBudgetManifest(binDir: string): Record<string, unknown> {
  const version = computeExpectedDaemonVersion();
  if (!version) throw new Error('daemon sources not found');
  const files: Record<string, string> = {};
  for (const name of BUDGET_ARTIFACTS) files[name] = sha(path.join(binDir, name));
  const built = fs.readFileSync(path.join(binDir, 'daemon-darwin-arm64.version'), 'utf8').trim();
  if (built !== version) throw new Error(`the build carries ${built}, the sources are ${version}`);
  const manifest = { version, files, writtenAt: new Date().toISOString() };
  fs.writeFileSync(path.join(binDir, MANIFEST), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Throws unless every artifact is the one the manifest names and the manifest is of these sources. */
export function checkBudgetArtifacts(binDir: string): { version: string; files: Record<string, string> } {
  const file = path.join(binDir, MANIFEST);
  if (!fs.existsSync(file)) throw new Error(`no ${MANIFEST}: run scripts/build-daemon.sh and the manifest step first`);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as { version: string; files: Record<string, string> };
  const version = computeExpectedDaemonVersion();
  if (manifest.version !== version) throw new Error(`artifacts were built from ${manifest.version}, the sources are now ${version}`);
  for (const name of BUDGET_ARTIFACTS) {
    const target = path.join(binDir, name);
    if (!fs.existsSync(target)) throw new Error(`missing artifact ${name}`);
    if (sha(target) !== manifest.files[name]) throw new Error(`artifact ${name} is not the one the manifest names`);
  }
  return manifest;
}

/** A copy placed beside a source twin must be byte-identical to its artifact. */
export function sameBytes(a: string, b: string): boolean { return sha(a) === sha(b); }
