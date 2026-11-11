#!/usr/bin/env bun
/** Read-only aggregation of click-to-content records from Walnut's structured browser logs. */
import fs from 'node:fs';
import readline from 'node:readline';

const files = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
const client = process.argv.includes('--mac-app') ? 'mac-app' : null;
if (!files.length) {
  process.stderr.write('Usage: bun scripts/session-open-report.mjs [--mac-app] <log> [log...]\n');
  process.exit(1);
}
const groups = new Map();
let unreadable = 0;
for (const file of files) {
  for await (const line of readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.subsystem !== 'browser' || !record.message?.includes('[session-open] first content')) continue;
    let data;
    try {
      const args = typeof record.args === 'string' ? JSON.parse(record.args) : record.args;
      data = Array.isArray(args) ? args[0] : args;
      if (!data?.sessionId) {
        const at = record.message.indexOf('{');
        if (at >= 0) data = JSON.parse(record.message.slice(at));
      }
    } catch { unreadable++; continue; }
    if (!data || !Number.isFinite(data.ms) || (client && data.client !== client)) continue;
    const key = `${data.client ?? 'unknown'}:${data.cache ?? 'unknown'}:${data.entry ?? 'unknown'}${data.hiddenDuringOpen ? ':hidden' : ''}`;
    if (!groups.has(key)) groups.set(key, { values: [], timeouts: 0 });
    const group = groups.get(key);
    if (data.outcome === 'content') group.values.push(data.ms);
    else group.timeouts++;
  }
}
const report = {};
for (const [key, group] of groups) {
  group.values.sort((a, b) => a - b);
  report[key] = {
    n: group.values.length,
    p50: group.values.length ? group.values[Math.floor(group.values.length / 2)] : null,
    worst: group.values.length ? group.values.at(-1) : null,
    atLeast30s: group.timeouts,
  };
}
process.stdout.write(JSON.stringify({ groups: report, unreadable, note: Object.keys(report).length ? 'Measured opens only; absent groups are unverified.' : 'No measured opens; nothing is verified.' }, null, 2) + '\n');
