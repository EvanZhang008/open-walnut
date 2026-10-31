/**
 * A "$14.99" the shell already ate is refused, not delivered.
 *
 * 2026-10-30: a lead passed its reply to `walnut tools call` with the JSON in double quotes,
 * zsh expanded "$14" and "$52" as positional parameters (empty), and Main read the prices as
 * ".99" and ".52". Nothing in Walnut saw a problem. Every CLI face now checks the parsed
 * arguments for the shapes a lost `$N` leaves and refuses with the way to quote it.
 *
 * Two layers, both driven through a real shell here. zsh leaves "$14.99" as ".99", a shape
 * the CLI can see in what it parsed (wn-cli.ts, the JS twin, the hub CLI); sh and bash read
 * "$14" as "$1" then "4" and leave "4.99", which no check of the parsed text can tell from a
 * real price. So every Claude Code session also carries a Bash PreToolUse hook that reads
 * the command as typed and refuses a `$` and a digit the shell would expand in a walnut call
 * (shell-dollar-guard-hook.ts).
 */
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { STRIPPED_AMOUNT, PROSE_FIELDS, strippedShellText, strippedShellTextMessage } from '../../../src/providers/tool-args-source.js';
import { getDaemonSource } from '../../../src/providers/daemon-source.js';
import { SHELL_DOLLAR_GUARD_COMMAND } from '../../../src/providers/shell-dollar-guard-hook.js';
import { sessionSettingsHooks } from '../../../src/providers/session-settings-hooks.js';
import { SOURCE_TWIN } from '../../helpers/source-twin.js';

const REPO = path.resolve(__dirname, '../../..');

describe('strippedShellText', () => {
  it('flags the shapes a lost $N leaves, at any depth, and names the field', () => {
    expect(strippedShellText({ text: 'Awastea white peach oolong .99' })).toMatchObject({ field: 'text', found: '.99' });
    expect(strippedShellText({ text: 'Total: .52' })).toMatchObject({ found: '.52' });
    expect(strippedShellText({ text: 'Paid ,000 upfront' })).toMatchObject({ found: ',000' });
    // "$0" is the shell's own name.
    expect(strippedShellText({ text: 'it costs zsh.50' })).toMatchObject({ found: 'zsh.50' });
    expect(strippedShellText({ text: 'it costs -zsh.50' })).toMatchObject({ found: '-zsh.50' });
    expect(strippedShellText({ result: { lines: ['fine', 'cost .99'] } })).toMatchObject({ field: 'result.lines.1' });
  });

  it('leaves whole text alone', () => {
    for (const text of [
      'Tea $14.99 today', 'version 0.99', 'v1.99', '3,000 rows', 'meet at 12.30', 'a .md file', 'padding: .5rem',
      'x = .5', 'took .25s', 'A list, 000 items', 'see a.b.c', '\u4ef7\u683c $14.99',
      'opacity: .85;', 'rgba(0,0,0,.08)', 'scale(.95)', 'line-height:.85}',
    ]) expect(strippedShellText({ text }), text).toBeNull();
    expect(strippedShellText({ n: 5, ok: true, list: [] })).toBeNull();
    // Only prose is read: a Board's html, a script, a note's content may hold anything.
    expect(strippedShellText({ html: '<p>Tea .99</p>', script: 'x .99', content: 'a .99' })).toBeNull();
    expect(strippedShellText('oolong .99')).toBeNull();
  });

  it('says how to send it again', () => {
    const msg = strippedShellTextMessage(strippedShellText({ text: 'oolong .99' })!);
    expect(msg).toMatch(/"text" looks cut by the shell/);
    expect(msg).toMatch(/Nothing was sent/);
    expect(msg).toMatch(/single quotes/);
    expect(msg).toMatch(/<<'EOF'/);
    expect(msg).toMatch(/WALNUT_TEXT_CHECK=0/);
  });

  it('every CLI face runs the check before it sends', () => {
    // Three implementations of `walnut tools call` (wn-cli.ts, the hub CLI, the JS twin).
    const read = (f: string) => fs.readFileSync(path.join(REPO, f), 'utf8');
    expect(read('src/providers/wn-cli.ts')).toMatch(/strippedShellText\(callArgs\)/);
    expect(read('src/commands/tools.ts')).toMatch(/strippedShellText\(parsed\)/);
    expect(getDaemonSource()).toMatch(/wnStrippedText\(parsedCall\.args, '', 0\)/);
    // The JS twin's hand copy reads the same shapes in the same fields.
    expect(getDaemonSource()).toContain(`var WN_STRIPPED_AMOUNT = /${STRIPPED_AMOUNT.source}/u;`);
    expect(getDaemonSource()).toContain(JSON.stringify(PROSE_FIELDS).replace(/"/g, "'").replace(/,/g, ', '));
  });
});

const HAS_ZSH = spawnSync('zsh', ['-c', 'true']).status === 0;
const shells = ['/bin/sh', ...(HAS_ZSH ? ['zsh'] : [])];
const TEXT = 'white peach oolong $14.99';
// Exactly what an agent typed: the JSON inside double quotes.
const DOUBLE = `tools call task_send "{\\"to\\":\\"t_9f3a\\",\\"title\\":\\"Tea\\",\\"text\\":\\"${TEXT}\\"}"`;
const SINGLE = `tools call task_send '{"to":"t_9f3a","title":"Tea","text":"${TEXT}"}'`;
const HEREDOC = `tools call task_send - <<'EOF'\n{"to":"t_9f3a","title":"Tea","text":"it's $14.99"}\nEOF`;
const LOOSE_HEREDOC = `tools call task_send - <<EOF\n{"to":"t_9f3a","title":"Tea","text":"${TEXT}"}\nEOF`;

/** The hook's answer to a command, the way the engine asks it (JSON on stdin). */
function hookDenies(command: string): boolean {
  const r = spawnSync('/bin/sh', ['-c', SHELL_DOLLAR_GUARD_COMMAND], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8',
  });
  if (!r.stdout) return false;
  const out = JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/single quotes/);
  return out.hookSpecificOutput.permissionDecision === 'deny';
}

