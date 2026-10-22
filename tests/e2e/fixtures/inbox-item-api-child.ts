/** Minimal API process: real routes/stores/runner/control handler, no plugin or daemon boot. */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import type { Socket } from 'node:net';

const root = process.env.FIXTURE_ROOT!;
for (const name of ['HOME', 'OPEN_WALNUT_HOME', 'WALNUT_DAEMON_DIR', 'WALNUT_STREAMS_DIR', 'WALNUT_SPAWN_JOURNAL', 'CLAUDE_CONFIG_DIR', 'TMPDIR']) {
  const value = process.env[name];
  if (!root || !value || !path.resolve(value).startsWith(path.resolve(root) + path.sep)) throw new Error(`Refusing unisolated ${name}`);
}
if (Object.keys(process.env).some(key => key.startsWith('GIT_'))) throw new Error('Refusing inherited git environment');
// Product modules cannot fall back to another server, unix socket or model endpoint.
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args: any[]) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof first === 'object' ? first : { port: first, host: args[1] };
  if (options.path || Number(options.port) === 3456 || !['127.0.0.1', 'localhost', '::1'].includes(options.host ?? 'localhost')) throw new Error('Fixture refused non-owned network target');
  return originalConnect.apply(this, args as Parameters<typeof originalConnect>);
} as typeof originalConnect;

let closing = false;
let server: http.Server | undefined;
let detach = () => {};
const sockets = new Set<Socket>();
// Install before asynchronous imports: TERM during boot never leaves a live child.
process.on('SIGTERM', () => {
  if (closing) return;
  closing = true;
  detach();
  for (const socket of sockets) socket.destroy();
  if (server) server.close(() => process.exit(0));
  else process.exit(0);
  setTimeout(() => process.exit(1), 5_000).unref();
});

const { WALNUT_HOME, CLOUD_MODE } = await import('../../../src/constants.js');
if (WALNUT_HOME !== process.env.OPEN_WALNUT_HOME) throw new Error('Fixture home changed during import');
const { initDirectories } = await import('../../../src/core/init.js');
await initDirectories();
const { default: express } = await import('express');
const { WebSocketServer } = await import('ws');
const { z } = await import('zod');
const { authMiddleware, validateBearerCredential } = await import('../../../src/web/middleware/auth.js');
const { apiV1Router } = await import('../../../src/web/routes/api-v1.js');
const { taskV1Router } = await import('../../../src/web/routes/task-v1.js');
const { messagesV1Router } = await import('../../../src/web/routes/messages-v1.js');
const { errorHandler } = await import('../../../src/web/middleware/error-handler.js');
const { setSelfApiRoot } = await import('../../../src/lib/self-api-root.js');
const { bridgeForHost, attachBridge, closeAllBridges } = await import('../../../src/web/ws/bridge-registry.js');
const { registerInboxMailSource } = await import('../../../src/core/human-inbox/item-source-registry.js');
const { definePluginOp } = await import('../../../src/ops/registry.js');
const { listSessions } = await import('../../../src/core/session-tracker.js');
const { sessionRunner } = await import('../../../src/providers/claude-code-session.js');
const { localDaemon } = await import('../../../src/providers/local-daemon.js');
const { getDirectDaemonConnection, disconnectAllDaemons } = await import('../../../src/providers/daemon-connection.js');

