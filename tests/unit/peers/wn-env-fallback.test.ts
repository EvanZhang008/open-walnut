/**
 * Unit test: `wn` env-less fallback (human-inbox P3 / L block).
 *
 * The feature: any agent or terminal on a host that runs a daemon can use `wn`
 * with NO injected environment. Covered here, in the three places it lives:
 *
 *  - wn client (resolveWalnutCliEndpoint / isTrustedGatewaySocket): env wins when
 *    present, otherwise the well-known socket path + caller sid 'external'.
 *  - daemon gateway (resolveGatewayCallerSid, used by both twins): 'external'
 *    passes through, every other unknown sid is still refused locally.
 *  - hub (capability-router): 'external' is PROVENANCE ONLY — the same op
 *    catalog a tracked session sees, the same policy gates, and a per-HOST rate
 *    bucket rather than one shared global budget. (The sender LABEL an anonymous
 *    caller gets in a delivered note is pinned in peer-wrapper.test.ts.)
 *
 * Security invariant pinned throughout: the socket's 0600 owner-only mode IS
 * the credential. The fallback adds no socket and no mode change, and refuses a
 * well-known path that is not an owner-only socket owned by this user (the
 * daemon dir lives under a world-writable /tmp).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  resolveWalnutCliEndpoint,
  isTrustedGatewaySocket,
  type WalnutSocketInfo,
} from '../../../src/providers/wn-cli.js';
import {
  EXTERNAL_CALLER_SID,
  isExternalCallerSid,
  resolveCallerSid,
  resolveGatewayCallerSid,
  wellKnownGatewaySocketPath,
  PROD_DAEMON_DIR,
  GATEWAY_SOCKET_FILENAME,
} from '../../../src/providers/gateway-core.js';
import {
  handleGatewayCapability,
  type CapabilityRouterDeps,
} from '../../../src/core/peers/capability-router.js';
import { PeerThrottle, PEER_SEND_MAX_PER_WINDOW } from '../../../src/core/peers/peer-throttle.js';

const UID = 501;
const TRUSTED: WalnutSocketInfo = { isSocket: true, uid: UID, mode: 0o600 };

/** Probe stub: one known path exists with the given info, everything else is absent. */
function probeFor(existing: Record<string, WalnutSocketInfo>) {
  const seen: string[] = [];
  const probe = (p: string): WalnutSocketInfo | null => {
    seen.push(p);
    return existing[p] ?? null;
  };
  return { probe, seen };
}

// ── wn client: where to send, who to claim to be ──

