/**
 * A `*.local.spec.ts` browser spec is a person's own walk-through: a demo that records a video,
 * a one-off check against their own setup. It stays out of git (.gitignore) and out of CI
 * (playwright.config.ts leaves `**\/*.local.spec.ts` out when CI is set).
 *
 * 2026-11-13: zz-approval-demo.local.spec.ts ("Local demo walk ... (not committed)") was swept
 * into a commit with the change it demonstrated; every CI run then ran its 240 s demo, with its
 * pauses and video, to a timeout in browser shard 15.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

describe('local browser specs', () => {
  it('none is tracked in git', () => {
    const tracked = execFileSync('git', ['ls-files', '--', 'tests/e2e/browser/*.local.spec.ts'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean);
    expect(tracked, 'a *.local.spec.ts is a local walk-through: git rm --cached it').toEqual([]);
  });

  it('git ignores them', () => {
    expect(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')).toMatch(/^tests\/e2e\/browser\/\*\.local\.spec\.ts$/m);
  });

  it('a CI run leaves them out', () => {
    const config = fs.readFileSync(path.join(ROOT, 'playwright.config.ts'), 'utf8');
    expect(config).toMatch(/process\.env\.CI \? \['\*\*\/\*\.local\.spec\.ts'\] : \[\]/);
    // Every project's testIgnore carries sideSpecs, so the list joins it there.
    expect(config).toMatch(/const sideSpecs = \[\.\.\.sideConfigSpecs\(browserDir\), \.\.\.localSpecs\]/);
  });
});
