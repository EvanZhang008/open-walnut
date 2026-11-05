/**
 * The servers a session started (port-scan-core.ts): listener parsing, attribution
 * to a session, the guard that keeps the daemon, agents and terminals out of reach,
 * and Stop's process-group rules. The host is a fake (PortScanIo) except for the
 * probe tests, which talk to real sockets on loopback.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import {
  agentChildren,
  commandFromCmdline,
  createDaemonPorts,
  createPortScanner,
  guardedPids,
  injectionRoots,
  parseEtime,
  parseLsofListeners,
  parseProcNetTcp,
  parseProcTable,
  parsePsEnvSessions,
  parseSsListeners,
  pageTitle,
  mayBeOneShot,
  probePort,
  sessionFromEnviron,
  shellQuote,
  signalGroup,
  splitHostPort,
  stopTarget,
  type PortScanIo,
  type ProcRow,
  type ScanContext,
  type ServerKind,
} from '../../src/providers/port-scan-core.js';

describe('parsers', () => {
  it('splits every address form ss and lsof print', () => {
    expect(splitHostPort('127.0.0.1:5173')).toEqual({ address: '127.0.0.1', port: 5173 });
    expect(splitHostPort('[::1]:8080')).toEqual({ address: '::1', port: 8080 });
    expect(splitHostPort('[::]:80')).toEqual({ address: '::', port: 80 });
    expect(splitHostPort('*:3000')).toEqual({ address: '*', port: 3000 });
    expect(splitHostPort('127.0.0.53%lo:53')).toEqual({ address: '127.0.0.53', port: 53 });
    expect(splitHostPort('[::ffff:127.0.0.1]:9')).toEqual({ address: '127.0.0.1', port: 9 });
    expect(splitHostPort('0.0.0.0:0')).toBeNull();
    expect(splitHostPort('nonsense')).toBeNull();
  });

  it('reads ss -ltnpH, one listener per owning pid', () => {
    const out = [
      'LISTEN 0      512             127.0.0.1:49267 0.0.0.0:* users:(("bun",pid=4777,fd=8))',
      'LISTEN 0      128               0.0.0.0:3027  0.0.0.0:*',
      'LISTEN 0      511                  [::]:5173     [::]:* users:(("node",pid=12,fd=20),("node",pid=13,fd=20))',
      'garbage line',
    ].join('\n');
    expect(parseSsListeners(out)).toEqual([
      { address: '127.0.0.1', port: 49267, pid: 4777 },
      { address: '::', port: 5173, pid: 12 },
      { address: '::', port: 5173, pid: 13 },
    ]);
  });

  it('reads lsof -F pn, sockets under the process that holds them', () => {
    const out = 'p501\nf12\nn*:5173\nf13\nn[::1]:5173\np777\nf3\nn127.0.0.1:8000\n';
    expect(parseLsofListeners(out)).toEqual([
      { address: '*', port: 5173, pid: 501 },
      { address: '::1', port: 5173, pid: 501 },
      { address: '127.0.0.1', port: 8000, pid: 777 },
    ]);
  });

  it('reads /proc/net/tcp and tcp6 listeners with their inodes', () => {
    const v4 = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1',
      '   1: 0100007F:1F90 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 4343 1',
    ].join('\n');
    expect(parseProcNetTcp(v4)).toEqual([{ address: '127.0.0.1', port: 5173, inode: '4242' }]);
    const v6 = [
      '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 00000000000000000000000001000000:1F40 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 99 1',
      '   1: 00000000000000000000000000000000:0050 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 98 1',
      '   2: 0000000000000000FFFF00000100007F:0051 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 97 1',
    ].join('\n');
    expect(parseProcNetTcp(v6)).toEqual([
      { address: '::1', port: 8000, inode: '99' },
      { address: '::', port: 80, inode: '98' },
      { address: '127.0.0.1', port: 81, inode: '97' },
    ]);
  });

  it('reads ps etime and the process table (macOS prints comm as a path)', () => {
    expect(parseEtime('05:07')).toBe(307);
    expect(parseEtime('02:05:07')).toBe(7507);
    expect(parseEtime('3-02:05:07')).toBe(3 * 86400 + 7507);
    expect(parseEtime('bad')).toBeNull();
    const t = parseProcTable('  1     0     1   9-00:00:00 /sbin/launchd\n 42     1    42        00:03 /usr/local/bin/node\n');
    expect(t.get(42)).toEqual({ pid: 42, ppid: 1, pgid: 42, ageSec: 3, comm: 'node' });
  });

  it('names the session from the agent variable first, the terminal variable second', () => {
    expect(sessionFromEnviron('A=1\0WALNUT_SESSION_ID=s1\0B=2\0')).toEqual({ sid: 's1', terminal: false });
    expect(sessionFromEnviron('WALNUT_TERMINAL_SESSION_ID=t1\0WALNUT_SESSION_ID=s1\0')).toEqual({ sid: 's1', terminal: false });
    expect(sessionFromEnviron('WALNUT_TERMINAL_SESSION_ID=t1\0')).toEqual({ sid: 't1', terminal: true });
    expect(sessionFromEnviron('WALNUT_SESSION_ID=\0')).toBeNull();
    expect(sessionFromEnviron('X=1')).toBeNull();
  });

  it('reads macOS ps -E: the last assignment wins', () => {
    const out = [
      '  501 node vite --port 5173 PATH=/bin WALNUT_SESSION_ID=s1 HOME=/u',
      '  502 python3 -m http.server WALNUT_TERMINAL_SESSION_ID=t9 TERM=xterm',
      '  503 node x.js WALNUT_SESSION_ID=old WALNUT_SESSION_ID=new',
      '  504 bash',
    ].join('\n');
    const m = parsePsEnvSessions(out);
    expect(m.get(501)).toEqual({ sid: 's1', terminal: false });
    expect(m.get(502)).toEqual({ sid: 't9', terminal: true });
    expect(m.get(503)).toEqual({ sid: 'new', terminal: false });
    expect(m.has(504)).toBe(false);
  });
});

/**
 * A throwaway self-signed certificate for the loopback TLS probe test, made at run time
 * (no key is kept in the repo); null where openssl is missing.
 */