describe('resolveWalnutCliEndpoint', () => {
  it('uses the injected env inside a Walnut-managed session and never probes', () => {
    const { probe, seen } = probeFor({});
    const r = resolveWalnutCliEndpoint(
      { WALNUT_AGENT_SOCKET: '/tmp/walnut-test/agent.sock', WALNUT_SESSION_ID: 'sid-1234' },
      probe,
      UID,
    );
    expect(r).toEqual({
      ok: true,
      socketPath: '/tmp/walnut-test/agent.sock',
      sid: 'sid-1234',
      external: false,
    });
    expect(seen).toEqual([]);
  });

  it('falls back to the well-known socket and the external sid with no env at all', () => {
    const sock = wellKnownGatewaySocketPath({});
    const { probe } = probeFor({ [sock]: TRUSTED });
    const r = resolveWalnutCliEndpoint({}, probe, UID);
    expect(r).toEqual({ ok: true, socketPath: sock, sid: EXTERNAL_CALLER_SID, external: true });
    expect(sock).toBe(`${PROD_DAEMON_DIR}/${GATEWAY_SOCKET_FILENAME}`);
  });

  it('honours WALNUT_DAEMON_DIR so an isolated daemon is reachable', () => {
    const dir = '/tmp/walnut-iso-daemon';
    const sock = `${dir}/${GATEWAY_SOCKET_FILENAME}`;
    const { probe } = probeFor({ [sock]: TRUSTED });
    const r = resolveWalnutCliEndpoint({ WALNUT_DAEMON_DIR: dir }, probe, UID);
    expect(r.ok && r.socketPath).toBe(sock);
    // A trailing slash must not produce a double separator.
    expect(wellKnownGatewaySocketPath({ WALNUT_DAEMON_DIR: `${dir}/` })).toBe(sock);
  });

  it('keeps the injected socket but stamps external when only the sid is missing', () => {
    const r = resolveWalnutCliEndpoint({ WALNUT_AGENT_SOCKET: '/tmp/walnut-test/agent.sock' }, probeFor({}).probe, UID);
    expect(r).toEqual({
      ok: true,
      socketPath: '/tmp/walnut-test/agent.sock',
      sid: EXTERNAL_CALLER_SID,
      external: true,
    });
  });

  it('treats blank env values as absent', () => {
    const sock = wellKnownGatewaySocketPath({});
    const { probe } = probeFor({ [sock]: TRUSTED });
    const r = resolveWalnutCliEndpoint({ WALNUT_AGENT_SOCKET: '  ', WALNUT_SESSION_ID: '   ' }, probe, UID);
    expect(r).toEqual({ ok: true, socketPath: sock, sid: EXTERNAL_CALLER_SID, external: true });
  });

  it('errors clearly (never throws) when there is no daemon socket on the host', () => {
    const r = resolveWalnutCliEndpoint({}, probeFor({}).probe, UID);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('WALNUT_AGENT_SOCKET');
    expect(r.message).toContain(wellKnownGatewaySocketPath({}));
    expect(r.message).toContain('does not exist');
  });

  it('refuses a well-known path that is not an owner-only socket owned by this user', () => {
    const sock = wellKnownGatewaySocketPath({});
    const cases: WalnutSocketInfo[] = [
      { isSocket: false, uid: UID, mode: 0o600 },   // a planted regular file
      { isSocket: true, uid: UID + 1, mode: 0o600 }, // another user's socket
      { isSocket: true, uid: UID, mode: 0o660 },     // group-writable
      { isSocket: true, uid: UID, mode: 0o666 },     // world-writable
    ];
    for (const info of cases) {
      const r = resolveWalnutCliEndpoint({}, probeFor({ [sock]: info }).probe, UID);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.message).toContain('refusing');
      expect(r.message).toContain('0600');
    }
  });
});

describe('isTrustedGatewaySocket', () => {
  it('accepts only an owner-only socket owned by the caller', () => {
    expect(isTrustedGatewaySocket(TRUSTED, UID)).toBe(true);
    expect(isTrustedGatewaySocket({ isSocket: true, uid: UID, mode: 0o700 }, UID)).toBe(true);
    expect(isTrustedGatewaySocket({ isSocket: true, uid: UID, mode: 0o604 }, UID)).toBe(false);
    expect(isTrustedGatewaySocket({ isSocket: true, uid: UID, mode: 0o640 }, UID)).toBe(false);
    expect(isTrustedGatewaySocket({ isSocket: false, uid: UID, mode: 0o600 }, UID)).toBe(false);
    expect(isTrustedGatewaySocket({ isSocket: true, uid: 0, mode: 0o600 }, UID)).toBe(false);
  });

  it('ignores uid only where the platform has none, and still enforces the mode', () => {
    expect(isTrustedGatewaySocket({ isSocket: true, uid: 0, mode: 0o600 }, -1)).toBe(true);
    expect(isTrustedGatewaySocket({ isSocket: true, uid: 0, mode: 0o666 }, -1)).toBe(false);
  });
});

// ── daemon gateway: caller identity for one request ──

describe('resolveGatewayCallerSid', () => {
  const sessions = new Set(['live-sid']);
  const aliases = new Map([['tmp-sid', 'live-sid']]);

  it('passes the external label through even with no tracked sessions', () => {
    expect(resolveGatewayCallerSid(EXTERNAL_CALLER_SID, new Set(), new Map())).toBe('external');
    expect(isExternalCallerSid('external')).toBe(true);
    expect(isExternalCallerSid('external-ish')).toBe(false);
  });

  it('still resolves tracked sids and alias chains', () => {
    expect(resolveGatewayCallerSid('live-sid', sessions, aliases)).toBe('live-sid');
    expect(resolveGatewayCallerSid('tmp-sid', sessions, aliases)).toBe('live-sid');
    expect(resolveCallerSid('tmp-sid', sessions, aliases)).toBe('live-sid');
  });

  it('still refuses every OTHER unknown sid (the fallback opens exactly one label)', () => {
    expect(resolveGatewayCallerSid('unknown-sid', sessions, aliases)).toBeNull();
    expect(resolveGatewayCallerSid('EXTERNAL', sessions, aliases)).toBeNull();
    expect(resolveGatewayCallerSid('external ', sessions, aliases)).toBeNull();
  });
});

