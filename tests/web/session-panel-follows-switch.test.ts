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
    expect(sw).toMatch(/switchTaskEngine\(taskId, p\)/);
    const api = read('web/src/api/engine-switch.ts');
    expect(api).toContain("when: 'now', detach: true");
  });

  it('a panel opened on a replaced session follows, unless opened on purpose from the earlier sessions', () => {
    const sw = read('web/src/components/sessions/EngineSwitch.tsx');
    expect(sw).toContain("session?.archive_reason?.startsWith('engine_switched:')");
    expect(sw).toContain('openedOnPurpose.has(sessionId)');
    const earlier = read('web/src/components/sessions/TaskEarlierSessions.tsx');
    expect(earlier).toContain('markOpenedOnPurpose(row.session_id); onOpen(row.session_id);');
  });

  it('a send the server delivered elsewhere reports it, and every panel send path follows it', () => {
    expect(read('src/web/routes/session-chat.ts')).toContain('...(msg.sessionId && msg.sessionId !== data.sessionId ? { deliveredTo: msg.sessionId } : {}),');
    const hook = read('web/src/hooks/useSessionSend.ts');
    const rpcs = hook.match(/sendRpc<[^>]*>\(\s*'session:send'/g) ?? [];
    expect(rpcs.length).toBeGreaterThanOrEqual(3);
    for (const r of rpcs) expect(r, 'every session:send answer reads deliveredTo').toContain('deliveredTo');
    expect(hook.match(/followRedirect\(res, /g)?.length).toBe(rpcs.length);
    expect(panel).toContain('if (redirectedTo && redirectedTo !== sessionId) onSessionReplaced?.(sessionId, redirectedTo);');
  });
});
