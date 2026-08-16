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
program.exitOverride((err) => {
  const stray = process.argv.slice(2).find((a) => !a.startsWith('-'));
  if (err.code === 'commander.excessArguments' && stray) {
    console.error(`Unknown command: ${stray}`);
    console.error('');
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
