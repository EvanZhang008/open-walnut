/**
 * Unit tests for the outbound-send detector behind the sender-side provenance
 * card (the mirror of session-envelope.test.ts, which covers the receiving side).
 *
 * The theme here is that ONE server op arrives in the transcript in many shapes:
 * an MCP tool call whose arguments are a real object, and a Bash command whose
 * payload is a shell word that may be single-quoted with embedded apostrophes, a
 * `@file` reference, or `-` for stdin. Every one of those is the same
 * conversation, so all of them must card.
 *
 * The other theme is restraint. Talking ABOUT the op (`tools help session_send`,
 * `tools call session_send --help`) and quoting it in prose are not sends, and a
 * card that claimed otherwise would put words in this session's mouth.
 */
import { describe, it, expect } from 'vitest';
import type { SessionHistoryTool } from '../../web/src/types/session';
import { detectOutboundSend } from '../../web/src/components/sessions/session-outbound';

function bash(command: string, extra: Partial<SessionHistoryTool> = {}): SessionHistoryTool {
  return { name: 'Bash', input: { command }, ...extra };
}

function mcp(input: Record<string, unknown>, name = 'mcp__walnut__session_send'): SessionHistoryTool {
  return { name, input };
}

/** A realistic `session_send` answer, as the server writes it. */
const SEND_RESULT = JSON.stringify({
  delivery: 'queued',
  targetSessionId: 'ab12cd34-5678-4aaa-8bbb-000000000001',
  targetTitle: 'Fable rollout on the Mac',
  targetTaskId: 'task-9f1',
  target: {
    handle: 'Fable rollout on the Mac [ab12cd34]',
    sessionId: 'ab12cd34-5678-4aaa-8bbb-000000000001',
    taskId: 'task-9f1',
  },
  requestId: 'rq-09cd2ef25e57',
  messageId: 'qm-1a2b3c',
});

describe('detectOutboundSend — MCP transport', () => {
  it('cards an MCP send and folds the server answer into the card', () => {
    const send = detectOutboundSend(
      mcp({ to: 'ab12cd34', text: 'Both blockers cleared on my side.', expect_reply: true }),
      SEND_RESULT,
    );
    expect(send).not.toBeNull();
    expect(send!.via).toBe('mcp');
    expect(send!.kind).toBe('peer-note');
    expect(send!.to).toBe('ab12cd34');
    expect(send!.body).toBe('Both blockers cleared on my side.');
    expect(send!.requestId).toBe('rq-09cd2ef25e57');
    expect(send!.delivery).toBe('queued');
    expect(send!.target).toEqual({
      handle: 'Fable rollout on the Mac [ab12cd34]',
      sessionId: 'ab12cd34-5678-4aaa-8bbb-000000000001',
      taskId: 'task-9f1',
      title: 'Fable rollout on the Mac',
    });
    // The raw disclosure shows what the model actually called with.
    expect(send!.raw).toContain('"to": "ab12cd34"');
  });

  it('reads the answer out of MCP content blocks', () => {
    const wrapped = JSON.stringify([{ type: 'text', text: SEND_RESULT }]);
    const send = detectOutboundSend(mcp({ to: 'ab12cd34', text: 'hi' }), wrapped);
    expect(send!.target?.sessionId).toBe('ab12cd34-5678-4aaa-8bbb-000000000001');
    expect(send!.delivery).toBe('queued');
  });

  it('accepts any MCP server key, and no other tool', () => {
    expect(detectOutboundSend(mcp({ text: 'x' }, 'mcp__personal__session_send'))).not.toBeNull();
    expect(detectOutboundSend(mcp({ text: 'x' }, 'mcp__walnut__session_start'))).toBeNull();
    expect(detectOutboundSend(mcp({ text: 'x' }, 'mcp____session_send'))).toBeNull();
    expect(detectOutboundSend({ name: 'Read', input: { file_path: '/tmp/session_send.md' } })).toBeNull();
  });

  it('is a reply when in_reply_to is present', () => {
    const send = detectOutboundSend(
      mcp({ in_reply_to: 'rq-09cd2ef25e57', text: 'Yes, the daemon is on 2.1.255.' }),
      JSON.stringify({ delivery: 'queued', repliedTo: 'rq-09cd2ef25e57' }),
    );
    expect(send!.kind).toBe('reply');
    expect(send!.repliedTo).toBe('rq-09cd2ef25e57');
  });
});

