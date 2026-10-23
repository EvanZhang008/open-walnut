/**
 * Refresh the bundled model price snapshot (src/data/pricing/model-prices.json)
 * from LiteLLM's public price file. The server refreshes its own copy daily
 * (src/core/usage/price-book.ts); this snapshot is what a fresh install, an
 * offline machine, or a failed refresh falls back to.
 *
 *   bun scripts/update-model-prices.ts [path-to-downloaded.json]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { LITELLM_PRICES_URL, trimLiteLlmPrices } from '../src/core/usage/price-data.js';

const out = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'data', 'pricing', 'model-prices.json');
const local = process.argv[2];
const text = local ? await fs.readFile(local, 'utf8') : await (await fetch(LITELLM_PRICES_URL, { signal: AbortSignal.timeout(60_000) })).text();
const snapshot = trimLiteLlmPrices(JSON.parse(text), new Date().toISOString());
const sorted = Object.fromEntries(Object.entries(snapshot.models).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
await fs.writeFile(out, JSON.stringify({ ...snapshot, models: sorted }, null, 0).replace(/},"/g, '},\n"') + '\n');
console.log(`${Object.keys(sorted).length} models -> ${out}`);
