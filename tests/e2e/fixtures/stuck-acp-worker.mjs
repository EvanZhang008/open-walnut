#!/usr/bin/env node
// An ACP worker that does NOT exit when its daemon dies (a wedged worker), with a
// child standing in for its adapter in the same process group. Worker mode (with
// --journal) answers the daemon's start; adapter mode (--adapter) only writes its
// witness line ({pid, ppid}) and waits. Only `shutdown` ends the worker.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

if (process.argv.includes('--adapter')) {
  if (process.env.MOCK_ACP_WITNESS) {
    fs.appendFileSync(process.env.MOCK_ACP_WITNESS, JSON.stringify({ event: 'ready', pid: process.pid, ppid: process.ppid }) + '\n');
  }
  setInterval(() => {}, 1 << 30);
} else {
  const journalPath = process.argv[process.argv.indexOf('--journal') + 1];
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  if (!fs.existsSync(journalPath)) fs.writeFileSync(journalPath, '');
  const adapter = spawn(process.execPath, [process.argv[1], '--adapter'], { stdio: 'ignore' });
  const reply = (id, result) => process.stdout.write(JSON.stringify({ id, ok: true, result }) + '\n');
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const request = JSON.parse(line);
    if (request.op === 'initialize') reply(request.id, {});
    else if (request.op === 'newSession') reply(request.id, { sessionId: 'stuck-provider-session' });
    else if (request.op === 'getState') reply(request.id, { providerSessionId: 'stuck-provider-session', turnActive: false, controlActive: false, pendingPermissions: [], capabilities: {} });
    else if (request.op === 'shutdown') { reply(request.id, { shutdown: true }); adapter.kill('SIGKILL'); process.exit(0); }
  });
  // stdin closing (the daemon died) is ignored on purpose.
  process.stdout.on('error', () => {});
  setInterval(() => {}, 1 << 30);
}
