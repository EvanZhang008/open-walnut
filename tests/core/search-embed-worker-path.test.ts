import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { embedWorkerCandidates } from '../../src/core/search/wiring.js';

const WORKER = path.join('lib', 'hybrid-search', 'embed-worker.js');

describe('embedWorkerCandidates', () => {
  it('finds the worker from dist/cli.js under an npm global install', () => {
    // `open-walnut web` runs bin/open-walnut.js, which imports ../dist/cli.js:
    // the module lives in <pkg>/dist, argv[1] is the bin SYMLINK, cwd is $HOME.
    const pkg = '/opt/homebrew/lib/node_modules/open-walnut';
    const candidates = embedWorkerCandidates(
      path.join(pkg, 'dist'),
      '/opt/homebrew/bin/open-walnut',
      '/Users/someone',
    );
    expect(candidates).toContain(path.join(pkg, 'dist', WORKER));
  });

  it('finds the worker from dist/web/server.js', () => {
    const pkg = '/srv/walnut';
    const candidates = embedWorkerCandidates(
      path.join(pkg, 'dist', 'web'),
      path.join(pkg, 'dist', 'web', 'server.js'),
      '/',
    );
    expect(candidates).toContain(path.join(pkg, 'dist', WORKER));
  });

  it('finds the worker from the un-bundled source tree via cwd', () => {
    const repo = '/home/dev/open-walnut';
    const candidates = embedWorkerCandidates(
      path.join(repo, 'src', 'core', 'search'),
      path.join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      repo,
    );
    expect(candidates).toContain(path.join(repo, 'dist', WORKER));
  });

  it('tolerates a missing argv[1]', () => {
    expect(() => embedWorkerCandidates('/x/dist', undefined, '/x')).not.toThrow();
  });
});
