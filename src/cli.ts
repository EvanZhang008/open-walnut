import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerCommands } from './commands/index.js';
import { outputJson } from './utils/json-output.js';
import { initLogging } from './logging/index.js';
import type { GlobalOptions } from './core/types.js';

// Read the real version from package.json (dist/cli.js → ../package.json).
// Hardcoding drifted once already (0.1.0 while the package shipped 0.3.0).
const packageVersion = (() => {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return (JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const program = new Command();

// Initialize logging early
initLogging();

// WALNUT_CLI_DIRECT=1: install the in-process legacy runners for the data
// commands (tests / rollback lever). Only this full entry may load them — the
// slim entry must never see core/task-manager (see commands/direct-registry.ts).
if (process.env.WALNUT_CLI_DIRECT === '1') {
  const { installDirect } = await import('./commands/direct-commands.js');
  installDirect();
}

program
  .name('open-walnut')
  .version(packageVersion)
  .description('Open Walnut — Personal AI & task manager')
  .option('--json', 'Output as JSON', false);

registerCommands(program);

// Unknown-command guidance. Commander's default for a stray argument is
// "error: too many arguments" — which tells an agent (or a human) nothing about
// where the capability actually lives. Measured cost of that silence
// (2026-08-16 agent eval): an agent asked "which task made commit X" guessed
// `walnut task-for-commit`, got "too many arguments", and burned FIVE turns on
// --help spelunking before finding `walnut tools call`. Point at the catalog.
program.showSuggestionAfterError(true);

/**
 * The handful of things people (and agents) actually type when they guess.
 * Naming the op is not enough — a 2026-08-20 eval watched an agent guess
 * `walnut status`, then `/api/system`, then read `ps aux` and invent
 * "mode=web" from the process list, never once running an op. Printing the
 * exact runnable line ends the guessing in one step.
 */
const GUESS_HINTS: Record<string, string> = {
  status: "walnut tools call walnut_status '{}'",
  version: 'walnut --version',
  info: "walnut tools call walnut_status '{}'",
  health: "walnut tools call walnut_status '{}'",
  mode: "walnut tools call walnut_status '{}'",
  search: `walnut tools call search '{"q":"..."}'`,
  find: `walnut tools call search '{"q":"..."}'`,
  task: "walnut tools call task_list '{}'",
  list: "walnut tools call task_list '{}'",
  session: "walnut tools call session_list '{}'",
  project: "walnut tools call project_list '{}'",
  commit: `walnut tools call search '{"q":"<sha>"}'   # resolves to the owning task + session`,
  note: `walnut tools call note_search '{"q":"..."}'`,
  memory: `walnut tools call memory_read '{"doc":"global"}'`,
};

program.exitOverride((err) => {
  const stray = process.argv.slice(2).find((a) => !a.startsWith('-'));
  if (err.code === 'commander.excessArguments' && stray) {
    console.error(`Unknown command: ${stray}`);
    console.error('');
    const key = Object.keys(GUESS_HINTS).find((k) => stray.toLowerCase().includes(k));
    if (key) {
      console.error('You probably want:');
      console.error(`  ${GUESS_HINTS[key]}`);
      console.error('');
    }
    console.error('Every Walnut capability is available as an operation:');
    console.error('  walnut tools list              # the full catalog');
    console.error('  walnut tools help <op>         # one op\'s parameters');
    console.error("  walnut tools call <op> '{...}' # run it");
    console.error('');
    console.error('Run `walnut --help` for the human subcommands.');
    process.exit(1);
  }
  process.exit(err.exitCode);
});

// Default action: show dashboard or start web server
program.action(async () => {
  const globals = program.opts<GlobalOptions>();

  try {
    const { runDashboard } = await import('./commands/dashboard.js');
    await runDashboard(globals);
  } catch {
    // Dashboard not yet implemented - placeholder
    if (globals.json) {
      outputJson({ dashboard: 'coming soon' });
    } else {
      console.log('Run `open-walnut web` to start the web GUI, or `open-walnut chat` for CLI chat.');
    }
  }
});

program.parseAsync(process.argv);
