import { Command } from 'commander';
import { registerCommands } from './commands/index.js';
import { outputJson } from './utils/json-output.js';
import { initLogging } from './logging/index.js';
import type { GlobalOptions } from './core/types.js';

const program = new Command();

// Initialize logging early
initLogging();

program
  .name('walnut')
  .version('0.1.0')
  .description('Personal intelligent butler - CLI task manager')
  .option('--json', 'Output as JSON', false);

registerCommands(program);

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
      console.log('Run `walnut web` to start the web GUI, or `walnut chat` for CLI chat.');
    }
  }
});

program.parseAsync(process.argv);
