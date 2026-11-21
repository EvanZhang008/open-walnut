/**
 * Every raw phase write names whether it may leave a wait.
 *
 * updateTaskRaw's held-phase guard (prepareRawUpdate, src/core/task-manager.ts) drops a phase
 * change out of WAITING unless the caller passes `leaveHeld`, and keeps the rest of the patch, so
 * the write still reports `changed`. A session-machine writer that forgets it reads as moved while
 * the task stays parked (2026-11-16: applyReportPhase's "needs" report never brought a parked lead
 * back, and its review ask of three draft CRs sat under Waiting instead of Needs you).
 *
 * This test enumerates every updateTaskRaw call in src/ whose patch sets `phase` to a phase that is
 * not terminal, and requires it to pass `leaveHeld` (it is the wait's exit) or be listed below with
 * why the guard is meant to hold it. A new raw phase writer fails here until it says which.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Raw phase writers the held-phase guard is meant to stop: per file, how many and why. */
const HELD_ON_PURPOSE: Record<string, { count: number; why: string }> = {
  'src/web/routes/test-task-fixture.ts': { count: 1, why: 'test-only fixture route: it sets up a task, never wakes a real wait' },
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** The text of the call starting at `start` (the `(` after the name), to its balanced `)`. */
function callText(src: string, start: number): string {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

/**
 * The call's text without its `field_at: { ... }` objects: `field_at.phase` is when the phase field
 * was last written (task-fields.ts), a time, never a phase change the held guard judges.
 */
function withoutFieldTimes(call: string): string {
  let out = '';
  let i = 0;
  for (const m of call.matchAll(/\bfield_at\s*:\s*\{/g)) {
    if (m.index! < i) continue;
    out += call.slice(i, m.index!);
    let depth = 0;
    let j = m.index! + m[0].length - 1;
    for (; j < call.length; j++) {
      if (call[j] === '{') depth++;
      else if (call[j] === '}' && --depth === 0) break;
    }
    i = j + 1;
  }
  return out + call.slice(i);
}

interface Writer { file: string; line: number; leaveHeld: boolean; phase: string }

function rawPhaseWriters(): Writer[] {
  const out: Writer[] = [];
  for (const abs of sourceFiles(path.join(repoRoot, 'src'))) {
    const file = path.relative(repoRoot, abs).split(path.sep).join('/');
    const src = fs.readFileSync(abs, 'utf8');
    for (const m of src.matchAll(/\bupdateTaskRaw\s*\(/g)) {
      // Skip the definition itself.
      if (/function\s+$/.test(src.slice(Math.max(0, m.index! - 12), m.index!))) continue;
      const call = callText(src, m.index! + m[0].length - 1);
      const phase = /\bphase\s*:\s*([^,}\n]+)/.exec(withoutFieldTimes(call));
      if (!phase) continue;
      const value = phase[1].trim();
      // A write that completes the task passes the held guard by design (a pull may close a wait).
      if (/^['"]COMPLETE['"]$/.test(value)) continue;
      out.push({ file, line: src.slice(0, m.index!).split('\n').length, leaveHeld: /\bleaveHeld\s*:\s*true\b/.test(call), phase: value });
    }
  }
  return out;
}

describe('raw phase writers and the held-phase guard', () => {
  const writers = rawPhaseWriters();

  it('finds the known writers (the scan itself works)', () => {
    const files = new Set(writers.map((w) => w.file));
    for (const f of ['src/core/sessions/report-phase.ts', 'src/core/phase.ts', 'src/core/task-wait-until.ts']) {
      expect(files, f).toContain(f);
    }
  });

  it('every raw write of a non-terminal phase passes leaveHeld or says why the guard holds it', () => {
    const bad = writers.filter((w) => !w.leaveHeld && !HELD_ON_PURPOSE[w.file]);
    // An exempt file gains no second unguarded writer unnoticed.
    for (const [file, { count }] of Object.entries(HELD_ON_PURPOSE)) {
      const n = writers.filter((w) => w.file === file && !w.leaveHeld).length;
      if (n > count) bad.push({ file, line: 0, leaveHeld: false, phase: `${n} unguarded writers, ${count} allowed` });
    }
    expect(bad.map((w) => `${w.file}:${w.line} sets phase ${w.phase} without leaveHeld: pass leaveHeld: true when this write is a wait's exit (a turn, its report, a clock), or add the file to HELD_ON_PURPOSE with why a WAITING task must stay parked`)).toEqual([]);
  });

  it('a field time is not a phase write, and a phase beside one still is', () => {
    expect(withoutFieldTimes("(t) => ({ field_at: { ...(t.field_at ?? {}), phase: at }, applied_ops: x })")).not.toMatch(/\bphase\s*:/);
    expect(withoutFieldTimes("{ field_at: { ...f, phase: at }, phase: 'IN_PROGRESS' }")).toMatch(/\bphase\s*:\s*'IN_PROGRESS'/);
  });

  it('the exemptions are still writers (the list only shrinks)', () => {
    for (const f of Object.keys(HELD_ON_PURPOSE)) {
      expect(writers.filter((w) => w.file === f && !w.leaveHeld).length, f).toBe(HELD_ON_PURPOSE[f].count);
    }
  });
});
