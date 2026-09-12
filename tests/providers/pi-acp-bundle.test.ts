import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildPiAcp, patchPiAcp } from '../../scripts/build-pi-acp.mjs'
import { AcpWorker } from '../../src/providers/acp-worker/worker.js'
import { readJournal } from '../../src/providers/acp-worker/journal.js'
import { projectAcpJournalHistory } from '../../src/providers/acp-journal-projector.js'
import type { WorkerOp } from '../../src/providers/acp-worker/protocol.js'

let root: string
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-bundle-test-'))
  await buildPiAcp(root)
  await fs.writeFile(path.join(root, 'pi'), `#!${process.execPath}
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
if (process.argv.includes('--version')) { process.stdout.write((process.env.MOCK_PI_VERSION || '0.85.1') + '\\n'); process.exit(process.env.MOCK_PI_VERSION_FAIL ? 1 : 0); }
fs.appendFileSync(path.join(process.env.HOME, 'spawns.jsonl'), JSON.stringify(process.argv.slice(2)) + '\\n');
const sessionArg = process.argv.indexOf('--session');
const sessionFile = sessionArg < 0 ? path.join(process.env.HOME, 'pi-session.jsonl') : process.argv[sessionArg + 1];
if (sessionArg < 0) fs.writeFileSync(sessionFile, 'original-thread');
else if (fs.readFileSync(sessionFile, 'utf8') !== 'original-thread') throw new Error('Session history was lost');
const send = (data) => process.stdout.write(JSON.stringify(data) + '\\n');
const model = { provider: 'mock', id: 'model', name: 'Model' };
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const c = JSON.parse(line);
  if (c.type === 'prompt' && c.message === 'dispatch-failed') {
    send({ id: c.id, type: 'response', command: c.type, success: false, error: 'transport unavailable' });
    return;
  }
  const data = c.type === 'get_state'
    ? { sessionId: 'mock-pi-session', sessionFile, model, thinkingLevel: 'off' }
    : c.type === 'get_available_models' ? { models: process.env.MOCK_PI_NO_AUTH ? [] : [model] } : { commands: [] };
  send({ id: c.id, type: 'response', command: c.type, success: true, data });
  if (c.type !== 'prompt') return;
  if (c.message === 'crash') { process.exit(23); }
  if (c.message === 'tools') {
    send({ type: 'tool_execution_start', toolCallId: 'shell-1', toolName: 'bash', args: { command: 'printf hello' } });
    send({ type: 'tool_execution_update', toolCallId: 'shell-1', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'hello' }] } });
    send({ type: 'tool_execution_end', toolCallId: 'shell-1', toolName: 'bash', result: { content: [{ type: 'text', text: 'hello world' }], details: { exitCode: 0 } }, isError: false });
  }
  const finish = (stopReason, errorMessage) => send({ type: 'message_end', message: { role: 'assistant', stopReason, errorMessage } });
  if (c.message === 'retry') finish('error', 'Temporary failure');
  const reason = ['error', 'auth'].includes(c.message) ? 'error' : c.message === 'aborted' ? 'aborted' : c.message === 'length' ? 'length' : 'stop';
  if (reason === 'stop') send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ANSWER' } });
  finish(reason, c.message === 'auth' ? 'Invalid API key SECRET_SENTINEL' : 'Internal failure SECRET_SENTINEL');
  send({ type: 'agent_end' });
  send({ type: 'agent_settled' });
});
`, { mode: 0o755 })
}, 30_000)

afterAll(async () => { await fs.rm(root, { recursive: true, force: true }) })

it.each([
  [{ MOCK_PI_VERSION: '0.80.3' }, 'provider_incompatible'],
  [{ MOCK_PI_VERSION_FAIL: '1' }, 'provider_missing'],
  [{ MOCK_PI_NO_AUTH: '1' }, 'auth_required'],
] as const)('rejects unusable Pi at session setup: %j', async (env, kind) => {
  const home = await fs.mkdtemp(path.join(root, 'setup-'))
  const worker = new AcpWorker(path.join(home, 'journal.jsonl'))
  try {
    expect((await worker.handle({ id: 1, op: 'initialize', params: {
      adapterCommand: [process.execPath, path.join(root, 'pi-acp.js')], cwd: home,
      env: { HOME: home, PATH: home, PI_ACP_PI_COMMAND: path.join(root, 'pi'), ...env },
    } })).ok).toBe(true)
    const result = await worker.handle({ id: 2, op: 'newSession', params: { cwd: home } })
    expect(result).toMatchObject({ ok: false, error: { kind } })
    if (kind === 'provider_incompatible') {
      expect(result.error?.message).toBe('Pi 0.80.4 or newer is required; update the Pi CLI.')
      expect(await fs.readFile(path.join(home, 'journal.jsonl'), 'utf8')).toContain(result.error!.message)
    }
    const licenses = await fs.readFile(path.join(root, 'pi-acp.LICENSE'), 'utf8')
    for (const name of ['pi-acp 0.0.33', '@agentclientprotocol/sdk', 'zod', 'Apache License']) expect(licenses).toContain(name)
  } finally { await worker.handle({ id: 3, op: 'shutdown' }) }
})

