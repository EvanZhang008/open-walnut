// A stand-in `ssh` with OpenSSH's ControlMaster behaviour, for tests that must not
// run the real one (tests/setup/exec-guard.ts). State lives in FAKE_SSH_STATE:
//   calls.jsonl        every invocation (argv), one line each
//   credential-expired present: a new login fails, as with an expired certificate
//   link-dead          present: a master's process answers but its link carries nothing
// A master is a real detached process listening on the ControlPath socket, so the
// code under test sees a real socket, owned by this user, that outlives this script.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

const STATE = process.env.FAKE_SSH_STATE;
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(STATE, 'calls.jsonl'), JSON.stringify(argv) + '\n');

const opt = (name) => {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === '-o' && argv[i + 1].startsWith(`${name}=`)) return argv[i + 1].slice(name.length + 1);
  }
  return undefined;
};
const control = opt('ControlPath');
const ctl = argv.includes('-O') ? argv[argv.indexOf('-O') + 1] : undefined;
const has = (f) => fs.existsSync(path.join(STATE, f));

const reachable = (sock) => new Promise((resolve) => {
  const c = net.connect(sock, () => { c.end(); resolve(true); });
  c.on('error', () => resolve(false));
});

async function main() {
  if (ctl === 'check') {
    if (control && await reachable(control)) { process.stderr.write('Master running\n'); return 0; }
    process.stderr.write('Control socket connect: Connection refused\n');
    return 255;
  }
  if (ctl === 'exit') {
    const pidFile = `${control}.pid`;
    if (!fs.existsSync(pidFile)) return 255;
    try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM'); } catch { /* gone */ }
    fs.rmSync(pidFile, { force: true });
    fs.rmSync(control, { force: true });
    process.stderr.write('Exit request sent.\n');
    return 0;
  }
  if (ctl === 'cancel') return 0;
  if (argv.includes('-fN') && opt('ControlMaster') === 'yes') {
    if (has('credential-expired')) { process.stderr.write('Permission denied (publickey).\n'); return 255; }
    const child = spawn(process.execPath, ['-e', `
      const net = require('node:net'); const fs = require('node:fs');
      const srv = net.createServer((s) => s.end());
      srv.listen(${JSON.stringify(control)}, () => fs.writeFileSync(${JSON.stringify(`${control}.pid`)}, String(process.pid)));
      setTimeout(() => process.exit(0), 120000);
    `], { detached: true, stdio: 'ignore' });
    child.unref();
    for (let i = 0; i < 100 && !fs.existsSync(`${control}.pid`); i++) await new Promise((r) => setTimeout(r, 20));
    return fs.existsSync(`${control}.pid`) ? 0 : 255;
  }
  if (argv[argv.length - 1] === 'true' && control) {
    if (await reachable(control) && !has('link-dead')) return 0;
    return 255;
  }
  return 255;
}

main().then((code) => process.exit(code));
