/**
 * The web-asset mirror keeps the last few BUILDS servable, and cannot be talked
 * into deleting the app.
 *
 * The bug (2026-09-03, reported from the Mac app): "I click a path, the whole
 * page flashes, nothing opens; after it settles I click again and the Files
 * panel appears." The Mac app is the one window that stays open across every
 * deploy. A deploy re-hashes and WIPES `/assets`, so the still-running old
 * bundle's next code-split import — the CodeMirror grammar the Files panel
 * needs, fetched for the first time at that click — 404ed, `vite:preloadError`
 * fired, and the tab reloaded on top of the click.
 *
 * Two properties are load-bearing and both are pinned here:
 *
 *  · a build stays fetchable after it is replaced, and (the trap) it must NOT be
 *    evicted just because it was live longer than the retention window — that is
 *    what a file-mtime clock does, and it would leave the bug unfixed for any
 *    repo that deploys less often than the window;
 *  · eviction NEVER consults the primary. The failure this mirror exists for is
 *    the deploy stage being swept out from under a live server, and a sweep
 *    removes FILES while the directory still lists. A pruner that diffs against
 *    that reads it as "the current build ships almost nothing" and deletes almost
 *    everything, including the mirror's own index.html — turning the safety net
 *    off exactly when it is needed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { refreshStaticMirror, bundleIdInHtml, MIN_GENERATIONS } from '../../src/web/static-mirror';

let tmp: string;
let staticDir: string;
let mirrorDir: string;

const HOUR = 60 * 60 * 1000;

const indexFor = (hash: string) =>
  `<!doctype html><script type="module" crossorigin src="/assets/index-${hash}.js"></script>`;

/** Write a build into the primary: entry + one lazily-loaded chunk. */
function writeBuild(hash: string, chunk: string, chunkBytes = 'export const x = 1\n') {
  fs.rmSync(path.join(staticDir, 'assets'), { recursive: true, force: true });
  fs.mkdirSync(path.join(staticDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(staticDir, 'index.html'), indexFor(hash));
  fs.writeFileSync(path.join(staticDir, 'assets', `index-${hash}.js`), `entry ${hash}\n`);
  fs.writeFileSync(path.join(staticDir, 'assets', chunk), chunkBytes);
}

const gens = () => {
  try { return fs.readdirSync(path.join(mirrorDir, 'gens')).sort(); } catch { return []; }
};
/** Is `chunk` fetchable from ANY generation the mirror kept? */
const servable = (chunk: string) =>
  gens().some((g) => fs.existsSync(path.join(mirrorDir, 'gens', g, 'assets', chunk)));
/** Backdate a generation so age rules can be exercised without waiting. */
const ageGeneration = (id: string, msAgo: number) => {
  const t = new Date(Date.now() - msAgo);
  fs.utimesSync(path.join(mirrorDir, 'gens', id), t, t);
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-mirror-gen-'));
  staticDir = path.join(tmp, 'stage', 'dist', 'web', 'static');
  mirrorDir = path.join(tmp, 'mirror');
  fs.mkdirSync(staticDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('bundleIdInHtml', () => {
  it('reads the entry hash from the script tag', () => {
    expect(bundleIdInHtml(indexFor('ABC123'))).toBe('ABC123');
    expect(bundleIdInHtml(indexFor('a_b-c9'))).toBe('a_b-c9');
  });

  it('ignores a modulepreload link and takes the SCRIPT', () => {
    // The client half reads document.scripts; if this half could answer with a
    // preload's hash the two would disagree forever and reload to the rate cap.
    const html = `<link rel="modulepreload" href="/assets/index-PRELOAD.js">${indexFor('REAL')}`;
    expect(bundleIdInHtml(html)).toBe('REAL');
  });

  it('answers null rather than guessing when there is no entry script', () => {
    expect(bundleIdInHtml('<!doctype html><body>nope</body>')).toBeNull();
  });
});

describe('refreshStaticMirror', () => {
  it('mirrors the first build and serves it as a fallthrough root', () => {
    writeBuild('BUILD1', 'grammar-go-AAA.js');
    const r = refreshStaticMirror({ staticDir, mirrorDir });
    expect(r.ready).toBe(true);
    expect(r.copied).toBe(true);
    expect(r.generations).toBe(1);
    expect(r.roots).toHaveLength(1);
    expect(fs.readFileSync(path.join(r.indexRoot!, 'index.html'), 'utf-8')).toBe(indexFor('BUILD1'));
    expect(servable('grammar-go-AAA.js')).toBe(true);
  });

  it('is a no-op when the build has not changed', () => {
    writeBuild('BUILD1', 'grammar-go-AAA.js');
    refreshStaticMirror({ staticDir, mirrorDir });
    const again = refreshStaticMirror({ staticDir, mirrorDir });
    expect(again.copied).toBe(false);
    expect(again.generations).toBe(1);
    expect(again.ready).toBe(true);
  });

  it('KEEPS the previous build\'s chunks after a deploy — the reported bug', () => {
    writeBuild('BUILD1', 'grammar-go-AAA.js');
    refreshStaticMirror({ staticDir, mirrorDir });
    // A deploy: new hashes, and the primary no longer has the old chunk at all.
    writeBuild('BUILD2', 'grammar-go-BBB.js');
    expect(fs.existsSync(path.join(staticDir, 'assets', 'grammar-go-AAA.js'))).toBe(false);

    const r = refreshStaticMirror({ staticDir, mirrorDir });

    expect(r.generations).toBe(2);
    // The still-open window's grammar chunk is fetchable, so its click works…
    expect(servable('grammar-go-AAA.js'), 'the old build\'s chunk must survive the deploy').toBe(true);
    expect(servable('index-BUILD1.js')).toBe(true);
    // …and a NEW load gets the current build: newest generation is served first.
    expect(fs.readFileSync(path.join(r.indexRoot!, 'index.html'), 'utf-8')).toBe(indexFor('BUILD2'));
    expect(servable('grammar-go-BBB.js')).toBe(true);
  });

  it('does NOT evict a build merely for having been live a long time', () => {
    // The mtime-clock trap: BUILD1 went live four days ago and is replaced now.
    // A window opened ten minutes ago is running it, so this is exactly when its
    // chunks must survive — a copy-time clock would delete them in this call.
    writeBuild('BUILD1', 'grammar-go-AAA.js');
    refreshStaticMirror({ staticDir, mirrorDir });
    ageGeneration('BUILD1', 96 * HOUR);
    writeBuild('BUILD2', 'grammar-go-BBB.js');

    const r = refreshStaticMirror({ staticDir, mirrorDir, retentionMs: 72 * HOUR });

    expect(r.evicted).toBe(0);
    expect(servable('grammar-go-AAA.js'), 'the build a window is running was just deleted').toBe(true);
    expect(r.generations).toBe(2);
  });

  it('evicts by age once the floor of recent builds is satisfied', () => {
    for (const [hash, chunk] of [['B1', 'c1.js'], ['B2', 'c2.js'], ['B3', 'c3.js']] as const) {
      writeBuild(hash, chunk);
      refreshStaticMirror({ staticDir, mirrorDir });
    }
    ageGeneration('B1', 96 * HOUR);
    ageGeneration('B2', 80 * HOUR);
    writeBuild('B4', 'c4.js');

    const r = refreshStaticMirror({ staticDir, mirrorDir, retentionMs: 72 * HOUR });

    // B1 and B2 are past retention and are not the newest two, so they go.
    expect(servable('c1.js')).toBe(false);
    expect(servable('c2.js')).toBe(false);
    expect(servable('c3.js')).toBe(true);
    expect(servable('c4.js')).toBe(true);
    expect(r.generations).toBe(2);
    expect(r.evicted).toBe(2);
  });

  it('never evicts below the floor, however old everything is', () => {
    writeBuild('B1', 'c1.js');
    refreshStaticMirror({ staticDir, mirrorDir });
    ageGeneration('B1', 1000 * HOUR);
    writeBuild('B2', 'c2.js');
    refreshStaticMirror({ staticDir, mirrorDir });
    ageGeneration('B2', 999 * HOUR);

    const r = refreshStaticMirror({ staticDir, mirrorDir, retentionMs: 1 });

    expect(r.generations).toBe(MIN_GENERATIONS);
    expect(servable('c1.js')).toBe(true);
    expect(servable('c2.js')).toBe(true);
  });

  it('caps the number of generations, oldest first', () => {
    for (let i = 1; i <= 5; i++) {
      writeBuild(`B${i}`, `c${i}.js`);
      refreshStaticMirror({ staticDir, mirrorDir });
      ageGeneration(`B${i}`, (10 - i) * HOUR); // B1 oldest … B5 newest
    }
    const r = refreshStaticMirror({ staticDir, mirrorDir, maxGenerations: 3 });

    expect(r.generations).toBe(3);
    expect(servable('c1.js')).toBe(false);
    expect(servable('c2.js')).toBe(false);
    expect(servable('c5.js')).toBe(true);
  });

  it('trims by size, keeping the newest builds', () => {
    const kb = 'x'.repeat(4096);
    for (let i = 1; i <= 4; i++) {
      writeBuild(`B${i}`, `c${i}.js`, kb);
      refreshStaticMirror({ staticDir, mirrorDir });
      ageGeneration(`B${i}`, (10 - i) * HOUR);
    }
    // Room for roughly one previous generation beyond the newest.
    const r = refreshStaticMirror({ staticDir, mirrorDir, maxPreviousBytes: 6000 });

    expect(r.previousBytes).toBeLessThanOrEqual(6000);
    expect(servable('c1.js')).toBe(false);
    expect(servable('c4.js'), 'the current build is never a size victim').toBe(true);
  });

  // ── The deletion-safety half ──

  it('leaves everything alone when the primary is gone entirely', () => {
    writeBuild('BUILD1', 'grammar-go-AAA.js');
    refreshStaticMirror({ staticDir, mirrorDir });
    fs.rmSync(path.join(tmp, 'stage'), { recursive: true, force: true });

    const r = refreshStaticMirror({ staticDir, mirrorDir });

    expect(r.copied).toBe(false);
    expect(r.warnings.length).toBeGreaterThan(0);
    // Still the only surviving copy of the app.
    expect(r.ready).toBe(true);
    expect(r.evicted).toBe(0);
    expect(servable('grammar-go-AAA.js')).toBe(true);
    expect(fs.existsSync(path.join(r.indexRoot!, 'index.html'))).toBe(true);
  });

  it('survives a PARTIALLY swept primary — dir still lists, files gone', () => {
    // What /var/folders cleaning actually does: it removes files, so the stage
    // directory is still readable and reports an almost-empty build. Nothing may
    // be deleted on the strength of that.
    writeBuild('BUILD1', 'grammar-go-AAA.js');
    refreshStaticMirror({ staticDir, mirrorDir });
    fs.rmSync(path.join(staticDir, 'index.html'));
    fs.rmSync(path.join(staticDir, 'assets', 'grammar-go-AAA.js'));

    const r = refreshStaticMirror({ staticDir, mirrorDir });

    expect(r.evicted).toBe(0);
    expect(r.ready, 'the mirror must still be able to serve the app').toBe(true);
    expect(fs.existsSync(path.join(r.indexRoot!, 'index.html')), 'the mirror deleted its own entry document').toBe(true);
    expect(servable('grammar-go-AAA.js')).toBe(true);
    expect(r.roots.length).toBeGreaterThan(0);
  });

  it('survives a primary whose index.html is there but whose entry chunk is not', () => {
    writeBuild('BUILD1', 'grammar-go-AAA.js');
    refreshStaticMirror({ staticDir, mirrorDir });
    writeBuild('BUILD2', 'grammar-go-BBB.js');
    fs.rmSync(path.join(staticDir, 'assets', 'index-BUILD2.js'));

    const r = refreshStaticMirror({ staticDir, mirrorDir });

    // A stage that cannot serve its own entry bundle is not a build: it must not
    // be adopted as a generation, and must not authorize evicting a real one.
    expect(gens()).toContain('BUILD1');
    expect(servable('grammar-go-AAA.js')).toBe(true);
    expect(r.evicted).toBe(0);
  });

  it('replaces a half-written generation instead of adopting or trusting it', () => {
    writeBuild('BUILD1', 'grammar-go-AAA.js');
    // A killed deploy leaves a directory with an index and no entry chunk.
    const broken = path.join(mirrorDir, 'gens', 'BUILD1');
    fs.mkdirSync(path.join(broken, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(broken, 'index.html'), indexFor('BUILD1'));

    const r = refreshStaticMirror({ staticDir, mirrorDir });

    expect(r.copied, 'a partial generation must be re-copied, not adopted').toBe(true);
    expect(r.ready).toBe(true);
    expect(servable('index-BUILD1.js')).toBe(true);
    expect(servable('grammar-go-AAA.js')).toBe(true);
  });

  it('adopts the older single-build layout instead of orphaning it', () => {
    // What earlier versions wrote: one build at the mirror's top level. After
    // 2026-09-02 that copy may be the only one on the machine.
    fs.mkdirSync(path.join(mirrorDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(mirrorDir, 'index.html'), indexFor('OLDLAYOUT'));
    fs.writeFileSync(path.join(mirrorDir, 'assets', 'index-OLDLAYOUT.js'), 'entry\n');
    fs.writeFileSync(path.join(mirrorDir, 'assets', 'legacy-chunk.js'), 'chunk\n');
    writeBuild('BUILD1', 'grammar-go-AAA.js');

    const r = refreshStaticMirror({ staticDir, mirrorDir });

    expect(servable('legacy-chunk.js'), 'the pre-upgrade copy was thrown away').toBe(true);
    expect(servable('grammar-go-AAA.js')).toBe(true);
    expect(r.generations).toBe(2);
    // The top level is now only a container for generations.
    expect(fs.existsSync(path.join(mirrorDir, 'index.html'))).toBe(false);
  });

  it('never throws, whatever the paths are', () => {
    const r = refreshStaticMirror({
      staticDir: path.join(tmp, 'does-not-exist'),
      mirrorDir: path.join(tmp, 'also-not-there'),
    });
    expect(r.ready).toBe(false);
    expect(r.copied).toBe(false);
    expect(r.roots).toEqual([]);
  });
});
