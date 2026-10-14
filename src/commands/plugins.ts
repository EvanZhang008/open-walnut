/**
 * `walnut plugin add <source>` / `walnut plugin list`: the Plugin Store from a
 * terminal, for a README that says "run this once".
 *
 * <source> is anything the store's input takes: a git URL, an npm package spec,
 * a share snippet, or an install link (open-walnut://install-plugin?…). The
 * server does the install (src/web/routes/plugin-sources.ts); typing the
 * command is the user's yes, the same as the store's trust switch.
 */
import chalk from 'chalk';
import { outputJson } from '../utils/json-output.js';
import { apiGet, apiPost, reportApiError } from '../utils/api-client.js';
import type { GlobalOptions } from '../core/types.js';

/** A git clone or an npm install of a large plugin pack can take a while. */
const INSTALL_TIMEOUT_MS = 180_000;

interface SourcePlugin { id: string | null; name?: string; status?: string; error?: string }
interface SourceRow {
  slug: string;
  kind?: 'git' | 'npm';
  url?: string;
  spec?: string;
  ref?: string;
  resolved?: string;
  lastSha?: string;
  plugins: SourcePlugin[];
  installLink?: string;
  pendingDependencies?: Array<{ id: string }>;
}

/** The request body for one source. The server sorts it out: a bare `url` that
 *  is neither a git URL, a snippet nor a link but is an npm spec installs from npm. */
export function sourceBody(source: string, ref?: string): Record<string, string> {
  const url = source.trim();
  return ref ? { url, ref } : { url };
}

function describe(row: SourceRow): string {
  const where = row.kind === 'npm' ? (row.resolved ?? row.spec ?? row.slug) : `${row.url ?? row.slug}${row.ref ? ` (${row.ref})` : ''}`;
  return `${chalk.bold(row.slug)}  ${chalk.dim(where)}`;
}

function pluginLine(p: SourcePlugin): string {
  const status = p.status ?? 'unknown';
  const color = status === 'loaded' ? chalk.green : status === 'needs-config' ? chalk.yellow : chalk.red;
  return `  ${p.id ?? '(no id)'}  ${color(status)}${p.error ? chalk.dim(`  ${p.error}`) : ''}`;
}

export async function runPluginAdd(source: string, options: { ref?: string }, globals: GlobalOptions): Promise<void> {
  try {
    const row = await apiPost<SourceRow>('/api/plugin-sources', sourceBody(source, options.ref), { timeoutMs: INSTALL_TIMEOUT_MS });
    if (globals.json) { outputJson(row); return; }
    console.log(`Added ${describe(row)}`);
    if (row.plugins.length === 0) console.log(chalk.yellow('  No plugin found: a source needs a manifest.json at its root or in a folder.'));
    for (const p of row.plugins) console.log(pluginLine(p));
    if (row.plugins.some((p) => p.status === 'needs-config')) {
      console.log(chalk.dim('  Finish setup in Settings > Plugin Store (Configure on the row).'));
    }
    if (row.pendingDependencies?.length) {
      console.log(chalk.dim(`  Also needed: ${row.pendingDependencies.map((d) => d.id).join(', ')}. Install them from Settings > Plugin Store.`));
    }
  } catch (err) {
    reportApiError(err, globals);
  }
}

export async function runPluginList(globals: GlobalOptions): Promise<void> {
  try {
    const rows = await apiGet<SourceRow[]>('/api/plugin-sources');
    if (globals.json) { outputJson(rows); return; }
    if (rows.length === 0) { console.log('No plugin sources. Add one with: walnut plugin add <git url | npm package | install link>'); return; }
    for (const row of rows) {
      console.log(describe(row));
      for (const p of row.plugins) console.log(pluginLine(p));
    }
  } catch (err) {
    reportApiError(err, globals);
  }
}
