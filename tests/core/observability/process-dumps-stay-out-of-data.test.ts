/**
 * A process dump (a heap snapshot, a CPU profile) holds whatever the process held:
 * tokens, mail, transcripts. It is written to the runtime dir (LOG_DIR), never under
 * WALNUT_HOME, whose files backups upload and git sync commits.
 *
 * Why (2026-11-21): the on-request heap snapshot first wrote to WALNUT_HOME/diagnostics,
 * which neither the backup's EXCLUDED_DIRS nor the data repo's .gitignore left out; a
 * 255 MB snapshot of the live server would have ridden the next backup. This ratchet
 * finds every file in src/ that writes a dump and fails on one it does not know.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { HEAP_SNAPSHOT_DIR } from '../../../src/core/observability/memory-ledger.js';
import { LOG_DIR, WALNUT_HOME } from '../../../src/constants.js';

const ROOT = path.resolve(__dirname, '../../..');

/** What marks a file as writing a process dump. */
const DUMP_WRITER = /\.heapsnapshot|\.cpuprofile|generateHeapSnapshot|getHeapSnapshot|writeHeapSnapshot\s*\(\s*['"`]/;

/** Every dump writer, each checked below to place its file under LOG_DIR. */
const KNOWN_WRITERS = [
  'src/core/observability/memory-ledger.ts', // heap snapshots: HEAP_SNAPSHOT_DIR
  'src/core/stall-recorder.ts', // CPU profiles of a stall: LOG_DIR/stall-profiles
];

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') tsFiles(p, out); } else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('process dumps stay out of the data folder', () => {
  it('knows every file in src/ that writes a dump', () => {
    const writers = tsFiles(path.join(ROOT, 'src'))
      .filter((f) => DUMP_WRITER.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
      .sort();
    // A new writer: put its file under LOG_DIR (never WALNUT_HOME), then list it above.
    expect(writers).toEqual([...KNOWN_WRITERS].sort());
  });

  it('each known writer places its file under LOG_DIR and never names WALNUT_HOME', () => {
    for (const rel of KNOWN_WRITERS) {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(text, rel).toMatch(/\bLOG_DIR\b/);
      expect(text, rel).not.toMatch(/\bWALNUT_HOME\b/);
    }
  });

  it('heap snapshots go to the runtime dir, outside WALNUT_HOME', () => {
    expect(HEAP_SNAPSHOT_DIR.startsWith(LOG_DIR + path.sep)).toBe(true);
    const rel = path.relative(WALNUT_HOME, HEAP_SNAPSHOT_DIR);
    expect(rel.startsWith('..') || path.isAbsolute(rel)).toBe(true);
  });
});
