#!/usr/bin/env bun
/**
 * Replay the reflection's candidate stage (src/core/org/reflection/candidates.ts) over a Walnut
 * home for one day, read-only, and print what it would look at as JSON. With --judge, each
 * candidate also goes to the real judge (one model call each; wrong_language needs none).
 *
 * Usage:
 *   bun scripts/reflection-replay.mjs --home <walnut home> --day YYYY-MM-DD [--node <taskId>] [--judge]
 *                                     [--claude-projects <dir>]   (default ~/.claude/projects)
 *
 * It reads the home's tasks (tasks/tasks.json), Threads, user-asks, config and, for local Claude
 * Code sessions, their JSONL transcripts (text and tool rows only: an approximation of the
 * console's transcript, enough for the candidate stage). It never sends anything and never writes
 * into --home: Walnut's modules run against a scratch home in the temp dir (checked before any
 * read), and --judge copies only config.yaml there so the model call finds its provider.
 * Run it on a copy of real data; keep any labeled list of expected findings outside the repo.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const home = opt('--home');
const day = opt('--day');
const onlyNode = opt('--node');
const judgeOn = args.includes('--judge');
const projectsDir = opt('--claude-projects') ?? path.join(os.homedir(), '.claude', 'projects');
if (!home || !day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
  process.stderr.write('usage: bun scripts/reflection-replay.mjs --home <walnut home> --day YYYY-MM-DD [--node <taskId>] [--judge] [--claude-projects <dir>]\n');
  process.exit(2);
}
const homeAbs = path.resolve(home);
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; } };
const readText = (file) => { try { return fs.readFileSync(file, 'utf-8'); } catch { return ''; } };

// Everything Walnut's modules might write (logs aside, which go to the temp dir) lands here.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'reflection-replay-'));
if (judgeOn && fs.existsSync(path.join(homeAbs, 'config.yaml'))) fs.copyFileSync(path.join(homeAbs, 'config.yaml'), path.join(scratch, 'config.yaml'));
process.env.OPEN_WALNUT_HOME = scratch;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => path.join(root, 'src', p);
const { WALNUT_HOME } = await import(src('constants.ts'));
if (path.resolve(WALNUT_HOME) !== path.resolve(scratch) || path.resolve(WALNUT_HOME) === homeAbs) {
  process.stderr.write(`refusing to run: Walnut's home resolved to ${WALNUT_HOME}, not the scratch home\n`);
  process.exit(3);
}
const { collectCandidates } = await import(src('core/org/reflection/candidates.ts'));
const { messagesFromAsks, rulesTextOf, threadsFromRecords } = await import(src('core/org/reflection/inputs.ts'));
const { replyLanguageText } = await import(src('core/sessions/output-mode.ts'));
const YAML = (await import('yaml')).default;

// ── The home's data, read-only ──
// Tasks live in tasks/tasks.sqlite (tasks.json only on old homes): read a copy of the database
// (with its WAL, so the newest rows are in it), never the live file.
async function readTasks() {
  const db = path.join(homeAbs, 'tasks', 'tasks.sqlite');
  if (fs.existsSync(db) && fs.statSync(db).size > 0) {
    const copy = path.join(scratch, 'tasks-copy.sqlite');
    fs.copyFileSync(db, copy);
    for (const ext of ['-wal', '-shm']) if (fs.existsSync(db + ext)) fs.copyFileSync(db + ext, copy + ext);
    const Database = (await import(src('lib/sqlite.ts'))).default;
    const { rowToTask } = await import(src('core/task-db.ts'));
    const handle = new Database(copy);
    try { return handle.prepare('SELECT * FROM tasks').all().map(rowToTask); } finally { handle.close(); }
  }
  return readJson(path.join(homeAbs, 'tasks', 'tasks.json'), null)?.tasks;
}
const tasks = await readTasks();
if (!Array.isArray(tasks)) {
  process.stderr.write(`no tasks in ${path.join(homeAbs, 'tasks')}\n`);
  process.exit(1);
}
const config = (() => { try { return YAML.parse(readText(path.join(homeAbs, 'config.yaml'))) ?? {}; } catch { return {}; } })();
const replyLanguage = replyLanguageText(config);
const idOk = (id) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);

// The same mapping the server uses (src/core/org/reflection/inputs.ts), from the files as they are.
const readThreads = async (taskId) => (idOk(taskId) ? threadsFromRecords(readJson(path.join(homeAbs, 'org', 'threads', `${taskId}.json`), null)?.threads) : []);
const readMessages = async (taskId) => (idOk(taskId) ? messagesFromAsks(readJson(path.join(homeAbs, 'user-asks', `${taskId}.json`), null)?.asks) : []);

// A local Claude Code session's JSONL, found by its file name under the projects folder.
let jsonlIndex = null;
const transcripts = { found: new Set(), missing: new Set() };
const jsonlOf = (sid) => {
  if (!jsonlIndex) {
    jsonlIndex = new Map();
    for (const d of (() => { try { return fs.readdirSync(projectsDir); } catch { return []; } })()) {
      for (const f of (() => { try { return fs.readdirSync(path.join(projectsDir, d)); } catch { return []; } })()) {
        if (f.endsWith('.jsonl')) jsonlIndex.set(f.slice(0, -6), path.join(projectsDir, d, f));
      }
    }
  }
  return jsonlIndex.get(sid);
};
const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '');
const readTranscript = async (sid, opts) => {
  const file = jsonlOf(sid);
  if (!file) { transcripts.missing.add(sid); return []; }
  transcripts.found.add(sid);
  const rows = [];
  for (const line of readText(file).split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if ((e?.type !== 'user' && e?.type !== 'assistant') || !e.timestamp || e.isMeta) continue;
    if (opts?.before && e.timestamp >= opts.before) continue;
    const content = e.message?.content;
    if (e.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) if (b?.type === 'tool_use') rows.push({ kind: 'tool', role: 'assistant', text: b.name ?? 'tool', timestamp: e.timestamp });
    }
    const text = textOf(content).trim();
    if (text) rows.push({ kind: 'text', role: e.type, text, timestamp: e.timestamp });
  }
  return rows.slice(-400);
};

// ── The day: from its local midnight to its end, as a pass at its last minute would see it ──
const [y, m, d] = day.split('-').map(Number);
const dayStart = new Date(y, m - 1, d).getTime();
const dayEnd = new Date(y, m - 1, d + 1).getTime() - 1;
const deps = { readTranscript, readMessages, readThreads, replyLanguage: async () => replyLanguage, nowMs: () => dayEnd };
const nodes = tasks.filter((t) => (t.org_role === 'main' || t.org_role === 'lead') && (onlyNode ? t.id === onlyNode : t.phase !== 'COMPLETE'));
if (onlyNode && !nodes.length) {
  process.stderr.write(`no Main or lead task ${onlyNode} in ${homeAbs}\n`);
  process.exit(1);
}

// --judge: the server's own verdict step (pipeline.ts verdictOf), with this home's rules and guidance; it sends nothing.
const judging = judgeOn ? await (async () => {
  const [{ verdictOf }, { callModelDefault }, { parseGuidance }] = await Promise.all([
    import(src('core/org/reflection/pipeline.ts')), import(src('core/org/reflection/judge.ts')), import(src('core/org/reflection/records.ts')),
  ]);
  const callModel = callModelDefault();
  const user = readText(path.join(homeAbs, 'memory', 'USER.md'));
  return async (node, c) => {
    const dir = path.join(homeAbs, 'artifacts', 'nodes', node.id);
    const guidance = parseGuidance(readText(path.join(dir, 'guidance.md'))).map((l) => l.text);
    const rulesText = async () => rulesTextOf(user, readText(path.join(dir, 'MEMORY.md')));
    return verdictOf(node, c, { ...deps, rulesText, callModel }, guidance);
  };
})() : null;

const out = { home: homeAbs, day, replyLanguage, nodes: nodes.map((n) => ({ id: n.id, title: n.title })), candidates: [] };
for (const node of nodes) {
  const { candidates } = await collectCandidates(node, tasks, new Date(dayStart).toISOString(), new Set(), deps);
  for (const c of candidates.filter((x) => Date.parse(x.to) >= dayStart).sort((a, b) => a.to.localeCompare(b.to))) {
    const text = c.answer?.text ?? c.ask?.text ?? c.messages.map((x) => x.text).join(' / ');
    const row = {
      kind: c.signal, at: c.to, node: node.id, taskId: c.task.id, ...(c.thread ? { threadId: c.thread.id } : {}),
      text: text.slice(0, 200), why: c.why,
    };
    if (judging) row.verdict = await judging(node, c).catch((err) => ({ verdict: 'unverified', why: `the judge call failed: ${err?.message ?? err}` }));
    out.candidates.push(row);
  }
}
out.counts = out.candidates.reduce((acc, c) => ({ ...acc, [c.kind]: (acc[c.kind] ?? 0) + 1 }), {});
out.countsByNode = out.candidates.reduce((acc, c) => ({ ...acc, [c.node]: { ...acc[c.node], [c.kind]: (acc[c.node]?.[c.kind] ?? 0) + 1 } }), {});
out.transcripts = { found: transcripts.found.size, missing: transcripts.missing.size };
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
fs.rmSync(scratch, { recursive: true, force: true });
// The logger and other modules keep timers: the replay is done.
process.exit(0);