describe('detectOutboundSend — CLI transport', () => {
  it('parses a single-quoted JSON payload', () => {
    const send = detectOutboundSend(
      bash(`walnut tools call session_send '{"to":"ab12cd34","text":"Both blockers cleared.\\nShipping now.","expect_reply":true}'`),
      SEND_RESULT,
    );
    expect(send!.via).toBe('cli');
    expect(send!.to).toBe('ab12cd34');
    expect(send!.body).toBe('Both blockers cleared.\nShipping now.');
    expect(send!.target?.taskId).toBe('task-9f1');
    expect(send!.raw).toContain('walnut tools call session_send');
  });

  it("survives the two shell ways of quoting an apostrophe", () => {
    // `'"'"'` — close, double-quote a quote, reopen.
    const dq = detectOutboundSend(
      bash(`walnut tools call session_send '{"to":"peer","text":"it'"'"'s green"}'`),
    );
    expect(dq!.body).toBe("it's green");
    // `'\''` — close, backslash-escape a quote, reopen.
    const bs = detectOutboundSend(
      bash(`walnut tools call session_send '{"to":"peer","text":"it'\\''s green"}'`),
    );
    expect(bs!.body).toBe("it's green");
  });

  it('accepts open-walnut, a path-qualified binary, and an env prefix', () => {
    expect(detectOutboundSend(bash(`open-walnut tools call session_send '{"text":"a"}'`))!.body).toBe('a');
    expect(detectOutboundSend(bash(`/usr/local/bin/walnut tools call session_send '{"text":"b"}'`))!.body).toBe('b');
    expect(detectOutboundSend(bash(`WALNUT_SESSION_ID=x walnut tools call session_send '{"text":"c"}'`))!.body).toBe('c');
  });

  it('accepts a pipeline whose payload comes from stdin', () => {
    const send = detectOutboundSend(
      bash(`python3 /tmp/build_args.py | walnut tools call session_send -`),
      SEND_RESULT,
    );
    expect(send!.via).toBe('cli');
    expect(send!.payloadFrom).toBe('stdin');
    expect(send!.body).toBeUndefined();
    // Nothing about the target came from the command, so the answer carries it all.
    expect(send!.target?.sessionId).toBe('ab12cd34-5678-4aaa-8bbb-000000000001');
    expect(send!.delivery).toBe('queued');
  });

  it('marks an @file payload as living outside the transcript', () => {
    const send = detectOutboundSend(
      bash(`walnut tools call session_send @/tmp/wn/args.json`),
      SEND_RESULT,
    );
    expect(send!.payloadFrom).toBe('file');
    expect(send!.body).toBeUndefined();
    expect(send!.target?.title).toBe('Fable rollout on the Mac');
  });

  it('is a reply when the payload carries in_reply_to', () => {
    const send = detectOutboundSend(
      bash(`walnut tools call session_send '{"in_reply_to":"rq-09cd2ef25e57","text":"done"}'`),
    );
    expect(send!.kind).toBe('reply');
    expect(send!.repliedTo).toBe('rq-09cd2ef25e57');
    expect(send!.to).toBeUndefined();
  });

  it('reports a server error instead of a card that looks successful', () => {
    const send = detectOutboundSend(
      bash(`walnut tools call session_send '{"to":"nope","text":"hi"}'`),
      JSON.stringify({ error: { code: 'unknown_peer', message: '"nope" matches no session' } }),
    );
    expect(send!.error).toBe('"nope" matches no session');
    expect(send!.delivery).toBeUndefined();
  });

  it('falls back to the first output line when a failure is not JSON', () => {
    const send = detectOutboundSend(
      bash(`walnut tools call session_send '{"to":"nope","text":"hi"}'`, { isError: true }),
      '\nerror: no reachable Walnut daemon socket on this host\nexit 6\n',
    );
    expect(send!.error).toBe('error: no reachable Walnut daemon socket on this host');
  });
});

describe('detectOutboundSend — what must NOT card', () => {
  it('ignores asking ABOUT the op', () => {
    expect(detectOutboundSend(bash('walnut tools help session_send'))).toBeNull();
    expect(detectOutboundSend(bash('walnut tools call session_send --help'))).toBeNull();
    expect(detectOutboundSend(bash('walnut tools call session_send -h'))).toBeNull();
    expect(detectOutboundSend(bash('walnut tools list'))).toBeNull();
    expect(detectOutboundSend(bash('walnut tools list --json | grep session_send'))).toBeNull();
  });

  it('ignores prose that merely mentions the command', () => {
    expect(detectOutboundSend(bash(
      `echo "reply with walnut tools call session_send '{\\"in_reply_to\\":\\"rq-1\\"}'"`,
    ))).toBeNull();
    expect(detectOutboundSend(bash(
      `grep -rn 'walnut tools call session_send' src/`,
    ))).toBeNull();
    expect(detectOutboundSend(bash(
      `cat <<'EOF' > /tmp/note.md\nUse walnut tools call session_send to answer.\nEOF`,
    ))).toBeNull();
  });

  it('ignores a Bash row with no command string at all', () => {
    expect(detectOutboundSend({ name: 'Bash', input: {} })).toBeNull();
    expect(detectOutboundSend({ name: 'Bash', input: { command: 42 as unknown as string } })).toBeNull();
  });
});

describe('detectOutboundSend — never throws', () => {
  it('still cards a malformed payload, with the command as raw and no body', () => {
    const command = `walnut tools call session_send '{"to":"peer","text":"unclosed`;
    const send = detectOutboundSend(bash(command));
    expect(send).not.toBeNull();
    expect(send!.body).toBeUndefined();
    expect(send!.to).toBeUndefined();
    expect(send!.raw).toBe(command);
    expect(send!.kind).toBe('peer-note');
  });

  it('tolerates junk in the result and in the arguments', () => {
    const cases: Array<[SessionHistoryTool, string | undefined]> = [
      [bash(`walnut tools call session_send '{'`), 'not json at all {{{'],
      [bash(`walnut tools call session_send ''`), '{"delivery":'],
      [bash('walnut tools call session_send'), undefined],
      [mcp({ to: 5, text: { nested: true } }), '[[[]]'],
      [mcp({}), ''],
    ];
    for (const [tool, result] of cases) {
      const send = detectOutboundSend(tool, result);
      expect(send).not.toBeNull();
      expect(typeof send!.raw).toBe('string');
      expect(send!.body).toBeUndefined();
    }
  });

  it('reads a truthful answer even when other output surrounds it', () => {
    const noisy = `warning: slow daemon\n${SEND_RESULT}\nnext: walnut wait rq-09cd2ef25e57\n`;
    const send = detectOutboundSend(bash(`walnut tools call session_send '{"to":"ab12cd34","text":"go"}'`), noisy);
    expect(send!.delivery).toBe('queued');
    expect(send!.requestId).toBe('rq-09cd2ef25e57');
  });
});