// ── daemon twins stay in sync (the node twin cannot import) ──

describe('daemon twin parity for the external caller', () => {
  const ROOT = path.resolve(__dirname, '../../..');
  const nodeTwin = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-source.ts'), 'utf-8');
  const bunTwin = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf-8');

  it('both twins accept the external caller sid in their gateway line handler', () => {
    expect(nodeTwin).toMatch(/EXTERNAL_CALLER_SID\s*=\s*'external'/);
    expect(nodeTwin).toMatch(/if\s*\(sid === EXTERNAL_CALLER_SID\)\s*return EXTERNAL_CALLER_SID/);
    expect(bunTwin).toMatch(/resolveGatewayCallerSid\(req\.sid, sessions, gatewaySidAliases\)/);
  });

  it('the node twin mirrors the wn well-known-socket fallback with the same trust rule', () => {
    expect(nodeTwin).toMatch(/WALNUT_AGENT_SOCKET \|\| ''/);
    expect(nodeTwin).toMatch(/WALNUT_SESSION_ID \|\| ''\)\.trim\(\) \|\| 'external'/);
    expect(nodeTwin).toMatch(/path\.join\(DAEMON_DIR, 'agent-gateway\.sock'\)/);
    // Same three-part trust check as isTrustedGatewaySocket.
    expect(nodeTwin).toMatch(/isSocket\(\)/);
    expect(nodeTwin).toMatch(/sockStat\.uid !== myUid/);
    expect(nodeTwin).toMatch(/sockStat\.mode & 0o077/);
  });

  it('neither twin loosens the socket mode for the fallback', () => {
    for (const src of [nodeTwin, bunTwin]) {
      expect(src).toMatch(/chmodSync\(GATEWAY_SOCK_PATH, 0o600\)/);
      expect(src).not.toMatch(/chmodSync\(GATEWAY_SOCK_PATH, 0o6[67]/);
    }
  });

  it('neither twin exits wn without flushing stdout first', () => {
    // process.exit() DISCARDS stdout still queued for a pipe, so a piped
    // `wn ... --json` came out cut at the 64KB pipe buffer. The bun twin fixed
    // it in wn-cli.ts (writeStdout); the node twin kept the bug for months
    // because parity was only pinned on the trust rule. Both must buffer.
    const wnCli = fs.readFileSync(path.join(ROOT, 'src/providers/wn-cli.ts'), 'utf-8');
    expect(wnCli).toMatch(/async function writeStdout/);
    expect(wnCli).toMatch(/process\.stdout\.write\(text, \(\) => finish\(\)\)/);
    // The node twin buffers into outBuf and flushes inside exitWn.
    expect(nodeTwin).toMatch(/var out = function \(s\) \{ outBuf \+= s \+ '\\\\n'; \};/);
    expect(nodeTwin).toMatch(/var exitWn = function \(code\)/);
    expect(nodeTwin).toMatch(/process\.stdout\.write\(text, finishExit\)/);
    // No un-flushed write-then-exit left anywhere in the twin's wn path.
    const wnSection = nodeTwin.slice(
      nodeTwin.indexOf('function runWnMinimal'),
      nodeTwin.indexOf('// ── PATH setup ──'),
    );
    expect(wnSection.length).toBeGreaterThan(1000);
    expect(wnSection).not.toMatch(/process\.stdout\.write\(s \+ '\\\\n'\)/);
  });

  it('both twins install a walnut on the user PATH, prod-dir only and marker-guarded', () => {
    // GATEWAY_SHIM_DIR only reaches sessions the daemon spawns, so without this
    // a hand-started terminal answers `walnut: command not found` and the whole
    // env-less fallback is unreachable.
    for (const src of [nodeTwin, bunTwin]) {
      expect(src).toMatch(/function installUserWalnutShim/);
      expect(src).toMatch(/installUserWalnutShim\(\)/);
      // Never for an isolated (test/sandbox/ephemeral) daemon.
      expect(src).toMatch(/if \(path\.resolve\(DAEMON_DIR\) !== path\.resolve\(PROD_DAEMON_DIR\)\) return/);
      // Never clobber a foreign binary: the guard reads the shim's marker.
      expect(src).toMatch(/existing\.(includes|indexOf)\((USER_WALNUT_SHIM_MARKER|marker)\)/);
      expect(src).toMatch(/USER_WALNUT_SHIM_MARKER = 'walnut-user-shim v1'/);
      expect(src).toMatch(/'\.local', 'bin'\)/);
      // The retired `wn` name is actively cleaned up, marker-guarded: our old
      // shims are deleted, a foreign wn binary is left alone.
      expect(src).toMatch(/LEGACY_WN_SHIM_MARKERS = \['walnut-wn-shim v1'\]/);
      expect(src).not.toMatch(/function userWnShimText/);
    }
  });
});

