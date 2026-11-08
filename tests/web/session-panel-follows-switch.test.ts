/**
 * Every panel follows its task to the session an engine switch started, whichever host
 * draws it (2026-11-05, the user: "Iswitch fro claude code to pi and it doesn;t work ...
 * it go back automactily to claude code", then "ok now even grey"). A plugin page kept its
 * own session id and drew the replaced Claude Code session, its engine rail locked, because
 * only hosts that passed `onSessionReplaced` followed.
 *
 * Pinned from the source, since the root vitest has no DOM:
 *  - the exported SessionPanel is the wrapper that follows by itself when its host does not,
 *    and the body it wraps is reachable only through it;
 *  - every file that renders <SessionPanel> gets that wrapper (none imports the body);
 *  - closing the model picker commits a pick of another engine (no "next message" card);
 *  - a panel opened on a replaced session follows, except one opened on purpose from the
 *    task's earlier sessions;
 *  - a message sent from a panel still on a replaced session reports where it went, and the
 *    panel follows it there (2026-11-05, the user: "after switching to Claude Code, I send and
 *    it does not go out": the plugin page drew the replaced session, the server sent his three
 *    messages on to Pi, and his bubbles stayed grey there for good).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('a session panel follows the task to its new session in every host', () => {
  const panel = read('web/src/components/sessions/SessionPanel.tsx');

  it('the exported SessionPanel is the following wrapper around a body nobody else reaches', () => {
    const wrapper = panel.slice(panel.indexOf('export const SessionPanel = memo('), panel.indexOf('const SessionPanelBody = memo('));
    expect(wrapper.length).toBeGreaterThan(0);
    expect(wrapper).toContain('setFollowed({ from: sessionId, to: newId })');
    expect(wrapper).toContain('<SessionPanelBody {...props} sessionId={shown} onSessionReplaced={replaced} />');
    expect(panel).not.toMatch(/export\s+(const|function)\s+SessionPanelBody/);
  });

  it('every host renders the wrapper, never the body', () => {
    const hosts = walk(path.join(root, 'web/src')).filter((f) => /<SessionPanel[\s>]/.test(fs.readFileSync(f, 'utf8')));
    // The plugin pages, the drawers, the Org page and the notes chat are among them.
    expect(hosts.length).toBeGreaterThanOrEqual(5);
    for (const f of walk(path.join(root, 'web/src'))) {
      if (f.endsWith('SessionPanel.tsx')) continue;
      expect(fs.readFileSync(f, 'utf8'), path.relative(root, f)).not.toContain('SessionPanelBody');
    }
  });

  it('closing the picker on another engine switches at once', () => {
    expect(panel).toContain('onPickerClose={engineSwitch.enabled ? engineSwitch.commit : undefined}');
    const pill = read('web/src/components/sessions/ComposerModelPill.tsx');
    expect(pill).toContain('onClose={() => { setPickerOpen(false); onPickerClose?.(); }}');
    // Every way the picker closes is a close (a model row, an effort, the pill clicked again,
    // Escape, outside), except the pill leaving the page, which drops the pick: each
    // setPickerOpen(false) is followed by one of the two, and nothing toggles it shut silently.
    const lines = pill.split('\n');
    const closes = lines.flatMap((l, i) => (l.includes('setPickerOpen(false)') ? [i] : []));
    expect(closes.length).toBeGreaterThanOrEqual(6);
    for (const i of closes) {
      expect(lines.slice(i, i + 8).join('\n'), `ComposerModelPill.tsx:${i + 1}`).toMatch(/onPicker(Close|Cancel)\?\.\(\)/);
    }
    expect(pill).not.toMatch(/setPickerOpen\(\(v\) => !v\)/);
    expect(pill).toContain('onAnchorLost={() => { setPickerOpen(false); onPickerCancel?.(); }}');
    const sw = read('web/src/components/sessions/EngineSwitch.tsx');
    expect(sw).toMatch(/switchTaskEngine\(taskId, p[,)]/);
    const api = read('web/src/api/engine-switch.ts');
    expect(api).toContain("when: 'now', detach: true");
  });

  it('a panel opened on a replaced session follows, unless opened on purpose from the earlier sessions', () => {
    const sw = read('web/src/components/sessions/EngineSwitch.tsx');
    expect(sw).toContain("session?.archive_reason?.startsWith('engine_switched:')");
    // The panel that opens it takes the mark: another panel on the same id still follows.
    expect(sw).toContain('on: openedOnPurpose.delete(sessionId)');
    expect(sw).toContain('|| onPurpose) return;');
    const earlier = read('web/src/components/sessions/TaskEarlierSessions.tsx');
    expect(earlier).toContain('markOpenedOnPurpose(row.session_id); onOpen(row.session_id);');
  });

  it('a send the server delivered elsewhere reports it, and every panel send path follows it', () => {
    // Only a real redirect, by the whole id: sends never resolve a session by prefix, so an
    // unmoved send answers the id it was given, and a new session whose id starts with the
    // old one is still a redirect (src/lib/id-ref.ts: the whole id wins).
    expect(read('src/web/routes/session-chat.ts')).toContain('...(msg.sessionId && msg.sessionId !== data.sessionId ? { deliveredTo: msg.sessionId } : {}),');
    const hook = read('web/src/hooks/useSessionSend.ts');
    // Every send goes through the one acceptance rule (api/session-send.ts), whose answer carries deliveredTo.
    const rpcs = hook.match(/\bsendSessionMessage\(/g) ?? [];
    expect(rpcs.length).toBeGreaterThanOrEqual(3);
    expect(read('web/src/api/session-send.ts'), 'every session:send answer reads deliveredTo').toMatch(/interface SendAck \{[\s\S]*?\n  deliveredTo\?: string;/);
    expect(hook.match(/followRedirect\(res, /g)?.length).toBe(rpcs.length);
    expect(panel).toContain('if (redirectedTo && redirectedTo !== sessionId) onSessionReplaced?.(sessionId, redirectedTo);');
    // The phone's send says the same (api-v1.md, deliveredTo).
    expect(read('src/web/routes/session-send-v1.ts')).toContain('...(msg.sessionId && msg.sessionId !== sessionId ? { deliveredTo: msg.sessionId } : {}),');
  });
});

/**
 * The class (2026-11-05, the user: "each engine can freely change back and forth, no problem at
 * all"): a surface that holds a session id goes stale when a switch replaces the session. Every
 * file that draws a session's chat or sends into one by id is listed here with how it stays on
 * the task's current conversation; a new one fails until it is placed.
 */
