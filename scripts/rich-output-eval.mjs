#!/usr/bin/env node
/**
 * Rich output eval: asks the real model each question in tests/rich-output-golden.yaml
 * with Walnut's rich-mode text appended exactly as a send appends it, then scores
 * the shape of every reply (scripts/lib/rich-output-score.mjs).
 *
 * Variants: `full` = the question plus the ON instruction (the first send, or the
 * first after a compaction); `reminder` = the question plus only the standing
 * reminder, with no instruction earlier in context (the worst case a long session
 * drifts into).
 *
 * Usage (tsx, because it imports the instruction from the TypeScript source):
 *   ./node_modules/.bin/tsx scripts/rich-output-eval.mjs                     all cases, both variants
 *   ... --variant reminder --runs 2 --case sequence-oauth --family diagram
 *   ... --dump-strings > /tmp/x/before.json                                  save the current wording
 *   ... --strings /tmp/x/before.json --json /tmp/x/before-report.json        judge another wording
 *   ... --compare /tmp/x/before-report.json                                  paired diff against a report
 *   ... --rescore <evidence>/rich-output-eval/<run>                              rescore saved replies, no model calls
 *
 * Every call is a real `claude -p` turn (tools off, run in an empty directory),
 * so a full run costs a few dollars; use --case/--family while iterating.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { scoreReply } from './lib/rich-output-score.mjs';
import { evidenceDir } from './lib/evidence-dir.mjs';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const opts = { variant: 'both', runs: 1, model: 'opus', parallel: 3, timeoutSec: 300 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--variant') opts.variant = next();
    else if (a === '--runs') opts.runs = Number(next());
    else if (a === '--model') opts.model = next();
    else if (a === '--case') opts.caseId = next();
    else if (a === '--family') opts.family = next();
    else if (a === '--parallel') opts.parallel = Number(next());
    else if (a === '--strings') opts.strings = next();
    else if (a === '--json') opts.json = next();
    else if (a === '--compare') opts.compare = next();
    else if (a === '--out') opts.out = next();
    else if (a === '--rescore') opts.rescore = next();
    else if (a === '--dump-strings') opts.dumpStrings = true;
    else if (a === '--timeout') opts.timeoutSec = Number(next());
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

async function currentStrings() {
  const m = await import(path.join(ROOT, 'src/core/sessions/output-mode.ts'));
  return { full: m.RICH_OUTPUT_MODE_ON_INSTRUCTION, reminder: m.RICH_OUTPUT_MODE_REMINDER };
}

function loadCases(opts) {
  const doc = yaml.load(fs.readFileSync(path.join(ROOT, 'tests/rich-output-golden.yaml'), 'utf8'));
  return doc.cases.filter((c) => (!opts.caseId || c.id === opts.caseId) && (!opts.family || c.family === opts.family));
}

/** The text a Walnut send hands the CLI: the user's words, a blank line, the mode text. */
function promptFor(question, modeText) {
  return `${question}\n\n${modeText}`;
}