// ── the node twin, actually run: a piped reply must arrive whole ──

describe('node daemon twin: wn output through a pipe', () => {
  const ROOT = path.resolve(__dirname, '../../..');

  /** Materialize the deployed twin: the template carries no interpolations, so
   *  evaluating it yields the exact bytes a source deploy ships. Placeholders are
   *  stubbed (the fold functions are irrelevant to the wn path). */
  function materializeNodeTwin(target: string): void {
    const src = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-source.ts'), 'utf-8');
    const start = src.indexOf('const DAEMON_SOURCE = `');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(src.indexOf('`', start) + 1, src.lastIndexOf('`'));
    // eslint-disable-next-line no-eval
    let out = eval('`' + body + '`') as string;
    out = out
      .replace('__DAEMON_CAPABILITIES__', JSON.stringify(['test']))
      .replace('__DAEMON_VERSION__', 'test-version');
    for (const ph of ['__FOLD_LINE__', '__INITIAL_FOLD_STATE__', '__ASSEMBLE_SNAPSHOT__', '__SNAPSHOT_DIFFERS__']) {
      out = out.replace(ph, 'function () {}');
    }
    fs.writeFileSync(target, out);
  }

  it('delivers a >64KB --json reply complete and parseable (not cut at the pipe buffer)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-twin-'));
    const twin = path.join(dir, 'daemon.cjs');
    materializeNodeTwin(twin);

    const ops = Array.from({ length: 4000 }, (_, i) => ({ name: `op_${i}`, title: 'T'.repeat(20), readonly: true }));
    const payload = JSON.stringify({ ok: true, result: { ops } });
    expect(payload.length).toBeGreaterThan(64 * 1024);

    const sock = path.join(dir, 'agent-gateway.sock');
    const server = net.createServer((c) => { c.on('data', () => { c.write(payload + '\n'); }); });
    await new Promise<void>((resolve) => server.listen(sock, () => resolve()));
    fs.chmodSync(sock, 0o600);

    const result = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn(process.execPath, [twin, 'wn', 'tools', 'list', '--json'], {
        env: {
          ...process.env,
          WALNUT_DAEMON_DIR: dir,
          WALNUT_AGENT_SOCKET: sock,
          WALNUT_SESSION_ID: 'probe-sid',
        },
        // stdio pipes are the failing condition: on a TTY the old code looked fine.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => resolve({ code, out, err }));
    });
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });

    expect(result.err).not.toContain('wn:');
    expect(result.code).toBe(0);
    expect(result.out.length).toBe(payload.length + 1);
    const parsed = JSON.parse(result.out) as { result: { ops: unknown[] } };
    expect(parsed.result.ops).toHaveLength(4000);
  }, 30_000);

  // ── tools.call payloads that cannot ride argv ──
  // The source-deploy twin is the CLI face a REMOTE session actually gets (the
  // on-PATH `walnut` shim execs `bun daemon.cjs wn`), and it is a separate
  // hand-inlined implementation from wn-cli.ts. It parsed argv only, so a letter
  // with an inline base64 audio digest died on the client with "Argument list
  // too long": Linux caps ONE argv entry at MAX_ARG_STRLEN (128KB) regardless of
  // ARG_MAX, and execve fails before any Walnut code runs. Every payload here is
  // deliberately over that ceiling, so a regression to argv-only fails the test
  // on Linux instead of surfacing months later on a remote host.
  const OVER_ARGV_LIMIT = 200 * 1024;

  /** Run the twin's wn CLI against a socket that records the request line. */
  async function runTwinCall(
    args: string[],
    opts: { stdin?: string } = {},
  ): Promise<{ code: number | null; out: string; err: string; received: string }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-args-'));
    const twin = path.join(dir, 'daemon.cjs');
    materializeNodeTwin(twin);
    const sock = path.join(dir, 'agent-gateway.sock');
    let received = '';
    const server = net.createServer((c) => {
      c.on('data', (d) => {
        received += d.toString('utf-8');
        if (received.includes('\n')) c.write(JSON.stringify({ ok: true, result: { ok: true } }) + '\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(sock, () => resolve()));
    fs.chmodSync(sock, 0o600);

    const result = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn(process.execPath, [twin, 'wn', ...args], {
        env: {
          ...process.env,
          WALNUT_DAEMON_DIR: dir,
          WALNUT_AGENT_SOCKET: sock,
          WALNUT_SESSION_ID: 'probe-sid',
        },
        stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => resolve({ code, out, err }));
      if (opts.stdin !== undefined) child.stdin!.end(opts.stdin);
    });
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    return { ...result, received };
  }

  /** A payload too big for one argv entry, with a tail marker to catch truncation. */
  function bigPayload(): { json: string; tail: string } {
    const tail = 'TAIL-MARKER-END';
    const filler = 'A'.repeat(OVER_ARGV_LIMIT);
    return { json: JSON.stringify({ subject: 's', html: filler + tail }), tail };
  }

  it('reads a >128KB payload from @file', async () => {
    const { json, tail } = bigPayload();
    expect(Buffer.byteLength(json, 'utf-8')).toBeGreaterThan(128 * 1024);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wn-payload-')), 'letter.json');
    fs.writeFileSync(file, json);

    const r = await runTwinCall(['tools', 'call', 'human_inbox_send', `@${file}`]);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const sent = JSON.parse(r.received.trim()) as { op: string; args: { name: string; args: { html: string } } };
    expect(sent.op).toBe('tools.call');
    expect(sent.args.name).toBe('human_inbox_send');
    // Whole, not clipped at any buffer boundary.
    expect(sent.args.args.html.endsWith(tail)).toBe(true);
    expect(sent.args.args.html.length).toBe(OVER_ARGV_LIMIT + tail.length);
  }, 30_000);

  it('reads a >128KB payload from explicit stdin (-)', async () => {
    const { json, tail } = bigPayload();
    const r = await runTwinCall(['tools', 'call', 'human_inbox_send', '-'], { stdin: json });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const sent = JSON.parse(r.received.trim()) as { args: { args: { html: string } } };
    expect(sent.args.args.html.endsWith(tail)).toBe(true);
  }, 30_000);

  it('reads a >128KB payload from a piped stdin with no positional argument', async () => {
    const { json, tail } = bigPayload();
    const r = await runTwinCall(['tools', 'call', 'human_inbox_send'], { stdin: json });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const sent = JSON.parse(r.received.trim()) as { args: { args: { html: string } } };
    expect(sent.args.args.html.endsWith(tail)).toBe(true);
  }, 30_000);

  it('still accepts a small inline JSON argument', async () => {
    const r = await runTwinCall(['tools', 'call', 'task_get', '{"id":"abc"}']);
    expect(r.code).toBe(0);
    const sent = JSON.parse(r.received.trim()) as { args: { args: { id: string } } };
    expect(sent.args.args.id).toBe('abc');
  }, 30_000);

  /**
   * Past the inline threshold the payload stops travelling INSIDE the request.
   *
   * A 200KB payload still rides the line (the tests above), but a letter carrying
   * an audio digest is megabytes, and one NDJSON line becomes one WebSocket frame
   * to the hub — where `ws` answers an oversized frame by closing the socket with
   * 1009 before any handler can turn it into an error. So the request carries only
   * the PATH and the hub range-reads the file in batches. This is the twin that
   * gets forgotten (a remote host would keep inlining and die at the gateway line,
   * looking like a server bug), which is why it is asserted through a real spawn.
   */
  const OVER_INLINE_LIMIT = 1024 * 1024 + 64;

  it('sends a >1MB @file as a PATH, not as inlined args', async () => {
    const tail = 'TAIL-MARKER-END';
    const json = JSON.stringify({ subject: 's', html: 'B'.repeat(OVER_INLINE_LIMIT) + tail });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-bigpayload-'));
    const file = path.join(dir, 'letter.json');
    fs.writeFileSync(file, json);

    const r = await runTwinCall(['tools', 'call', 'human_inbox_send', `@${file}`]);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    // The request line is TINY — that is the assertion, not just the field name.
    expect(r.received.length).toBeLessThan(4096);
    const sent = JSON.parse(r.received.trim()) as {
      args: { name: string; argsFile?: string; args?: unknown }
    };
    expect(sent.args.name).toBe('human_inbox_send');
    expect(sent.args.argsFile).toBe(file);
    expect(sent.args.args).toBeUndefined();
    // The user's own file is left alone — only a stdin spill is ours to delete.
    expect(fs.existsSync(file)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it('spills a >1MB stdin payload to a file and sends that path', async () => {
    // stdin is not a file the hub can range-read, so the CLI has to give it one.
    const json = JSON.stringify({ subject: 's', html: 'C'.repeat(OVER_INLINE_LIMIT) });
    const r = await runTwinCall(['tools', 'call', 'human_inbox_send', '-'], { stdin: json });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.received.length).toBeLessThan(4096);
    const sent = JSON.parse(r.received.trim()) as { args: { argsFile?: string } };
    expect(sent.args.argsFile).toMatch(/walnut-args-\d+-[0-9a-z]+\.json$/);
    // …and the spill is cleaned up on exit rather than left in tmp forever.
    expect(fs.existsSync(sent.args.argsFile!)).toBe(false);
  }, 30_000);

  it('fails usefully on an unreadable @file, a bare @, and malformed JSON', async () => {
    const missing = await runTwinCall(['tools', 'call', 'task_get', '@/nope/missing.json']);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('cannot read arguments from /nope/missing.json');
    expect(missing.received).toBe('');

    const bare = await runTwinCall(['tools', 'call', 'task_get', '@']);
    expect(bare.code).toBe(2);
    expect(bare.err).toContain('needs a file path');

    const bad = await runTwinCall(['tools', 'call', 'task_get', '{not json']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('invalid JSON arguments');

    const arr = await runTwinCall(['tools', 'call', 'task_get', '[1,2]']);
    expect(arr.code).toBe(2);
    expect(arr.err).toContain('must be a JSON object');
  }, 60_000);
});

// ── hub: external is provenance, not authorization ──

const TARGET = 'f00dcafe-1111-2222-3333-444455556666';

function makeDeps(over?: Partial<CapabilityRouterDeps>): { deps: CapabilityRouterDeps } {
  return { deps: { throttle: new PeerThrottle(), cloudMode: false, ...over } };
}

describe('capability-router with an external caller', () => {
  it('the retired peers capabilities point an anonymous caller at the replacement op', async () => {
    // An env-less `walnut peers …` on an old host must get the new command, and
    // must not be treated as a send just because the caller is anonymous.
    const { deps } = makeDeps();
    for (const cap of ['peers.list', 'peers.send']) {
      const r = await handleGatewayCapability(cap, EXTERNAL_CALLER_SID, { target: TARGET, text: 'hi' }, 'devbox', deps);
      expect(r.ok, cap).toBe(false);
      if (r.ok) continue;
      expect(r.error.code, cap).toBe('bad_request');
      expect(r.error.message, cap).toContain('was replaced');
    }
  });

  it('tools.list works (the catalog is the same one a tracked session sees)', async () => {
    const { deps } = makeDeps();
    const r = await handleGatewayCapability('tools.list', EXTERNAL_CALLER_SID, {}, 'devbox', deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const names = (r.result.ops as Array<{ name: string }>).map((o) => o.name);
    expect(names).toContain('human_inbox_send');
  });

  it('tools.call keeps every policy gate: local-only ops still refused', async () => {
    const { deps } = makeDeps();
    const r = await handleGatewayCapability(
      'tools.call', EXTERNAL_CALLER_SID, { name: 'task_delete', args: { id: 'x' } }, 'devbox', deps,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('bad_request');
    expect(r.error.message).toContain('local-only');
  });

  it('tools.call writes are throttled for an anonymous caller like any sender', async () => {
    let t = 5_000_000;
    const throttle = new PeerThrottle(() => t);
    const { deps } = makeDeps({ throttle });
    // Fill the caller's OWN bucket (anonymous callers are bucketed per host).
    // Pre-burning is what keeps this case offline: an admitted write would
    // really execute the op against the local API.
    for (let i = 0; i < PEER_SEND_MAX_PER_WINDOW; i++) {
      expect(throttle.admitWrite(`${EXTERNAL_CALLER_SID}@devbox`).allowed).toBe(true);
      t += 10;
    }
    const r = await handleGatewayCapability(
      'tools.call', EXTERNAL_CALLER_SID, { name: 'task_create', args: { title: 'throttled-never-executes' } }, 'devbox', deps,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('throttled');
  });

  it('buckets an anonymous caller per HOST, not in one global bucket', async () => {
    // A recording throttle that always refuses: it captures the bucket key
    // WITHOUT letting the op execute (a real write op would leave the process).
    class RecordingThrottle extends PeerThrottle {
      keys: string[] = [];
      override admitWrite(key: string) {
        this.keys.push(key);
        return { allowed: false as const, retryAfterMs: 1 };
      }
      override admit(key: string) {
        this.keys.push(key);
        return { allowed: false as const, retryAfterMs: 1 };
      }
    }
    const throttle = new RecordingThrottle();
    const { deps } = makeDeps({ throttle });

    for (const [caller, host] of [
      [EXTERNAL_CALLER_SID, 'devbox'],
      [EXTERNAL_CALLER_SID, '__local__'],
      [TARGET, 'devbox'],
    ] as Array<[string, string]>) {
      const r = await handleGatewayCapability('tools.call', caller, { name: 'task_create', args: { title: 'x' } }, host, deps);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('throttled');
    }
    // Two anonymous callers on two hosts are two buckets; a tracked session is
    // still keyed on its own sid.
    expect(throttle.keys).toEqual([`${EXTERNAL_CALLER_SID}@devbox`, `${EXTERNAL_CALLER_SID}@local`, TARGET]);
  });

  it('a write op named session_send is throttled like any other write from external', async () => {
    // The send path moved into the registry, so the anonymous sender's rate
    // budget must still apply to it — a runaway agent must not get a free lane
    // by switching from `peers send` to `tools call session_send`.
    let t = 7_000_000;
    const throttle = new PeerThrottle(() => t);
    const { deps } = makeDeps({ throttle });
    for (let i = 0; i < PEER_SEND_MAX_PER_WINDOW; i++) {
      expect(throttle.admitWrite(`${EXTERNAL_CALLER_SID}@devbox`).allowed).toBe(true);
      t += 10;
    }
    const r = await handleGatewayCapability(
      'tools.call', EXTERNAL_CALLER_SID, { name: 'session_send', args: { to: TARGET, text: 'hi' } }, 'devbox', deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('throttled');
  });

  it('a cloud replica refuses an external caller too', async () => {
    const { deps } = makeDeps({ cloudMode: true });
    const r = await handleGatewayCapability('tools.list', EXTERNAL_CALLER_SID, {}, 'devbox', deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('unsupported_replica');
  });
});