describe('the Bash hook reads the command as typed', () => {
  it('refuses every form the shell would expand, and passes every quoted one', () => {
    expect(hookDenies(`walnut ${DOUBLE}`)).toBe(true);
    expect(hookDenies(`walnut ${LOOSE_HEREDOC}`)).toBe(true);
    expect(hookDenies(`cat > a.json <<EOF\n{"text":"$52.52"}\nEOF\nwalnut tools call task_send @a.json`)).toBe(true);
    expect(hookDenies(`walnut tools call board_post --text "paid $5,000"`)).toBe(true);
    expect(hookDenies(`walnut ${SINGLE}`)).toBe(false);
    expect(hookDenies(`walnut ${HEREDOC}`)).toBe(false);
    expect(hookDenies(`walnut tools call task_send "{\"text\":\"Tea \\$14.99\"}"`)).toBe(false);
    // Braced is meant; a command that is not a walnut call is not this hook's.
    expect(hookDenies('f() { walnut tools call task_get "{\\"id\\":\\"${1}\\"}"; }')).toBe(false);
    expect(hookDenies('echo "$1" && ls')).toBe(false);
    // A path or tool that only contains the word is not a walnut call.
    expect(hookDenies('cd /repo/open-walnut && echo "$1"')).toBe(false);
    expect(hookDenies('walnut-dev run sh -c "echo $1"')).toBe(false);
    expect(hookDenies('~/.local/bin/walnut tools call y "{\\"t\\":\\"$1\\"}"')).toBe(true);
    // A here-string is a quoted word like any other.
    expect(hookDenies(`walnut tools call x - <<< '{"a":"Tea $14"}'`)).toBe(false);
    expect(hookDenies(`walnut tools call x - <<< "{\"a\":\"$14\"}"`)).toBe(true);
    // An apostrophe in a comment opens no quote.
    expect(hookDenies(`# don't forget\nwalnut tools call y "{\"t\":\"$1\"}"`)).toBe(true);
    // <<- with a tab-indented delimiter ends the body; the command after it is still read.
    expect(hookDenies(`cat <<-'EOF' > a\n\tx\n\tEOF\nwalnut tools call y "{\"t\":\"$1\"}"`)).toBe(true);
  });

  it('rides every Claude Code session\'s settings, and can be turned off', () => {
    const commands = (env: NodeJS.ProcessEnv) => JSON.stringify(sessionSettingsHooks(env));
    expect(commands({})).toContain(JSON.stringify(SHELL_DOLLAR_GUARD_COMMAND).slice(1, 40));
    expect(commands({ WALNUT_SHELL_DOLLAR_GUARD: '0' })).not.toContain(JSON.stringify(SHELL_DOLLAR_GUARD_COMMAND).slice(1, 40));
  });

  it.each(shells)('what %s does to a double-quoted $14.99 without it: the loss the hook stops', (shell) => {
    const r = spawnSync(shell, ['-c', `printf '%s' "${TEXT}"`], { encoding: 'utf8' });
    expect(r.stdout).not.toContain('$14.99');
    expect(r.stdout).toMatch(shell === 'zsh' ? /oolong \.99$/ : /oolong 4\.99$/);
  });
});