function askModel(text, opts, cwd) {
  return new Promise((resolve) => {
    const args = ['-p', text, '--model', opts.model, '--output-format', 'text',
      '--disallowedTools', 'Bash,Read,Write,Edit,MultiEdit,Glob,Grep,WebFetch,WebSearch,Agent,Task,NotebookEdit'];
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutSec * 1000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function jobsFor(cases, opts) {
  const variants = opts.variant === 'both' ? ['full', 'reminder'] : [opts.variant];
  const jobs = [];
  for (const c of cases) for (const v of variants) for (let r = 1; r <= opts.runs; r++) jobs.push({ case: c, variant: v, run: r });
  return jobs;
}

function fileFor(dir, job) {
  return path.join(dir, `${job.case.id}.${job.variant}.${job.run}.md`);
}

function summarize(results) {
  const byVariant = {};
  for (const r of results) {
    const s = (byVariant[r.variant] ??= { pass: 0, total: 0, warns: 0 });
    s.total += 1;
    if (r.pass) s.pass += 1;
    s.warns += r.checks.filter((c) => !c.ok && c.level === 'warn').length;
  }
  return byVariant;
}

function printReport(results, dir) {
  for (const r of results) {
    const failed = r.checks.filter((c) => !c.ok);
    const mark = r.pass ? 'PASS' : 'FAIL';
    const notes = failed.map((c) => `${c.level === 'warn' ? '(warn) ' : ''}${c.name}${c.detail ? ` [${c.detail}]` : ''}`).join('; ');
    console.log(`${mark}  ${r.variant.padEnd(8)} ${r.id}#${r.run}  svg=${r.svgCount}${notes ? `  ${notes}` : ''}`);
  }
  for (const [v, s] of Object.entries(summarize(results))) {
    console.log(`${v}: ${s.pass}/${s.total} pass, ${s.warns} warnings`);
  }
  if (dir) console.log(`replies: ${dir}`);
}

function compareReports(results, beforePath) {
  const before = JSON.parse(fs.readFileSync(beforePath, 'utf8')).results;
  const key = (r) => `${r.id}|${r.variant}|${r.run}`;
  const old = new Map(before.map((r) => [key(r), r]));
  const flips = [];
  for (const r of results) {
    const b = old.get(key(r));
    if (b && b.pass !== r.pass) flips.push(`${r.pass ? 'FIXED  ' : 'BROKE  '} ${key(r)}`);
  }
  console.log(`\nvs ${beforePath}:`);
  for (const [v, s] of Object.entries(summarize(before))) console.log(`  before ${v}: ${s.pass}/${s.total}`);
  for (const f of flips) console.log(`  ${f}`);
  if (flips.length === 0) console.log('  no paired flips');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.dumpStrings) {
    process.stdout.write(`${JSON.stringify(await currentStrings(), null, 2)}\n`);
    return;
  }
  const cases = loadCases(opts);
  if (cases.length === 0) throw new Error('no case matches the filter');
  const jobs = jobsFor(cases, opts);

  let dir = opts.rescore;
  if (!dir) {
    const strings = opts.strings ? JSON.parse(fs.readFileSync(opts.strings, 'utf8')) : await currentStrings();
    // Kept for --rescore / --compare later, so not in /tmp (scripts/lib/evidence-dir.mjs).
    dir = opts.out ?? evidenceDir(path.join('rich-output-eval', new Date().toISOString().replace(/[:.]/g, '-')));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'strings.json'), JSON.stringify(strings, null, 2));
    // An empty working directory keeps the repo's own instructions out of the turn.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rich-output-eval-cwd-'));
    console.log(`${jobs.length} model calls, ${opts.parallel} at a time, model ${opts.model}`);
    await pool(jobs, opts.parallel, async (job) => {
      const res = await askModel(promptFor(job.case.prompt, strings[job.variant]), opts, cwd);
      if (res.code !== 0) fs.writeFileSync(`${fileFor(dir, job)}.err`, res.err || `exit ${res.code}`);
      fs.writeFileSync(fileFor(dir, job), res.out);
      process.stdout.write(res.code === 0 ? '.' : 'x');
    });
    process.stdout.write('\n');
  }

  const results = jobs.map((job) => {
    const file = fileFor(dir, job);
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const scored = text.trim()
      ? scoreReply(text, job.case.expect)
      : { pass: false, svgCount: 0, checks: [{ name: 'got a reply', ok: false, level: 'fail', detail: 'empty' }] };
    return { id: job.case.id, family: job.case.family, variant: job.variant, run: job.run, ...scored };
  });
  printReport(results, dir);
  if (opts.json) fs.writeFileSync(opts.json, JSON.stringify({ dir, results }, null, 2));
  if (opts.compare) compareReports(results, opts.compare);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
