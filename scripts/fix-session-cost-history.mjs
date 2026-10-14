#!/usr/bin/env node
import Database from '../node_modules/better-sqlite3/lib/index.js';
import path from 'node:path';
import os from 'node:os';

const apply = process.argv.includes('--apply');
const root = (process.env.OPEN_WALNUT_API_URL || 'http://127.0.0.1:3456').replace(/\/$/, '');
const dbPath = process.env.DB || path.join(os.homedir(), '.open-walnut', 'usage.sqlite');

async function request(route, options = {}) {
  const response = await fetch(root + route, { ...options, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Usage API returned ${response.status}`);
  return response.json();
}

if (apply && process.env.OPEN_WALNUT_API_URL && !process.env.DB) {
  throw new Error('Set DB to the ledger served by OPEN_WALNUT_API_URL before applying a rebuild.');
}
const before = await request('/api/usage/overview?limit=1');
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', before: before.summary, accuracy: before.accuracy }, null, 2));
if (!apply) {
  console.log('Dry run only. --apply backs up the ledger and rebuilds response evidence through each host daemon. Legacy turn records remain for audit; their amounts are not trusted.');
  process.exit(0);
}
if (!before.accuracy) throw new Error('Deploy the response-evidence collector before rebuilding history.');

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const backup = `${dbPath}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
try { await db.backup(backup); } finally { db.close(); }
console.log(`Ledger backup: ${backup}`);
const until = new Date().toISOString();
const collection = await request('/api/usage/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ until }) });
if (!collection.id || collection.since !== undefined || collection.until !== until) {
  throw new Error('Another collection is already running. Wait for it to finish before rebuilding all history.');
}
const deadline = Date.now() + 20 * 60_000;
while (Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 5_000));
  const state = await request('/api/usage/collection');
  if (state.id !== collection.id || state.since !== undefined || state.until !== until) {
    throw new Error('The active collection changed. Rebuild coverage could not be verified.');
  }
  if (state.running) continue;
  if (state.error) throw new Error(state.error);
  const after = await request('/api/usage/overview?limit=1');
  console.log(JSON.stringify({ after: after.summary, accuracy: after.accuracy }, null, 2));
  if (after.accuracy.checks.some(check => check.source === 'Host collection')) process.exitCode = 1;
  break;
}
if (Date.now() >= deadline) throw new Error('Collection is still running; its status remains available in Usage & Costs.');