/** A socket that answers ok and records every line that reaches it. */
async function gatewaySocket(dir: string): Promise<{ sock: string; received: () => string; close: () => void }> {
  const sock = path.join(dir, `gw-${Math.random().toString(36).slice(2, 8)}.sock`);
  let received = '';
  const server = net.createServer((c) => {
    c.on('data', (d) => {
      received += d.toString('utf-8');
      if (received.includes('\n')) c.write(JSON.stringify({ ok: true, result: { delivery: 'queued' } }) + '\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(sock, () => resolve()));
  fs.chmodSync(sock, 0o600);
  return { sock, received: () => received, close: () => server.close() };
}

function run(shell: string, script: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(shell, ['-c', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, err }));
  });
}

describe.each(['wn-cli', 'twin'] as const)('the CLI (%s) refuses a text zsh already cut', (face) => {
  let dir = '';
  let cmd = '';
  const env = () => ({ ...process.env, WALNUT_DAEMON_DIR: dir, WALNUT_SESSION_ID: 'probe-sid', WALNUT_TEXT_CHECK: '' });
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-dollar-'));
    if (face === 'twin') {
      const twin = path.join(dir, 'daemon.cjs');
      fs.writeFileSync(twin, getDaemonSource());
      cmd = `"${SOURCE_TWIN.file}" "${twin}" wn`;
    } else {
      const runner = path.join(dir, 'runner.ts');
      fs.writeFileSync(runner, `import { runWalnutCli } from ${JSON.stringify(path.join(REPO, 'src/providers/wn-cli.ts'))}\n`
        + 'process.exit(await runWalnutCli(process.argv.slice(2)))\n');
      cmd = `"${process.execPath}" "${runner}"`;
    }
  });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  async function call(shell: string, script: string, extra: NodeJS.ProcessEnv = {}) {
    const gw = await gatewaySocket(dir);
    const r = await run(shell, `${cmd} ${script}`, { ...env(), WALNUT_AGENT_SOCKET: gw.sock, ...extra });
    gw.close();
    return { ...r, received: gw.received() };
  }

  it.skipIf(!HAS_ZSH)('zsh, double quotes: refused, nothing reaches the gateway; WALNUT_TEXT_CHECK=0 lets it through', async () => {
    const r = await call('zsh', DOUBLE);
    expect(r.code, r.err).toBe(2);
    expect(r.err).toMatch(/"text" looks cut by the shell: "\.99"/);
    expect(r.err).toMatch(/Nothing was sent/);
    expect(r.received).toBe('');
    const forced = await call('zsh', DOUBLE, { WALNUT_TEXT_CHECK: '0' });
    expect(forced.code, forced.err).toBe(0);
    expect(forced.received).toContain('white peach oolong .99');
  }, 120_000);

  it('a payload from a file or stdin is not the shell\'s to cut: never refused', async () => {
    const file = path.join(dir, 'args.json');
    fs.writeFileSync(file, JSON.stringify({ to: 't_9f3a', title: 'Tea', text: 'oolong .99' }));
    const r = await call('/bin/sh', `tools call task_send @${file}`);
    expect(r.code, r.err).toBe(0);
    expect(r.received).toContain('oolong .99');
  }, 120_000);

  it.each(shells)('%s, single quotes or a quoted heredoc: the amount arrives whole', async (shell) => {
    for (const script of [SINGLE, HEREDOC]) {
      const r = await call(shell, script);
      expect(r.code, r.err).toBe(0);
      expect(r.received).toContain('$14.99');
    }
  }, 120_000);
});