function testCertificate(): { key: string; cert: string } | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'port-scan-tls-'))
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore', timeout: 20_000 })
    return { key: fs.readFileSync(path.join(dir, 'k.pem'), 'utf8'), cert: fs.readFileSync(path.join(dir, 'c.pem'), 'utf8') }
  } catch {
    return null
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// ── A fake host ──────────────────────────────────────────────────────────

interface FakeProc { pid: number; ppid: number; pgid: number; comm: string; env?: string; tenv?: string; cmd?: string; age?: number }

/**
 * daemon 100 → claude 200 (S1's agent) → zsh 300 (Bash tool job, pgid 300) → node 301 (vite)
 *            → claude 250 (S2's agent)
 * dtach 400 → zsh 401 (S1's terminal shell) → python3 402 (pgid 402)
 * init → node 500 (orphan of S1 under its OLD id), node 600 (no environment, child of 300)
 */
function baseProcs(): FakeProc[] {
  return [
    { pid: 1, ppid: 0, pgid: 1, comm: 'systemd' },
    { pid: 90, ppid: 1, pgid: 90, comm: 'sh' },
    { pid: 100, ppid: 90, pgid: 90, comm: 'walnut-daemon', env: 'S1' },
    { pid: 200, ppid: 100, pgid: 200, comm: 'claude', env: 'S1' },
    { pid: 250, ppid: 100, pgid: 250, comm: 'claude', env: 'S2' },
    { pid: 300, ppid: 200, pgid: 300, comm: 'zsh', env: 'S1' },
    { pid: 301, ppid: 300, pgid: 300, comm: 'node', env: 'S1', cmd: 'node /w/node_modules/.bin/vite --port 5173', age: 125 },
    { pid: 400, ppid: 1, pgid: 400, comm: 'dtach' },
    { pid: 401, ppid: 400, pgid: 401, comm: 'zsh', tenv: 'S1' },
    { pid: 402, ppid: 401, pgid: 402, comm: 'python3', tenv: 'S1', cmd: 'python3 -m http.server 8000' },
    { pid: 500, ppid: 1, pgid: 500, comm: 'node', env: 'OLD1', cmd: 'node server.js' },
    { pid: 600, ppid: 300, pgid: 300, comm: 'ruby' },
  ];
}

function fakeHost(opts: { procs?: FakeProc[]; listeners?: Array<{ pid: number; port: number; address?: string }>; platform?: string; kinds?: Record<number, ServerKind> } = {}) {
  let procs = opts.procs ?? baseProcs();
  let listeners = opts.listeners ?? [
    { pid: 301, port: 5173, address: '::' }, { pid: 301, port: 5173, address: '0.0.0.0' },
    { pid: 402, port: 8000, address: '0.0.0.0' },
    { pid: 500, port: 4000, address: '127.0.0.1' },
    { pid: 600, port: 4567, address: '127.0.0.1' },
    { pid: 100, port: 9999, address: '127.0.0.1' }, // the daemon's own socket
    { pid: 200, port: 6000, address: '127.0.0.1' }, // the agent's own socket
    { pid: 401, port: 7000, address: '127.0.0.1' }, // the terminal shell
  ];
  const killed: Array<[number, string]> = [];
  let now = 0;
  let psFails = false;
  /** What a SIGTERM to a pid or group does; default: those processes exit. */
  let onKill: (target: number, sig: string) => void = (target) => {
    const gone = target < 0 ? procs.filter((p) => p.pgid === -target).map((p) => p.pid) : [target];
    procs = procs.filter((p) => !gone.includes(p.pid));
    listeners = listeners.filter((l) => !gone.includes(l.pid));
  };
  const platform = opts.platform ?? 'linux';
  const io: PortScanIo = {
    platform,
    run: async (cmd, args) => {
      if (cmd === 'ss') return listeners.map((l) => `LISTEN 0 128 ${l.address?.includes(':') ? `[${l.address}]` : (l.address ?? '127.0.0.1')}:${l.port} 0.0.0.0:* users:(("x",pid=${l.pid},fd=3))`).join('\n');
      if (cmd === 'lsof') return listeners.map((l) => `p${l.pid}\nn${l.address?.includes(':') ? `[${l.address}]` : (l.address ?? '127.0.0.1')}:${l.port}`).join('\n');
      if (cmd === 'ps' && args[0] === '-A') {
        // procps reads two comma-joined blank-headed columns as one: each column needs its own -o.
        expect(args.filter((a) => a === '-o').length).toBe(5)
      }
      if (cmd === 'ps' && args[0] === '-A' && psFails) return null
      if (cmd === 'ps' && args[0] === '-A') return procs.map((p) => `${p.pid} ${p.ppid} ${p.pgid} ${p.age === undefined ? '00:01' : `${Math.floor(p.age / 60)}:${String(p.age % 60).padStart(2, '0')}`} ${p.comm}`).join('\n');
      if (cmd === 'ps' && args[0] === '-E') {
        const want = args[args.length - 1]!.split(',').map(Number);
        return procs.filter((p) => want.includes(p.pid))
          .map((p) => `${p.pid} ${p.cmd ?? p.comm}${p.env ? ` WALNUT_SESSION_ID=${p.env}` : ''}${p.tenv ? ` WALNUT_TERMINAL_SESSION_ID=${p.tenv}` : ''}`).join('\n');
      }
      if (cmd === 'ps' && args[0] === '-ww') {
        const want = args[args.length - 1]!.split(',').map(Number);
        return procs.filter((p) => want.includes(p.pid)).map((p) => `${p.pid} ${p.cmd ?? p.comm}`).join('\n');
      }
      return null;
    },
    readFile: async (path) => {
      const m = /^\/proc\/(\d+)\/(environ|cmdline)$/.exec(path);
      const p = m && procs.find((x) => x.pid === Number(m[1]));
      if (!p) return null;
      if (m![2] === 'cmdline') return (p.cmd ?? p.comm).split(' ').join('\0') + '\0';
      return [p.env && `WALNUT_SESSION_ID=${p.env}`, p.tenv && `WALNUT_TERMINAL_SESSION_ID=${p.tenv}`, 'PATH=/bin'].filter(Boolean).join('\0');
    },
    readdir: async () => null,
    readlink: async () => null,
    probe: async (_a, port) => opts.kinds?.[port] ?? 'http',
    kill: (target, sig) => {
      if (!procs.some((p) => (target < 0 ? p.pgid === -target : p.pid === target))) {
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      }
      killed.push([target, sig]);
      onKill(target, sig);
    },
    now: () => now,
    sleep: async (ms) => { now += ms; },
  };
  return {
    io,
    killed,
    setOnKill: (f: typeof onKill) => { onKill = f; },
    procs: () => procs,
    setProcs: (p: FakeProc[]) => { procs = p; },
    failPs: (v: boolean) => { psFails = v; },
    setListeners: (l: typeof listeners) => { listeners = l; },
  };
}

function ctx(over: Partial<ScanContext> = {}): ScanContext {
  return {
    resolveSid: (raw) => (raw === 'OLD1' ? 'S1' : raw),
    agentPids: new Map([[200, 'S1'], [250, 'S2']]),
    guardPids: [],
    daemonPid: 100,
    ...over,
  };
}

const table = (procs: FakeProc[]): Map<number, ProcRow> =>
  new Map(procs.map((p) => [p.pid, { pid: p.pid, ppid: p.ppid, pgid: p.pgid, ageSec: null, comm: p.comm }]));

describe('scan', () => {
  for (const platform of ['linux', 'darwin']) {
    it(`lists each session's servers and nothing of the daemon, agents or terminal shells (${platform})`, async () => {
      const host = fakeHost({ platform });
      const res = await createPortScanner(host.io).scan(ctx());
      expect(res.source).toBe(platform === 'linux' ? 'ss' : 'lsof');
      const brief = res.servers.map((s) => ({ sid: s.sid, port: s.port, pid: s.pid, via: s.via, stopScope: s.stopScope }));
      expect(brief).toEqual([
        { sid: 'S1', port: 4000, pid: 500, via: 'env', stopScope: 'group' },
        { sid: 'S1', port: 4567, pid: 600, via: 'tree', stopScope: 'group' },
        { sid: 'S1', port: 5173, pid: 301, via: 'env', stopScope: 'group' },
        { sid: 'S1', port: 8000, pid: 402, via: 'terminal', stopScope: 'group' },
      ]);
      const vite = res.servers.find((s) => s.port === 5173)!;
      expect(vite.addresses.sort()).toEqual(['0.0.0.0', '::']);
      expect(vite.loopbackOnly).toBe(false);
      expect(vite.command).toBe('node /w/node_modules/.bin/vite --port 5173');
      expect(vite.ageSec).toBe(125);
      expect(res.servers.find((s) => s.port === 4000)!.loopbackOnly).toBe(true);
    });
  }

  for (const comm of ['walnut-dtach', '/Users/u/.local/share/walnut/bin/walnut-dtach', 'dtach', '/usr/bin/dtach']) {
    it(`a terminal under ${comm} keeps its shell out of reach, even when the master carries the session too`, async () => {
      // The bundled binary is walnut-dtach; a local persistent terminal's master and shell
      // both carry WALNUT_TERMINAL_SESSION_ID, so only the dtach rule keeps the shell guarded.
      const procs = baseProcs().map((p) => (p.pid === 400 ? { ...p, comm, tenv: 'S1' } : p))
      const host = fakeHost({ procs, listeners: [{ pid: 401, port: 7000 }, { pid: 402, port: 8000 }] })
      const scanner = createPortScanner(host.io)
      expect((await scanner.scan(ctx())).servers.map((s) => s.pid)).toEqual([402])
      expect(await scanner.stop(ctx(), { sids: ['S1'], pid: 401, port: 7000 })).toMatchObject({ stopped: false, code: 'not_found' })
      expect(host.killed).toEqual([])
    })
  }

  it('does not probe a young listener on an OS-assigned port (it may serve one login callback), and does once it is older', async () => {
    const procs = [...baseProcs(), { pid: 310, ppid: 300, pgid: 300, comm: 'python3', env: 'S1', age: 5 }, { pid: 311, ppid: 300, pgid: 300, comm: 'node', env: 'S1', age: 5 }]
    const host = fakeHost({ procs, listeners: [{ pid: 310, port: 41234 }, { pid: 311, port: 3000 }] })
    const probed: number[] = []
    host.io.probe = async (_a, port) => { probed.push(port); return 'http' }
    const res = await createPortScanner(host.io).scan(ctx())
    expect(res.servers.map((s) => [s.port, s.kind])).toEqual([[3000, 'http'], [41234, 'unknown']])
    expect(probed).toEqual([3000])
    expect(mayBeOneShot(41234, 5)).toBe(true)
    expect(mayBeOneShot(41234, null)).toBe(true)
    expect(mayBeOneShot(41234, 600)).toBe(false)
    expect(mayBeOneShot(5173, 5)).toBe(false)
    // A sign-in on a fixed port (gcloud's 8085) is a one-shot callback too, while young.
    expect(mayBeOneShot(8085, 5, 'python3 /opt/google-cloud-sdk/lib/gcloud.py auth login')).toBe(true)
    expect(mayBeOneShot(8085, 600, 'python3 /opt/google-cloud-sdk/lib/gcloud.py auth login')).toBe(false)
    expect(mayBeOneShot(5173, 5, 'node vite.js --port 5173')).toBe(false)
  })

  it('two sessions polling one host keep each other\'s probe answers', async () => {
    const procs = [...baseProcs(), { pid: 255, ppid: 250, pgid: 260, comm: 'bash', env: 'S2' }, { pid: 260, ppid: 255, pgid: 260, comm: 'node', env: 'S2' }]
    const host = fakeHost({ procs, listeners: [{ pid: 301, port: 5173 }, { pid: 260, port: 3001 }] })
    let asked = 0
    host.io.probe = async () => { asked++; return 'http' }
    const scanner = createPortScanner(host.io)
    for (let i = 0; i < 3; i++) {
      await scanner.scan(ctx(), { sids: ['S1'] })
      await scanner.scan(ctx(), { sids: ['S2'] })
    }
    expect(asked).toBe(2)
  })

  it('never lists a pid the caller guards (the Walnut server), nor its ancestors', async () => {
    const procs = [...baseProcs(), { pid: 700, ppid: 1, pgid: 700, comm: 'walnut', env: 'S1' }, { pid: 701, ppid: 700, pgid: 700, comm: 'node', env: 'S1' }];
    const host = fakeHost({ procs, listeners: [{ pid: 700, port: 3456 }, { pid: 701, port: 3457 }] });
    const res = await createPortScanner(host.io).scan(ctx({ guardPids: [701] }));
    expect(res.servers).toEqual([]);
  });

  it('attributes nothing it cannot name, and reports the probe kind', async () => {
    const procs = [...baseProcs(), { pid: 800, ppid: 1, pgid: 800, comm: 'postgres' }, { pid: 801, ppid: 300, pgid: 801, comm: 'redis', env: 'S1' }];
    const host = fakeHost({ procs, listeners: [{ pid: 800, port: 5432 }, { pid: 801, port: 6379 }], kinds: { 6379: 'other' } });
    const res = await createPortScanner(host.io).scan(ctx());
    expect(res.servers.map((s) => [s.port, s.kind])).toEqual([[6379, 'other']]);
  });

  it('a server sharing the agent\'s own process group is listed but never stoppable', async () => {
    // An agent that runs its tools in its own group (an ACP adapter does).
    const procs = [...baseProcs(), { pid: 255, ppid: 250, pgid: 250, comm: 'bash', env: 'S2' }, { pid: 260, ppid: 255, pgid: 250, comm: 'node', env: 'S2' }];
    const host = fakeHost({ procs, listeners: [{ pid: 260, port: 3001 }] });
    const res = await createPortScanner(host.io).scan(ctx());
    expect(res.servers.map((s) => [s.port, s.stopScope])).toEqual([[3001, 'none']]);
  });

  it('a group holding a process of no known session stops only the listener', async () => {
    const procs = [...baseProcs(), { pid: 302, ppid: 1, pgid: 300, comm: 'node' }];
    const host = fakeHost({ procs, listeners: [{ pid: 301, port: 5173 }] });
    const res = await createPortScanner(host.io).scan(ctx());
    expect(res.servers[0]!.stopScope).toBe('process');
  });
});

describe('guard', () => {
  it('guards the daemon, its ancestors and children, every agent, and a terminal\'s dtach and shell', () => {
    const g = guardedPids(table(baseProcs()), ctx({ guardPids: [] }));
    expect([...g].sort((a, b) => a - b)).toEqual([90, 100, 200, 250, 400, 401]);
  });

  it('stopTarget refuses init, a guarded pid and a group holding one', () => {
    const t = table(baseProcs());
    const g = guardedPids(t, ctx());
    const sidOf = (pid: number) => ({ 300: 'S1', 301: 'S1', 600: 'S1', 402: 'S1', 500: 'S1' } as Record<number, string>)[pid] ?? null;
    expect(stopTarget(t, 1, g, sidOf, 'S1')).toBeNull();
    expect(stopTarget(t, 200, g, sidOf, 'S1')).toBeNull();
    expect(stopTarget(t, 301, g, sidOf, 'S1')).toEqual({ scope: 'group', pgid: 300 });
    // 600 has no environment: by itself it names no session, so its group is not all S1's.
    expect(stopTarget(t, 301, g, (p) => (p === 600 ? null : sidOf(p)), 'S1')).toEqual({ scope: 'process', pid: 301 });
  });

  // An ACP adapter (the registered agent, 200) runs the real CLI as its child (210, its own
  // group), whose tool shell and dev server stay in that group: a group stop would end the
  // agent. Only the listener is signalled, and the CLI's own port is never listed or stopped.
  it('a group holding an agent\'s own child (an inner CLI) stops only the listener, and that child is never a server', async () => {
    const procs = [
      ...baseProcs().filter((p) => p.pid !== 301 && p.pid !== 600),
      { pid: 210, ppid: 200, pgid: 210, comm: 'claude', env: 'S1' },
      { pid: 211, ppid: 210, pgid: 210, comm: 'bash', env: 'S1' },
      { pid: 212, ppid: 211, pgid: 210, comm: 'node', env: 'S1', cmd: 'node vite.js --port 5173', age: 300 },
    ];
    const host = fakeHost({ procs, listeners: [{ pid: 212, port: 5173 }, { pid: 210, port: 7000 }] });
    const scanner = createPortScanner(host.io);
    const res = await scanner.scan(ctx());
    expect(res.servers.map((s) => s.port)).toEqual([5173]);
    expect(res.servers[0]!.stopScope).toBe('process');
    expect((await scanner.stop(ctx(), { sids: ['S1'], pid: 210, port: 7000 })).stopped).toBe(false);
    const t = table(procs);
    expect(stopTarget(t, 210, guardedPids(t, ctx()), () => 'S1', 'S1', agentChildren(t, ctx()))).toBeNull();
    // A tool's shell under the agent is not shielded: its job is the server's group.
    expect(agentChildren(table(baseProcs()), ctx()).has(300)).toBe(false);
  });

  it('guards the daemon\'s own ancestors even while no agent runs', () => {
    const procs = [{ pid: 1, ppid: 0, pgid: 1, comm: 'systemd' }, { pid: 80, ppid: 1, pgid: 80, comm: 'sshd' }, { pid: 90, ppid: 80, pgid: 90, comm: 'sh' }, { pid: 100, ppid: 90, pgid: 90, comm: 'walnut-daemon' }];
    const g = guardedPids(table(procs), ctx({ agentPids: new Map() }));
    for (const pid of [80, 90, 100]) expect(g.has(pid), `pid ${pid}`).toBe(true);
  });

  // The class guard: for EVERY process of the fixture that is guarded, a listener it
  // holds is never listed and Stop never signals anything. A new kind of guarded
  // process (added to baseProcs or to guardedPids) is covered by this loop.
  it('no guarded process of the fixture is ever listed or signalled', async () => {
    const procs = baseProcs();
    const guarded = guardedPids(table(procs), ctx({ guardPids: [90] }));
    for (const pid of guarded) {
      const host = fakeHost({ listeners: [{ pid, port: 1234 }] });
      const scanner = createPortScanner(host.io);
      const c = ctx({ guardPids: [90] });
      expect((await scanner.scan(c)).servers, `pid ${pid} listed`).toEqual([]);
      for (const sid of ['S1', 'S2', 'OLD1']) {
        const r = await scanner.stop(c, { sids: [sid], pid, port: 1234 });
        expect(r.stopped, `pid ${pid} stopped as ${sid}`).toBe(false);
      }
      expect(host.killed, `pid ${pid} signalled`).toEqual([]);
    }
  });

  it('signalGroup refuses 0 and 1 (its own group and every process the user owns)', () => {
    const kill = (p: number) => { throw new Error(`killed ${p}`); };
    expect(() => signalGroup({ kill }, 0, 'SIGTERM')).toThrow(/refusing/);
    expect(() => signalGroup({ kill }, 1, 'SIGTERM')).toThrow(/refusing/);
    expect(() => signalGroup({ kill }, -5, 'SIGTERM')).toThrow(/refusing/);
    expect(() => signalGroup({ kill }, 2.5, 'SIGTERM')).toThrow(/refusing/);
  });
});

describe('stop', () => {
  it('SIGTERMs the job\'s process group and leaves the agent and shell running', async () => {
    const host = fakeHost();
    const r = await createPortScanner(host.io).stop(ctx(), { sids: ['S1'], pid: 301, port: 5173 });
    expect(r).toEqual({ stopped: true, scope: 'group', signal: 'SIGTERM', confirmed: true });
    expect(host.killed).toEqual([[-300, 'SIGTERM']]);
    const alive = host.procs().map((p) => p.pid);
    expect(alive).toContain(200);
    expect(alive).toContain(401);
    expect(alive).not.toContain(301);
  });

  it('a terminal job: only its own group, never the terminal shell', async () => {
    const host = fakeHost();
    const r = await createPortScanner(host.io).stop(ctx(), { sids: ['S1'], pid: 402, port: 8000 });
    expect(r.stopped).toBe(true);
    expect(host.killed).toEqual([[-402, 'SIGTERM']]);
    expect(host.procs().some((p) => p.pid === 401)).toBe(true);
  });

  it('SIGKILLs after the grace period when the job ignores SIGTERM', async () => {
    const host = fakeHost();
    host.setOnKill((target, sig) => {
      if (sig !== 'SIGKILL') return;
      // Only the SIGKILL ends it.
      const gone = new Set(host.procs().filter((p) => p.pgid === -target).map((p) => p.pid));
      host.procs().splice(0, host.procs().length, ...host.procs().filter((p) => !gone.has(p.pid)));
    });
    const r = await createPortScanner(host.io).stop(ctx(), { sids: ['S1'], pid: 301, port: 5173 });
    expect(r).toEqual({ stopped: true, scope: 'group', signal: 'SIGKILL', confirmed: true });
    expect(host.killed).toEqual([[-300, 'SIGTERM'], [-300, 'SIGKILL']]);
  });

  it('refuses a pid another session owns, one that stopped listening, and a forged port', async () => {
    const host = fakeHost();
    const scanner = createPortScanner(host.io);
    expect(await scanner.stop(ctx(), { sids: ['S2'], pid: 301, port: 5173 })).toMatchObject({ stopped: false, code: 'not_found' });
    expect(await scanner.stop(ctx(), { sids: ['S1'], pid: 301, port: 5174 })).toMatchObject({ stopped: false, code: 'not_found' });
    expect(await scanner.stop(ctx(), { sids: ['S1'], pid: 1, port: 5173 })).toMatchObject({ stopped: false, code: 'not_found' });
    expect(await scanner.stop(ctx(), { sids: ['S1'], pid: Number.NaN, port: 5173 })).toMatchObject({ stopped: false, code: 'not_found' });
    expect(host.killed).toEqual([]);
  });

  it('a renamed session stops its server started under the old id', async () => {
    const host = fakeHost();
    const r = await createPortScanner(host.io).stop(ctx(), { sids: ['S1'], pid: 500, port: 4000 });
    expect(r.stopped).toBe(true);
    expect(host.killed).toEqual([[-500, 'SIGTERM']]);
  });

  it('a mixed group signals the listener alone; the agent\'s group is refused', async () => {
    const procs = [...baseProcs(), { pid: 302, ppid: 1, pgid: 300, comm: 'node' }, { pid: 255, ppid: 250, pgid: 250, comm: 'bash', env: 'S2' }, { pid: 260, ppid: 255, pgid: 250, comm: 'node', env: 'S2' }];
    const host = fakeHost({ procs, listeners: [{ pid: 301, port: 5173 }, { pid: 260, port: 3001 }] });
    const scanner = createPortScanner(host.io);
    expect(await scanner.stop(ctx(), { sids: ['S1'], pid: 301, port: 5173 })).toEqual({ stopped: true, scope: 'process', signal: 'SIGTERM', confirmed: true });
    expect(host.killed).toEqual([[301, 'SIGTERM']]);
    expect(await scanner.stop(ctx(), { sids: ['S2'], pid: 260, port: 3001 })).toMatchObject({ stopped: false, code: 'not_stoppable' });
    expect(host.killed).toEqual([[301, 'SIGTERM']]);
  });
});

describe('createDaemonPorts', () => {
  it('one scan answers polls inside the cache window; a stop starts a fresh one', async () => {
    const host = fakeHost();
    let scans = 0;
    const run = host.io.run;
    host.io.run = async (cmd, args, t) => { if (cmd === 'ss') scans++; return run(cmd, args, t); };
    const ports = createDaemonPorts({ io: host.io, agentPids: () => new Map([[200, 'S1'], [250, 'S2']]), resolveSid: (r) => (r === 'OLD1' ? 'S1' : r), daemonPid: 100 });
    await Promise.all([ports.list({}), ports.list({})]);
    expect(scans).toBe(1);
    await ports.stop({ sids: ['S1'], pid: 301, port: 5173 });
    const after = await ports.list({});
    expect(after.servers.some((s) => s.port === 5173)).toBe(false);
    expect(scans).toBeGreaterThanOrEqual(2);
  });

  it('drops guard pids that are not real pids and refuses a stop with no session', async () => {
    const host = fakeHost();
    const ports = createDaemonPorts({ io: host.io, agentPids: () => new Map(), resolveSid: (r) => r, daemonPid: 100 });
    expect(await ports.stop({ sids: [], pid: 301, port: 5173 })).toMatchObject({ stopped: false });
    await ports.list({ guardPids: [1, 0, -1, 'x', 301] });
    expect(host.killed).toEqual([]);
  });
});

describe('parseSsListeners', () => {
  it('takes owners from the users list only, not a pid= inside a quoted name', () => {
    const line = 'LISTEN 0 128 127.0.0.1:8000 0.0.0.0:* users:(("pid=4242",pid=301,fd=3),("we\\"ird",pid=302,fd=4))'
    expect(parseSsListeners(line).map((l) => l.pid)).toEqual([301, 302])
  })
})

describe('pageTitle', () => {
  it('decodes, trims and caps a title, and finds none where there is none', () => {
    expect(pageTitle('<head><title data-x="1">A &lt;b&gt; &#39;c&#39; &#8212; d</title>')).toBe("A <b> 'c' \u2014 d");
    expect(pageTitle('<TITLE>  </TITLE>')).toBeUndefined();
    expect(pageTitle('<h1>no title</h1>')).toBeUndefined();
    expect(pageTitle(`<title>${'x'.repeat(200)}</title>`)).toHaveLength(80);
  });
});

describe('probePort (real sockets)', () => {
  const closers: Array<() => void> = [];
  afterEach(() => { while (closers.length) closers.pop()!(); });
  const listen = (srv: net.Server) => new Promise<number>((resolve) => srv.listen(0, '127.0.0.1', () => resolve((srv.address() as net.AddressInfo).port)));

  it('tells a web server from a raw TCP server and a closed port', async () => {
    const web = http.createServer((_q, r) => r.end('ok'));
    const raw = net.createServer((s) => s.end('220 hello\r\n'));
    closers.push(() => web.close(), () => raw.close());
    const [wp, rp] = await Promise.all([listen(web), listen(raw)]);
    expect(await probePort('127.0.0.1', wp, 1500)).toEqual({ kind: 'http' });
    expect(await probePort('127.0.0.1', rp, 1500)).toEqual({ kind: 'other' });
    const free = net.createServer();
    const fp = await listen(free);
    await new Promise((r) => free.close(r));
    expect(await probePort('127.0.0.1', fp, 1500)).toEqual({ kind: 'other' });
  });

  it('reads a page\'s title, even one split across packets, and keeps http when the body stalls', async () => {
    const titled = http.createServer((_q, r) => {
      r.writeHead(200, { 'content-type': 'text/html' });
      r.write('<!doctype html><html><head><ti');
      setTimeout(() => r.end('tle>\n  Acme &amp; Co \u2014 dev\n</title></head><body>x</body></html>'), 30);
    });
    const stalled = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.write('<html><head>'); });
    closers.push(() => titled.close(), () => { stalled.closeAllConnections?.(); stalled.close(); });
    const [tp, sp] = await Promise.all([listen(titled), listen(stalled)]);
    expect(await probePort('127.0.0.1', tp, 1500)).toEqual({ kind: 'http', title: 'Acme & Co \u2014 dev' });
    expect(await probePort('127.0.0.1', sp, 300)).toEqual({ kind: 'http' });
  });

  it('a page that streams forever cannot hold the probe past its deadline', async () => {
    const stream = http.createServer((_q, r) => {
      r.writeHead(200, { 'content-type': 'text/event-stream' })
      const t = setInterval(() => r.write('data: x\n\n'), 50)
      r.on('close', () => clearInterval(t))
    })
    closers.push(() => { stream.closeAllConnections?.(); stream.close() })
    const port = await listen(stream)
    const t0 = Date.now()
    expect(await probePort('127.0.0.1', port, 400)).toEqual({ kind: 'http' })
    expect(Date.now() - t0).toBeLessThan(1500)
  })

  const tlsPair = testCertificate()
  it.skipIf(!tlsPair)('tells an https server that drops plaintext without a word, and reads its title', async () => {
    const srv = https.createServer({ key: tlsPair!.key, cert: tlsPair!.cert }, (_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<title>Secure dev</title>') })
    closers.push(() => srv.close())
    const port = await listen(srv as unknown as net.Server)
    expect(await probePort('127.0.0.1', port, 1500)).toEqual({ kind: 'https', title: 'Secure dev' })
  })

  it('a server that never answers is unknown, not "other"', async () => {
    const silent = net.createServer(() => { /* holds the socket */ });
    closers.push(() => silent.close());
    const port = await listen(silent);
    expect(await probePort('127.0.0.1', port, 300)).toEqual({ kind: 'unknown' });
  });
});

describe('review round 1', () => {
  // An agent another daemon on this host spawned (a second Walnut, or this daemon after a
  // restart that did not adopt it): this daemon's records do not name it, its environment does.
  const foreignAgent = (): FakeProc[] => [
    ...baseProcs(),
    { pid: 890, ppid: 1, pgid: 890, comm: 'walnut-daemon' },
    { pid: 900, ppid: 890, pgid: 900, comm: 'claude', env: 'S9' },
    { pid: 901, ppid: 900, pgid: 900, comm: 'node', env: 'S9', cmd: 'node mcp-server.js' },
    { pid: 910, ppid: 900, pgid: 910, comm: 'zsh', env: 'S9' },
    { pid: 911, ppid: 910, pgid: 910, comm: 'node', env: 'S9', cmd: 'node dev.js' },
  ]

  it('the agent of a daemon this one does not know is guarded by where its variable was injected', async () => {
    const host = fakeHost({ procs: foreignAgent(), listeners: [{ pid: 900, port: 7100 }, { pid: 901, port: 7101 }, { pid: 911, port: 7102 }] })
    const scanner = createPortScanner(host.io)
    const res = await scanner.scan(ctx())
    // The agent itself is never listed; its MCP server in its own group is listed but not stoppable;
    // its Bash job is an ordinary server.
    expect(res.servers.map((s) => [s.port, s.stopScope])).toEqual([[7101, 'none'], [7102, 'group']])
    expect(res.servers.find((s) => s.port === 7101)!.kind).toBe('unknown')
    expect(await scanner.stop(ctx(), { sids: ['S9'], pid: 901, port: 7101 })).toMatchObject({ stopped: false, code: 'not_stoppable' })
    expect(await scanner.stop(ctx(), { sids: ['S9'], pid: 900, port: 7100 })).toMatchObject({ stopped: false, code: 'not_found' })
    expect(host.killed).toEqual([])
    expect((await scanner.stop(ctx(), { sids: ['S9'], pid: 911, port: 7102 })).stopped).toBe(true)
    expect(host.killed).toEqual([[-910, 'SIGTERM']])
    expect(host.procs().some((p) => p.pid === 900)).toBe(true)
  })

  it('injectionRoots: a parent naming another session or none makes a root; init and subreapers never do', () => {
    const procs: FakeProc[] = [
      { pid: 1, ppid: 0, pgid: 1, comm: 'init' },
      { pid: 5, ppid: 1, pgid: 5, comm: 'systemd' },
      { pid: 10, ppid: 1, pgid: 10, comm: 'node', env: 'A' }, // orphan of A
      { pid: 11, ppid: 5, pgid: 11, comm: 'node', env: 'A' }, // orphan under a user systemd
      { pid: 20, ppid: 1, pgid: 20, comm: 'app' },
      { pid: 21, ppid: 20, pgid: 21, comm: 'claude', env: 'A' }, // spawned by something without it
      { pid: 22, ppid: 21, pgid: 22, comm: 'zsh', env: 'A' },
      { pid: 30, ppid: 22, pgid: 30, comm: 'claude', env: 'B' }, // a session started inside a session
    ]
    const env = new Map(procs.filter((p) => p.env).map((p) => [p.pid, { sid: p.env!, terminal: false }]))
    expect(injectionRoots(table(procs), env, procs.map((p) => p.pid)).sort((a, b) => a - b)).toEqual([21, 30])
  })

  it('one server per port: the workers of a pre-fork server merge into the topmost', async () => {
    const procs = [...baseProcs(), { pid: 302, ppid: 301, pgid: 300, comm: 'node', env: 'S1' }, { pid: 303, ppid: 301, pgid: 300, comm: 'node', env: 'S1' }]
    const host = fakeHost({ procs, listeners: [{ pid: 303, port: 5173 }, { pid: 301, port: 5173 }, { pid: 302, port: 5173, address: '::' }] })
    const res = await createPortScanner(host.io).scan(ctx())
    expect(res.servers.map((s) => [s.port, s.pid, s.addresses.sort()])).toEqual([[5173, 301, ['127.0.0.1', '::']]])
  })

  it('a page title from the probe reaches the listed server, and is cached with its kind', async () => {
    const host = fakeHost({ procs: baseProcs(), listeners: [{ pid: 301, port: 5173 }] })
    let asked = 0
    host.io.probe = async () => { asked++; return { kind: 'http', title: 'Acme storefront' } }
    const scanner = createPortScanner(host.io)
    expect((await scanner.scan(ctx())).servers.map((s) => [s.port, s.kind, s.title])).toEqual([[5173, 'http', 'Acme storefront']])
    expect((await scanner.scan(ctx())).servers[0]!.title).toBe('Acme storefront')
    expect(asked).toBe(1)
  })

  it('lists only the asked sessions\' servers and probes nothing else', async () => {
    const probed: number[] = []
    const procs = [...baseProcs(), { pid: 260, ppid: 250, pgid: 260, comm: 'zsh', env: 'S2' }, { pid: 261, ppid: 260, pgid: 260, comm: 'node', env: 'S2' }]
    const host = fakeHost({ procs, listeners: [{ pid: 301, port: 5173 }, { pid: 261, port: 3001 }] })
    const probe = host.io.probe
    host.io.probe = async (a, port, t) => { probed.push(port); return probe(a, port, t) }
    const res = await createPortScanner(host.io).scan(ctx(), { sids: ['S2'] })
    expect(res.servers.map((s) => s.port)).toEqual([3001])
    expect(probed).toEqual([3001])
  })

  it('a ps that fails after SIGTERM is no proof of exit, and no license to SIGKILL', async () => {
    const host = fakeHost()
    host.setOnKill(() => { host.failPs(true) })
    const r = await createPortScanner(host.io).stop(ctx(), { sids: ['S1'], pid: 301, port: 5173 })
    expect(r).toEqual({ stopped: true, scope: 'group', signal: 'SIGTERM', confirmed: false })
    expect(host.killed).toEqual([[-300, 'SIGTERM']])
  })

  it('a pid recycled during the grace period is not SIGKILLed as the server', async () => {
    const procs = [...baseProcs(), { pid: 302, ppid: 1, pgid: 300, comm: 'node' }]
    const host = fakeHost({ procs: procs.map((p) => (p.pid === 301 ? { ...p, age: 600 } : p)), listeners: [{ pid: 301, port: 5173 }] })
    host.setOnKill((target, sig) => {
      if (sig !== 'SIGTERM') return
      // 301 exits and a new process takes its pid in the same group, freshly started.
      host.setProcs(host.procs().map((p) => (p.pid === 301 ? { ...p, age: 1, comm: 'other' } : p)))
    })
    const r = await createPortScanner(host.io).stop(ctx(), { sids: ['S1'], pid: 301, port: 5173 })
    expect(r).toMatchObject({ stopped: true, scope: 'process', signal: 'SIGTERM' })
    expect(host.killed).toEqual([[301, 'SIGTERM']])
  })

  it('polls share one scan while it runs and shortly after it ends', async () => {
    const host = fakeHost()
    let scans = 0
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const run = host.io.run
    host.io.run = async (cmd, args, t) => { if (cmd === 'ss') { scans++; await gate } return run(cmd, args, t) }
    const ports = createDaemonPorts({ io: host.io, agentPids: () => new Map([[200, 'S1']]), resolveSid: (r) => r, daemonPid: 100 })
    const a = ports.list({ sids: ['S1'] })
    const b = ports.list({ sids: ['S1'] })
    release()
    await Promise.all([a, b])
    await ports.list({ sids: ['S1'] })
    expect(scans).toBe(1)
    await ports.list({ sids: ['S2'] })
    expect(scans).toBe(2)
  })
})

it('a process naming another session under this session\'s job is a nested agent: its group is never signalled', async () => {
  const procs = [...baseProcs(), { pid: 302, ppid: 300, pgid: 300, comm: 'claude', env: 'S2' }]
  const host = fakeHost({ procs, listeners: [{ pid: 301, port: 5173 }, { pid: 302, port: 7200 }] })
  const scanner = createPortScanner(host.io)
  const res = await scanner.scan(ctx())
  expect(res.servers.map((s) => [s.port, s.stopScope])).toEqual([[5173, 'none']])
  expect(await scanner.stop(ctx(), { sids: ['S1'], pid: 301, port: 5173 })).toMatchObject({ stopped: false, code: 'not_stoppable' })
  expect(host.killed).toEqual([])
})

describe('commandFromCmdline', () => {
  it('quotes each argument as a shell reads it, so a copied command runs as it ran', () => {
    expect(commandFromCmdline('node\0/w/node_modules/.bin/vite\0--port\x005173\0')).toBe('node /w/node_modules/.bin/vite --port 5173')
    expect(commandFromCmdline("python3\0-c\0import sys\nprint('hi')\0")).toBe("python3 -c 'import sys\nprint('\\''hi'\\'')'")
    expect(commandFromCmdline('sh\0-c\0\0')).toBe("sh -c ''")
    expect(shellQuote('a b')).toBe("'a b'")
    expect(shellQuote('--flag=x,y')).toBe('--flag=x,y')
  })
})
