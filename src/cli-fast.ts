/**
 * cli-fast — slim entry for the agent-facing hot path.
 *
 * `walnut tools list|help|call` is what agents run in a loop, and its real work
 * is one local HTTP request (~10ms). The full CLI bundle (dist/cli.js) eagerly
 * loads express/sharp/openai/aws-sdk because tsup builds it as a single
 * unsplit file, costing ~0.5s of boot before that request can even start.
 * This entry's static import graph is just the op registry (zod) + fetch, so
 * the same call answers in ~0.1s. bin/open-walnut.js routes here when the
 * command is `tools` (or --version); every other command still loads dist/cli.js.
 *
 * Keep this file's imports SLIM. Adding a static import that transitively
 * reaches the web server graph silently re-inflates every agent call — if you
 * need something heavy, dynamic-import it inside the branch that uses it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTools } from './commands/tools.js';

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

// Strip the leading `tools` plus the global --json flag; everything else is
// runTools's own subcommand grammar (list | help <op> | call <op> ...).
const json = argv.includes('--json');
const rest = argv.filter((a) => a !== '--json');
const toolsIdx = rest.indexOf('tools');

await runTools(rest.slice(toolsIdx + 1), { json });
