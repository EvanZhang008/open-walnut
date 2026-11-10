/**
 * A Walnut op run through the CLI renders as the MCP tool it stands in for
 * (parseCliWalnutCall / walnutToolView in web/src/components/sessions/session-outbound.ts).
 *
 * 2026-11-10, the user: the MCP and `walnut tools call` are the same ops, so a CLI
 * call should read like the MCP call, never as a raw Bash card. The theme is the
 * shapes one call takes in a transcript (inline JSON, a here-document, a file,
 * stdin, an env prefix, a pipe into a reader), and restraint: a script that does
 * other work too, or that only talks about the CLI, stays a command.
 */
import { describe, it, expect } from 'vitest';
import { parseCliWalnutCall, walnutToolView, detectOutboundSend } from '../../web/src/components/sessions/session-outbound';
import { toolRunPhrase } from '../../web/src/components/sessions/tool-run-phrase';

const bash = (command: string) => ({ name: 'Bash', input: { command } });

describe('a CLI call of a Walnut op reads as the MCP call', () => {
  it('inline JSON, single- or double-quoted, with the walnut binary under any path', () => {
    expect(parseCliWalnutCall(`walnut tools call task_get '{"id":"abc"}'`)).toEqual({ op: 'task_get', input: { id: 'abc' } });
    expect(parseCliWalnutCall(`/x/bin/walnut tools call task_update "{\\"id\\":\\"a\\",\\"phase\\":\\"WAITING\\"}"`))
      .toEqual({ op: 'task_update', input: { id: 'a', phase: 'WAITING' } });
  });

  it('no arguments, an env prefix, a pipe into a reader, a redirect', () => {
    expect(parseCliWalnutCall('walnut tools call open_items')).toEqual({ op: 'open_items', input: {} });
    expect(parseCliWalnutCall(`WALNUT_TEST_RUN=x walnut tools call task_list '{"limit":5}' 2>&1 | head -40`))
      .toEqual({ op: 'task_list', input: { limit: 5 } });
  });

  it('a here-document body is the arguments', () => {
    const cmd = `walnut tools call task_send - <<'EOF'\n{"in_reply_to":"rq-1","text":"it's done"}\nEOF`;
    expect(parseCliWalnutCall(cmd)).toEqual({ op: 'task_send', input: { in_reply_to: 'rq-1', text: "it's done" } });
    const tabbed = `walnut tools call task_get - <<-'END'\n\t{"id":"t"}\n\tEND`;
    expect(parseCliWalnutCall(tabbed)).toEqual({ op: 'task_get', input: { id: 't' } });
  });

  it('a file or stdin the transcript does not hold: the op, flagged where its arguments came from', () => {
    expect(parseCliWalnutCall('walnut tools call human_inbox_send @/tmp/letter.json')).toEqual({ op: 'human_inbox_send', input: {}, payloadFrom: 'file' });
    expect(parseCliWalnutCall('walnut tools call task_get -')).toEqual({ op: 'task_get', input: {}, payloadFrom: 'stdin' });
  });

  it('a script doing other work, help, a loop, or prose about the CLI stays a command', () => {
    for (const cmd of [
      `walnut tools call task_get '{"id":"a"}' && git status`,
      `cd /x; walnut tools call task_get '{"id":"a"}'`,
      `walnut tools call task_get --help`,
      `walnut tools list`,
      `for t in a b; do walnut tools call task_get "{\\"id\\":\\"$t\\"}"; done`,
      `python3 - <<'PY'\nimport subprocess\nsubprocess.run(['walnut','tools','call','task_send','{}'])\nPY`,
      `echo "walnut tools call task_get"`,
      `walnut tools call task_get '{"id":"a"}'\ngit log -1`,
      `walnut tools call task_get 'not json'`,
      `walnut tools call task_get $(cat args.json)`,
      // Review 2026-11-10: what a pipe feeds, what a redirect writes, what the shell expands.
      `walnut tools call task_list '{}' | sh`,
      `walnut tools call task_list '{}' | xargs -n1 rm`,
      `walnut tools call task_list '{}' | python3 process.py`,
      `walnut tools call task_get '{"id":"x"}' | walnut tools call task_send -`,
      `walnut tools call task_list '{}' > ~/somefile`,
      `walnut tools call task_list '{}' | jq . > out.json`,
      `walnut tools call task_list '{}' extra`,
      `walnut tools call task_list '{}' &`,
      `walnut tools call task_get "{\"id\":\"$(rm -rf ~)\"}"`,
      `walnut tools call task_get "{\"id\":\"$TASK\"}"`,
      "walnut tools call task_send '{\"text\":\"'`date`'\"}'",
      "FOO=`whoami` walnut tools call task_list",
      `walnut tools call task_send - <<EOF\n{"text":"$(date)"}\nEOF`,
    ]) expect(parseCliWalnutCall(cmd), cmd).toBeNull();
  });

  it('a literal $ or backtick inside single quotes is just text', () => {
    expect(parseCliWalnutCall(`walnut tools call task_send '{"text":"costs $5, run \`ls\`"}' 2>/dev/null | jq .`))
      .toEqual({ op: 'task_send', input: { text: 'costs $5, run `ls`' } });
  });

  it('walnutToolView renames the call and keeps every other field; anything else comes back as it was', () => {
    const t = { ...bash(`walnut tools call task_get '{"id":"a"}'`), toolUseId: 'tu1', result: '{"ok":1}' };
    expect(walnutToolView(t)).toEqual({ name: 'mcp__walnut__task_get', input: { id: 'a' }, toolUseId: 'tu1', result: '{"ok":1}' });
    const plain = bash('ls -la');
    expect(walnutToolView(plain)).toBe(plain);
    const mcp = { name: 'mcp__walnut__task_get', input: { id: 'a' } };
    expect(walnutToolView(mcp)).toBe(mcp);
  });

  it('the fold line counts it as the op, not as "ran a command"', () => {
    const cli = toolRunPhrase([bash(`walnut tools call task_send '{"task_id":"x","text":"hi"}'`)]);
    const mcp = toolRunPhrase([{ name: 'mcp__walnut__task_send', input: { task_id: 'x', text: 'hi' } }]);
    expect(cli).toBe(mcp);
    expect(cli).not.toMatch(/command/);
  });

  it('a here-document send cards with its payload, the same as the MCP send', () => {
    const cmd = `walnut tools call task_send - <<'EOF'\n{"task_id":"t-1","text":"hello there"}\nEOF`;
    const cli = detectOutboundSend(bash(cmd));
    const mcp = detectOutboundSend({ name: 'mcp__walnut__task_send', input: { task_id: 't-1', text: 'hello there' } });
    expect(cli?.body).toBe("hello there");
    expect(cli?.body).toBe(mcp?.body);
    expect(cli?.payloadFrom).toBeUndefined();
  });
});
