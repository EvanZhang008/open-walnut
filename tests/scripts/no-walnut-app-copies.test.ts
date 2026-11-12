/**
 * No script or instruction in this repository keeps a copy of Walnut.app beside it.
 *
 * 2026-11-12: agents installing a build by hand kept the old app as dated copies
 * (`/Applications/Walnut.app.previous-<date>`, `Walnut.app.prev-<date>` in Application
 * Support). Session hosts kept running from the moved bundle and macOS asked for Local
 * Network access as that copy; every copy is one more app with Walnut's identity, and a
 * "Don't Allow" given to one would cut the whole of Walnut off from the local network.
 * The one way a build goes in place is desktop/apply-update.sh (desktop/README.md,
 * "Putting a build in place"), which deletes the old app in the same run.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

/** A name for a copy of the app: `Walnut.app.previous-…`, `Walnut.app.prev`, `Walnut-old.app`, `.app.bak`. */
const COPY_NAME = /Walnut\.app[._-](prev|previous|old|bak|backup|orig|verified|save|copy)|Walnut[._ -](prev|previous|old|bak|backup|orig|copy)[^\s/"'`]*\.app\b|\.app\.(prev|previous|bak|backup|old)\b/i;
/** An instruction to keep the old app around. */
const KEEP_OLD_APP = /\b(back ?up|keep|save|stash)\b[^.\n]{0,40}\bold (Walnut\.)?app\b/i;

/** Files that name a copy only to test that it is removed. */
const ALLOWED = new Set(['tests/scripts/no-walnut-app-copies.test.ts', 'tests/scripts/apply-update.test.ts']);

function trackedTextFiles(): string[] {
  const out = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  expect(out.status, out.stderr).toBe(0);
  return out.stdout.split('\0').filter((f) => f && /\.(sh|mjs|cjs|js|ts|tsx|swift|md|yml|yaml|json|py|txt)$/.test(f));
}

describe('no copy of Walnut.app beside it', () => {
  it('no tracked script or instruction names a copy of the app or says to keep the old one', () => {
    const hits: string[] = [];
    for (const file of trackedTextFiles()) {
      if (ALLOWED.has(file)) continue;
      let text: string;
      try { text = fs.readFileSync(path.join(ROOT, file), 'utf8'); } catch { continue; }
      text.split('\n').forEach((line, i) => {
        if (COPY_NAME.test(line) || (KEEP_OLD_APP.test(line) && !/\bnever\b/i.test(line))) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 160)}`);
      });
    }
    expect(hits, 'put a build in place with desktop/apply-update.sh (desktop/README.md); never keep the old app').toEqual([]);
  });

  it('the patterns catch the names agents used', () => {
    for (const name of [
      '/Applications/Walnut.app.previous-20261111-132049',
      '~/Library/Application Support/Open Walnut/Walnut.app.prev-20261111',
      '/Applications/Walnut.app.verified-20260822-190339',
      'mv /Applications/Walnut.app /Applications/Walnut-old.app',
    ]) expect(COPY_NAME.test(name), name).toBe(true);
    expect(KEEP_OLD_APP.test('Back up the old app to Application Support first')).toBe(true);
    // The rule itself says never.
    // Not copies: the app itself, the updater's staged new app, the names the app is found by.
    for (const name of ['/Applications/Walnut.app/Contents/MacOS/Walnut', '.Walnut-1.2.0.app', '~/Applications/Walnut.app'])
      expect(COPY_NAME.test(name), name).toBe(false);
  });

  it('apply-update.sh renames the old app aside only for the swap and deletes it before it opens the new one', () => {
    const text = fs.readFileSync(path.join(ROOT, 'desktop/apply-update.sh'), 'utf8');
    const asides = text.split('\n').filter((l) => /^\s*backup=/.test(l));
    expect(asides).toEqual(['backup="${target%.app}.previous-$$.app"']);
    const swapped = text.indexOf('mv "$staged" "$target"');
    const ended = text.indexOf('kill -TERM "$h"');
    const removed = text.indexOf('rm -rf "$backup"');
    const opened = text.lastIndexOf('"$open_app" $open_flags "$target"');
    // The old app's session hosts end after the new app is in place, and before it is deleted.
    expect(swapped).toBeGreaterThan(0);
    expect(ended).toBeGreaterThan(swapped);
    expect(removed).toBeGreaterThan(ended);
    expect(opened).toBeGreaterThan(removed);
  });

  it('the app updater places nothing beside the app but the new app apply-update.sh moves in', () => {
    const text = fs.readFileSync(path.join(ROOT, 'desktop/AppUpdater.swift'), 'utf8');
    const placed = [...text.matchAll(/appendingPathComponent\("([^"]*\.app)"/g)].map((m) => m[1]);
    // `Walnut.app` is the app inside a download; `.Walnut-<version>.app` is the new app placed beside it.
    expect(new Set(placed)).toEqual(new Set(['Walnut.app', '.Walnut-\\(version).app']));
  });
});