const stateFile = path.join(WALNUT_HOME, 'fixture-state.json');
type State = { flags: Record<string, boolean>; legacy: Record<string, string>; mailCalls: Array<{ account: string; messages: string[]; read: boolean }>; effects: string[]; lostResponses: number };
const state: State = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { flags: {}, legacy: {}, mailCalls: [], effects: [], lostResponses: 0 };
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
let unregister = () => {};
let dispose = () => {};
if (!CLOUD_MODE) {
  unregister = registerInboxMailSource({ resolve: async source => ({ source, key: `fixture:${JSON.stringify([source.account, source.message])}`,
    adapter: { legacyTaskId: async key => state.legacy[key], writeLegacy: async (key, id) => { state.legacy[key] ??= id; save(); } } }) });
  const op = definePluginOp('fixture-mail', { name: 'mail_mark_read', title: 'Flag fixture mail', description: 'Isolated fixture mail provider',
    input: { account: z.string(), messages: z.array(z.string()), read: z.boolean() }, tags: { readonly: false, remote: 'deny' },
    handler: async args => { state.mailCalls.push(args); for (const message of args.messages) state.flags[JSON.stringify([args.account, message])] = args.read; save(); return JSON.stringify({ account: args.account, read: args.read, changed: args.messages.length }); } });
  dispose = () => { op.dispose(); };
}
// Any lazy local-daemon access gets only this fixture's in-memory daemon URL.
const daemonUrl = process.env.FIXTURE_DAEMON_URL!;
Object.defineProperties(localDaemon, { port: { get: () => Number(new URL(daemonUrl).port) }, wsUrl: { get: () => daemonUrl }, pid: { get: () => null } });
localDaemon.ensureRunning = async () => Number(new URL(daemonUrl).port);
sessionRunner.setTestDaemonUrl(daemonUrl);
sessionRunner.setCliCommand(path.join(root, 'bin', 'claude'));

let holdKind: 'task_create' | 'task_start' | undefined;
let heldRoute: { kind: 'task_create' | 'task_start'; path: string } | undefined;
const app = express();
app.use(express.json());
app.get('/fixture/state', (_req, res) => res.json({ ...state, heldRoute, pid: process.pid, bridgeConnected: bridgeForHost('__local__').connected }));
app.post('/fixture/hold', (req, res) => {
  if (CLOUD_MODE || !['task_create', 'task_start'].includes(req.body.kind) || holdKind || heldRoute) { res.sendStatus(400); return; }
  holdKind = req.body.kind;
  res.json({ ok: true });
});
app.post('/fixture/flags', (req, res) => {
  if (CLOUD_MODE || typeof req.body.account !== 'string' || typeof req.body.message !== 'string' || typeof req.body.read !== 'boolean') { res.sendStatus(400); return; }
  state.flags[JSON.stringify([req.body.account, req.body.message])] = req.body.read;
  save(); res.json({ ok: true });
});
app.use('/api', authMiddleware);
app.use('/api/v1', async (req, res, next) => {
  const kind = req.method !== 'POST' ? undefined : req.path === '/tasks' ? 'task_create' : /^\/tasks\/[^/]+\/start$/.test(req.path) ? 'task_start' : undefined;
  if (kind && kind === holdKind) {
    heldRoute = { kind, path: req.path };
    holdKind = undefined;
    // The process restart discards this gate; the real handler never ran.
    await new Promise<void>(() => {});
  }
  if (req.method === 'POST' && (kind || req.path === '/messages')) {
    state.effects.push(kind ?? 'task_send'); save();
  }
  if (req.method === 'POST' && req.path.endsWith('/execute') && req.headers['x-fixture-lose-response'] === '1') {
    // Only after the real handler generated its response: the request DID execute.
    res.json = (() => { state.lostResponses++; save(); req.socket.destroy(); return res; }) as typeof res.json;
  }
  next();
});
app.use('/api/v1', taskV1Router, messagesV1Router, apiV1Router);
app.use(errorHandler);
server = http.createServer(app);
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
const wss = new WebSocketServer({ noServer: true });
if (CLOUD_MODE) server.on('upgrade', (req, socket, head) => {
  void (async () => {
    const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const credential = await validateBearerCredential(token);
    if (req.url !== '/bridge' || credential?.kind !== 'machine') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => attachBridge(ws, credential.name));
  })().catch(() => socket.destroy());
});
await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
if (port === 3456) throw new Error('Fixture refused production port');
setSelfApiRoot(`http://127.0.0.1:${port}`);
process.env.OPEN_WALNUT_API_URL = `http://127.0.0.1:${port}`;
if (!CLOUD_MODE) {
  await getDirectDaemonConnection('__local__', daemonUrl);
  sessionRunner.init((await listSessions()).filter(record => !record.archived && ['running', 'idle'].includes(record.process_status)));
}
detach = () => { unregister(); dispose(); sessionRunner.destroy(); disconnectAllDaemons(); closeAllBridges(); wss.close(); setSelfApiRoot(null); };
if (closing) process.exit(0);
process.stdout.write(`FIXTURE_PORT=${port}\n`);
