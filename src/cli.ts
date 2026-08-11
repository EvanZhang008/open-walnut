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
  .description('Open Walnut — Personal AI butler & task manager')
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
      console.log('Run `open-walnut web` to start the web GUI, or `open-walnut chat` for CLI chat.');
    }
  }
});

program.parseAsync(process.argv);
