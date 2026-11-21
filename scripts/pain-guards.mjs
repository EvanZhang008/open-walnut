#!/usr/bin/env bun
/**
 * Run the guard tests a pain registry names (src/core/org/reflection/pains.ts) and write their
 * results where the reflection's nightly note reads them (pains-tests.json, GuardRun).
 *
 * Usage (from a checkout of the repo, the one whose tests count, e.g. a clean one at main):
 *   bun scripts/pain-guards.mjs --registry <pains.json> --out <pains-tests.json> [--dry-run]
 *
 * For each entry with a test: no_file when its file is gone, no_test when the file no longer holds
 * a test of that name; otherwise one vitest run over all the named files (the focus config, JSON
 * report) says passed or failed. A browser spec (*.spec.ts) is ci_only: CI's browser jobs run it.
 * It reads the registry and writes only --out; it sends nothing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const registry = opt('--registry');
const outFile = opt('--out');
const dry = args.includes('--dry-run');
if (!registry || (!outFile && !dry)) {
  process.stderr.write('usage: bun scripts/pain-guards.mjs --registry <pains.json> --out <pains-tests.json> [--dry-run]\n');
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entries = (JSON.parse(fs.readFileSync(registry, 'utf-8')).entries ?? []).filter((e) => e?.id && e?.test?.file && e?.test?.name);

/** Is `name` a test title in the file's text: a string literal opening a test call (its escaped quotes read as quotes). */
const holdsTest = (text, name) => {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b(?:it|test)(?:\\.\\w+)*\\(\\s*(['"\`])${esc}\\1`).test(text.replace(/\\(['"`])/g, '$1'));
};

const results = {};
const toRun = new Map();
for (const e of entries) {
  const rel = path.normalize(e.test.file);
  const abs = path.join(root, rel);
  if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(abs)) { results[e.id] = { result: 'no_file', detail: rel }; continue; }
  if (!/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(rel)) { results[e.id] = { result: 'no_test', detail: `${rel} is not a test file` }; continue; }
  const literal = holdsTest(fs.readFileSync(abs, 'utf-8'), e.test.name);
  if (/\.spec\.[cm]?[jt]sx?$/.test(rel)) { results[e.id] = literal ? { result: 'ci_only', detail: 'a browser spec: CI runs it' } : { result: 'no_test', detail: `${rel} has no test "${e.test.name}"` }; continue; }
  // A title built at run time (it(`${kind}: ...`)) is found in the run's report, not in the text.
  toRun.set(e.id, { rel, name: e.test.name, literal });
}

if (toRun.size && !dry) {
  const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pain-guards-')), 'report.json');
  const files = [...new Set([...toRun.values()].map((t) => t.rel))];
  const run = spawnSync('bun', ['--bun', 'vitest', 'run', '--config', 'vitest.focus.config.ts', '--reporter=json', `--outputFile=${report}`, ...files],
    { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], timeout: 20 * 60_000, encoding: 'utf-8' });
  let json = null;
  try { json = JSON.parse(fs.readFileSync(report, 'utf-8')); } catch { /* no report: every test below is not_run */ }
  const byFile = new Map();
  for (const f of json?.testResults ?? []) byFile.set(path.relative(root, f.name), f.assertionResults ?? []);
  for (const [id, t] of toRun) {
    const tests = (byFile.get(t.rel) ?? []).filter((a) => a.title === t.name || a.fullName === t.name || a.fullName?.endsWith(` ${t.name}`));
    if (!tests.length) {
      results[id] = json && !t.literal ? { result: 'no_test', detail: `${t.rel} has no test "${t.name}"` }
        : { result: 'not_run', detail: json ? 'not in the run\'s report' : `vitest gave no report (exit ${run.status}): ${(run.stderr ?? '').slice(-300)}` };
      continue;
    }
    const failed = tests.filter((a) => a.status !== 'passed' && a.status !== 'skipped' && a.status !== 'pending' && a.status !== 'todo');
    const ran = tests.filter((a) => a.status === 'passed' || failed.includes(a));
    results[id] = failed.length ? { result: 'failed', detail: (failed[0].failureMessages ?? []).join(' ').slice(0, 400) }
      : ran.length ? { result: 'passed' } : { result: 'not_run', detail: 'skipped in the run' };
  }
} else {
  for (const [id] of toRun) results[id] = { result: 'not_run', detail: 'dry run' };
}

const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8' }).stdout?.trim();
const out = { schemaVersion: 1, at: new Date().toISOString(), ...(commit ? { commit } : {}), results };
if (outFile) fs.writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
const counts = Object.values(results).reduce((a, r) => ({ ...a, [r.result]: (a[r.result] ?? 0) + 1 }), {});
process.stdout.write(`${JSON.stringify({ entries: entries.length, counts })}\n`);