describe('every surface that holds a session id stays on the task\'s current conversation', () => {
  const files = walk(path.join(root, 'web/src')).filter((f) => !/\.test\./.test(f));
  const rel = (f: string) => path.relative(root, f);

  // Draws a session's chat outside SessionPanel.
  const CHAT_HOSTS: Record<string, string | null> = {
    // Resolves the task's session each render (the task's own session_id moves with a switch).
    'web/src/components/dock/FocusDock.tsx': 'resolveTaskSessionId(task)',
    'web/src/components/notes/NotesSessionChat.tsx': 'd.task.exec_session_id ?? d.task.plan_session_id',
    // Not a task's engine-switchable conversation: a search ask, a fork tree, a side question.
    'web/src/components/tasks/AgentSearchFollowUp.tsx': null,
    'web/src/components/sessions/TreeSplitLeft.tsx': null,
    // The reading split's pane reads the panel's own timeline (reader-split.tsx), never a session of its own.
    'web/src/components/sessions/SessionReaderPane.tsx': null,
    'web/src/components/sessions/SideQuestionDrawer.tsx': null,
  };
  // Sends into a session by id outside useSessionSend: each sends once and closes (no bubble
  // waits on that session), and the server hands a replaced session's message to the current one.
  const ONE_SHOT_SENDERS = [
    'web/src/components/chat/AskObjectDrawer.tsx',
    'web/src/components/board/kanban/KanbanCardComposer.tsx',
    'web/src/components/org/ask-main.ts',
    'web/src/popout/PopoutExtTasks.tsx',
  ];

  it('every chat drawn outside SessionPanel is placed', () => {
    const found = files.filter((f) => /<SessionChatHistory\b/.test(fs.readFileSync(f, 'utf8')))
      .map(rel).filter((f) => f !== 'web/src/components/sessions/SessionPanel.tsx').sort();
    expect(found).toEqual(Object.keys(CHAT_HOSTS).sort());
    for (const [f, resolver] of Object.entries(CHAT_HOSTS)) if (resolver) expect(read(f), f).toContain(resolver);
  });

  it('every send by session id is the composer hook (which follows) or a one-shot sender', () => {
    // One RPC call site (the acceptance rule, api/session-send.ts); its callers are the senders.
    const rpc = files.filter((f) => /['"]session:send['"]/.test(fs.readFileSync(f, 'utf8'))).map(rel);
    expect(rpc).toEqual(['web/src/api/session-send.ts']);
    const found = files.filter((f) => /\bsendSessionMessage\(/.test(fs.readFileSync(f, 'utf8'))).map(rel)
      .filter((f) => f !== 'web/src/api/session-send.ts').sort();
    expect(found).toEqual([...ONE_SHOT_SENDERS, 'web/src/hooks/useSessionSend.ts'].sort());
    // That one call site also adds a test-run window's label to every send (ws.ts, the transport, no longer does).
    expect(read('web/src/api/session-send.ts')).toContain("wsClient.sendRpc<T>('session:send', withSendTestRun(body))");
  });

  it('the server never lets a replaced session take a message', () => {
    const queue = read('src/core/session-message-queue.ts');
    expect(queue).toContain('sessionId = await activeSessionFor(sessionId, opts?.messageId);');
  });
});
