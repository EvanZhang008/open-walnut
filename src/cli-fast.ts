/**
 * cli-fast — the slim entry every DATA command runs through.
 *
 * One interface, one rule (design decision 2026-08-20): a command that just
 * asks the local server for data — `tools`, `add`, `tasks`, `done`, `recall`,
 * `projects`, `sessions`, `start` — is one HTTP request (~10ms) and must not
 * pay the full bundle's ~0.5s boot (tsup builds dist/cli.js as one unsplit
 * 6.3MB file that eagerly loads express/sharp/openai/aws-sdk). This entry's
 * static graph is the op registry (zod) + fetch + chalk (~55KB, ~0.1s), and it
 * serves humans and agents alike — there is no separate "agent path".
 *
 * Process-owning or interactive commands (web, mcp, chat, sync, backup, logs,
 * device, lists, subtask, session-server) stay on the full entry: they run for
 * seconds-to-forever, so boot cost is irrelevant there.
 *
 * bin/open-walnut.js routes here by SUBCOMMAND NAME (LITE_COMMANDS below and a
 * mirror list in the bin shim — keep them in sync). Unknown/absent subcommands
 * also fall through to the full CLI so commander can print help / guess hints.
 *
 * Keep this file's imports SLIM. Adding a static import that transitively
 * reaches the web server graph silently re-inflates every call — if you need
 * something heavy, it belongs in the full CLI, not here. WALNUT_CLI_DIRECT=1
 * is also full-CLI-only (the bin shim routes it there): the direct runners
 * drag in core/task-manager, which is exactly what this bundle must not hold.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Data subcommands served by this entry. Mirrored in bin/open-walnut.js. */
export const LITE_COMMANDS = new Set([
  'tools', 'add', 'tasks', 'done', 'recall', 'projects', 'sessions', 'start',
]);

const argv = process.argv.slice(2);

// --version / -V: read the real version from package.json (dist/cli-fast.js →
// ../package.json), same source the full CLI uses.
if (argv.includes('--version') || argv.includes('-V')) {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    console.log((JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string }).version ?? '0.0.0');
  } catch {
    console.log('0.0.0');
  }
  process.exit(0);
}

// Global flags the full CLI accepts before the subcommand; the data commands
// only care about --json.
const json = argv.includes('--json');
const rest = argv.filter((a) => a !== '--json');
const sub = rest.find((a) => !a.startsWith('-'));
const subIdx = sub === undefined ? -1 : rest.indexOf(sub);
const args = subIdx === -1 ? [] : rest.slice(subIdx + 1);
const globals = { json };

/** Positional args (flag values are handled per-command, minimal grammar). */
function positional(list: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].startsWith('-')) { i++; continue; } // skip flag + its value
    out.push(list[i]);
  }
  return out;
}

/** `--flag value` lookup supporting both long and short names. */
function flagValue(list: string[], ...names: string[]): string | undefined {
  for (let i = 0; i < list.length; i++) {
    if (names.includes(list[i])) return list[i + 1];
  }
  return undefined;
}

function hasFlag(list: string[], ...names: string[]): boolean {
  return list.some((a) => names.includes(a));
}

/** Missing-argument error in commander's voice, exit 1. */
function usageError(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

switch (sub) {
  case 'tools': {
    const { runTools } = await import('./commands/tools.js');
    await runTools(args, globals);
    break;
  }
  case 'add': {
    const [title] = positional(args);
    if (!title) usageError("missing required argument 'title'");
    const { runAdd } = await import('./commands/add.js');
    await runAdd(title, {
      priority: flagValue(args, '--priority', '-p') ?? 'none',
      list: flagValue(args, '--list', '-l'),
      project: flagValue(args, '--project'),
      due: flagValue(args, '--due', '-d'),
    }, globals);
    break;
  }
  case 'tasks': {
    const { runTasks } = await import('./commands/tasks.js');
    await runTasks({
      status: flagValue(args, '--status', '-s'),
      project: flagValue(args, '--project'),
    }, globals);
    break;
  }
  case 'done': {
    const [id] = positional(args);
    if (!id) usageError("missing required argument 'id'");
    const { runDone } = await import('./commands/done.js');
    await runDone(id, globals);
    break;
  }
  case 'recall': {
    const [query] = positional(args);
    if (!query) usageError("missing required argument 'query'");
    const { runRecall } = await import('./commands/recall.js');
    await runRecall(query, globals);
    break;
  }
  case 'projects': {
    const { runProjects } = await import('./commands/projects.js');
    await runProjects(globals);
    break;
  }
  case 'sessions': {
    const { runSessions } = await import('./commands/sessions.js');
    await runSessions(globals);
    break;
  }
  case 'start': {
    const [taskId] = positional(args);
    if (!taskId) usageError("missing required argument 'task_id'");
    const { runStart } = await import('./commands/start.js');
    await runStart(taskId, {
      resume: hasFlag(args, '--resume'),
      prompt: flagValue(args, '--prompt'),
    }, globals);
    break;
  }
  default: {
    // Shouldn't happen (the bin shim routes only LITE_COMMANDS here), but a
    // graceful fallback to the full CLI beats a dead end. The import path goes
    // through a variable ON PURPOSE: a literal './cli.js' gets inlined by the
    // bundler and balloons this bundle right back to 6.3MB.
    const fullEntry = './cli.js';
    await import(/* @vite-ignore */ fullEntry);
  }
}