it('rejects an unrecognized upstream patch context', () => {
  expect(() => patchPiAcp('different upstream bundle')).toThrow('patch context changed')
})

describe.each([
  ['error', 'protocol', undefined],
  ['auth', 'auth_required', undefined],
  ['dispatch-failed', 'protocol', undefined],
  ['crash', 'protocol', undefined],
  ['tools', undefined, 'end_turn'],
  ['retry', undefined, 'end_turn'],
  ['aborted', undefined, 'cancelled'],
  ['length', undefined, 'max_tokens'],
] as const)('bundled Pi adapter: %s', (prompt, errorKind, stopReason) => {
  it('reports the final outcome and accepts a subsequent turn', async () => {
    const home = path.join(root, prompt)
    await fs.mkdir(home)
    const wrongPathMarker = path.join(home, 'wrong-path')
    await fs.writeFile(path.join(home, 'pi'), `#!${process.execPath}\nimport fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(wrongPathMarker)}, 'called');\n`, { mode: 0o755 })
    const journal = path.join(home, 'journal.jsonl')
    const worker = new AcpWorker(journal)
    let id = 0
    const op = (name: WorkerOp, params?: Record<string, unknown>) => worker.handle({ id: ++id, op: name, params })
    const events = () => readJournal(journal).records.flatMap(({ record }) => record.kind === 'meta' ? [record.event] : [])
    try {
      const init = await op('initialize', {
        adapterCommand: [process.execPath, path.join(root, 'pi-acp.js')], cwd: home,
        env: { HOME: home, PATH: home, PI_ACP_PI_COMMAND: path.join(root, 'pi') },
      })
      expect(init.ok).toBe(true)
      expect((await op('newSession', { cwd: home })).ok).toBe(true)
      expect((await op('prompt', { commandId: 'first', walnutMessageId: 'first', text: prompt })).ok).toBe(true)
      await expect.poll(() => events().some((e) => (e.type === 'turn-ended' || e.type === 'turn-interrupted') && e.commandId === 'first')).toBe(true)
      if (errorKind) {
        expect(events()).toContainEqual(expect.objectContaining({ type: 'error', errorKind }))
        expect(events().some((e) => e.type === 'turn-ended')).toBe(false)
      } else {
        expect(events()).toContainEqual({ type: 'turn-ended', commandId: 'first', stopReason })
        expect(events().some((e) => e.type === 'error')).toBe(false)
      }
      expect(await fs.readFile(journal, 'utf8')).not.toContain('SECRET_SENTINEL')
      await expect(fs.stat(wrongPathMarker)).rejects.toMatchObject({ code: 'ENOENT' })
      if (prompt === 'tools') {
        const history = projectAcpJournalHistory('pi-tools', readJournal(journal).records.map(({ record }) => record))
        expect(history.flatMap((message) => message.tools ?? [])).toContainEqual(expect.objectContaining({
          input: { command: 'printf hello' }, result: 'hello world\nExit code: 0',
        }))
      }
      expect((await op('prompt', { commandId: 'second', walnutMessageId: 'second', text: 'recover' })).ok).toBe(true)
      await expect.poll(() => events()).toContainEqual({ type: 'turn-ended', commandId: 'second', stopReason: 'end_turn' })
      const spawns = (await fs.readFile(path.join(home, 'spawns.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
      expect(spawns).toEqual(prompt === 'crash'
        ? [['--mode', 'rpc', '--no-themes'], ['--mode', 'rpc', '--no-themes', '--session', path.join(home, 'pi-session.jsonl')]]
        : [['--mode', 'rpc', '--no-themes']])
      expect(await fs.readFile(path.join(home, 'pi-session.jsonl'), 'utf8')).toBe('original-thread')
    } finally {
      await op('shutdown')
    }
  }, 15_000)
})
