/**
 * Ratchet: every surface that shows chat text names the tasks it mentions the
 * same way, as a pill with the task's current title (web/src/utils/bare-task-ids.ts,
 * web/src/stores/entity-label-store.ts resolveTaskToken).
 *
 * 2026-10-31, the user: "make all the task if it is reference in the chat output
 * all name so that user can click". The first fix (2026-09-29) reached the
 * renderers it knew; the user bubble of the Personal AI chat, its one-line
 * summaries and the Board's messages each had their own renderer and kept raw
 * ids. The class is "a place that turns text into HTML". This test lists every
 * such place in the web source (dangerouslySetInnerHTML, innerHTML writes,
 * direct marked / DOMPurify use) and fails on one it has not been told about:
 * a new one is either a chat surface, and then renders through the shared
 * pipeline, or is listed below with the reason it is not chat.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB = path.join(ROOT, 'web/src');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx?|js)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join('/');
const read = (r: string) => fs.readFileSync(path.join(ROOT, r), 'utf-8');

/** Writes HTML from text: the members of the class. */
const RENDERS_HTML = /dangerouslySetInnerHTML=|\.innerHTML\s*=|from 'marked'|from 'dompurify'/;
/** The shared pipeline: every call names tasks (renderMarkdownWithRefs, the tool result path,
 *  linkTaskMentions for a renderer of its own, ChatMessage's helpers built on it, the Board's
 *  message renderer). */
const PIPELINE = /\b(?:renderMarkdownWithRefs|useRenderedMarkdown|renderToolResultWithRefs|linkTaskMentions|renderUserMessage|renderInlineMarkdown|renderMarkdown|kit\.richText)\(|<RichMarkdown\b/;

/** Chat surfaces: each must render through the pipeline. */
const CHAT: Record<string, string> = {
  'web/src/components/chat/ChatMessage.tsx': 'the Personal AI chat: replies, the user bubble, one-line summaries, tool results',
  'web/src/components/chat/RichBlocks.tsx': 'rich (HTML) replies, block by block',
  'web/src/components/chat/SuggestCard.tsx': 'a suggestion card in a reply',
  'web/src/components/chat/SuggestSegments.tsx': 'suggestion segments in a reply',
  'web/src/components/common/ClaudeStreamView.tsx': 'a streamed Claude reply',
  'web/src/components/context/ContextInspectorPanel.tsx': 'the context inspector (data: ids keep their text, still linked)',
  'web/src/components/inbox/LetterBody.tsx': 'a letter in the inbox',
  'web/src/components/org/OrgBrief.tsx': 'the Brief of Main or a lead',
  'web/src/components/sessions/InjectedBannerRow.tsx': 'an injected banner in a session',
  'web/src/components/sessions/SessionMessage.tsx': 'the session timeline: the session columns, Ask here, the Org chat',
  'web/src/components/sessions/SessionOutboundCard.tsx': 'a message a session sent to another task',
  'web/src/components/sessions/SessionPanel.tsx': 'the session panel plan and summary text',
  'web/src/components/sessions/SessionProvenanceCard.tsx': 'a message another task sent into the session',
  'web/src/components/sessions/SideQuestionDrawer.tsx': 'a side question thread',
  'web/src/components/sessions/StreamingBlockView.tsx': 'a streaming block of a session reply',
  'web/src/components/sessions/WorkflowTranscriptModal.tsx': 'a workflow transcript',
  'web/src/components/triage/TriagePanel.tsx': 'the triage summary',
  'web/src/components/board/board-elements.frame.js': 'Board threads (kit.richText) and the Board text (linkBodyMentions)',
  'web/src/components/board/board-items.frame.js': 'Board choice answers (kit.richText)',
};

/** Not chat: what they render, and why task names do not belong there. */
const NOT_CHAT: Record<string, string> = {
  'web/src/utils/markdown.ts': 'the pipeline itself',
  'web/src/api/mail.ts': 'mail bodies from outside senders',
  'web/src/apps/mail/mail-sanitize.ts': 'the mail app sanitizer for outside senders',
  'web/src/components/board/board-runtime.frame.js': 'the Board frame core: fixed control markup only',
  'web/src/components/common/FileContentView.tsx': 'a file preview: files stay what is on disk (taskIds off)',
  'web/src/components/common/LinkifiedText.tsx': 'mentions this API in a comment only; renders React nodes',
  'web/src/components/common/OfficePreview.tsx': 'an office document preview',
  'web/src/components/notes/CommandPalette.tsx': 'search snippet highlighting',
  'web/src/components/notes/notes-markdown.ts': 'the notes editor (its own Marked instance; notes are documents)',
  'web/src/components/sessions/SessionDiffView.tsx': 'a file diff: code stays raw',
  'web/src/components/sessions/diffMarkdownBlocks.ts': 'a markdown file diff (taskIds off)',
  'web/src/components/tasks/AgentSearchPanel.tsx': 'mentions the API in a comment only',
  'web/src/components/tasks/AgentSearchResultRows.tsx': 'mentions the API in a comment only',
  'web/src/components/tasks/ProjectTrackingView.tsx': 'a plugin-provided sanitized tracking page',
  'web/src/components/tasks/TaskDetailPane.tsx': 'a task note and description (documents, the notes renderer)',
  'web/src/hooks/useStableHtml.ts': 'the stable {__html} helper',
  'web/src/utils/pin-highlights.ts': 'highlight marks over rendered text',
  'web/src/utils/selection-guard.ts': 'selection bookkeeping',
  'web/src/utils/url-display.ts': 'URL label helpers',
};

const members = walk(WEB).map(rel).filter((r) => RENDERS_HTML.test(read(r)));

describe('every place that renders text as HTML is classified', () => {
  it('no new member of the class goes unlisted', () => {
    const unlisted = members.filter((r) => !(r in CHAT) && !(r in NOT_CHAT));
    expect(unlisted, 'a new HTML-rendering file: list it in CHAT (and render through the pipeline) or NOT_CHAT with a reason').toEqual([]);
  });

  it('the lists name only files that still exist and still render', () => {
    const stale = [...Object.keys(CHAT), ...Object.keys(NOT_CHAT)].filter((r) => !members.includes(r)
      && !(fs.existsSync(path.join(ROOT, r)) && /dangerouslySetInnerHTML|innerHTML/.test(read(r))));
    expect(stale).toEqual([]);
  });

  it('every chat surface renders through the task-naming pipeline', () => {
    const off = Object.keys(CHAT).filter((r) => !PIPELINE.test(read(r)));
    expect(off).toEqual([]);
  });

  it('a renderer of its own runs linkTaskMentions on what marked made', () => {
    const src = read('web/src/components/chat/ChatMessage.tsx');
    const parses = src.split('\n').filter((l) => /marked\.parse(?:Inline)?\(/.test(l)).length;
    const linked = (src.match(/DOMPurify\.sanitize\(linkTaskMentions\(raw\)/g) ?? []).length;
    expect(parses).toBeGreaterThan(0);
    expect(linked).toBe(parses);
    // The user bubble's verbatim renderer (moved to markdown.ts so the markdown tier runs it).
    expect(read('web/src/utils/markdown.ts')).toMatch(/const withBreaks = linkTaskMentions\(/);
  });
});

describe('chat surfaces show names, not ids', () => {
  /** Calls that turn task naming down: allowed only on data and file surfaces. */
  const NON_PILL_CALLS: Record<string, string> = {
    'web/src/components/common/FileContentView.tsx': 'file preview',
    'web/src/components/sessions/diffMarkdownBlocks.ts': 'file diff',
    'web/src/components/sessions/SessionMessage.tsx': 'tool input/results and injected context (DATA_RENDER)',
    'web/src/components/context/ContextInspectorPanel.tsx': 'the context inspector',
    'web/src/utils/markdown.ts': 'extractMarkdownFields and the tool result path',
  };
  it('only data and file surfaces render ids as links or not at all', () => {
    const hits = walk(WEB).map(rel).filter((r) => {
      const s = read(r);
      return /(?:renderMarkdownWithRefs|useRenderedMarkdown|linkTaskMentions)\([^;]*(?:taskIds:\s*'(?:off|links)'|FILE_RENDER|DATA_RENDER|'links'\))/.test(s);
    });
    expect(hits.filter((r) => !(r in NON_PILL_CALLS))).toEqual([]);
  });
});

describe('the Board names tasks in its messages and its text', () => {
  const md = read('web/src/components/board/board-markdown.frame.js');
  const el = read('web/src/components/board/board-elements.frame.js');
  const sections = read('web/src/components/board/board-sections.frame.js');
  it('the message renderer uses the same token shapes as the web renderer', () => {
    const shape = read('web/src/utils/task-id-shape.ts');
    const webAlts = /\(\?:(\[0-9a-f\]\{8\}[^']*)\)'/.exec(shape)?.[1];
    expect(webAlts).toBeTruthy();
    expect(md).toContain(`'((?:${webAlts}))'`);
  });
  it('the text pass runs as a watcher, and a chip counts as the id in the "updated" hash', () => {
    expect(el).toMatch(/kit\.watchers\.push\(linkBodyMentions\)/);
    expect(sections).toMatch(/hasAttribute\('data-wn-text'\)/);
  });
});

describe('a title written beside a mention is absorbed by every renderer that makes pills', () => {
  // 2026-10-31, the lead: "the pill should absorb the written title so it shows once".
  // One rule (web/src/utils/task-title-absorb.ts), mirrored by the Board frame and the
  // phone; all three read tests/fixtures/task-title-absorb.json.
  const md = read('web/src/utils/markdown.ts');
  const core = read('web/src/utils/task-title-absorb.ts');
  const frame = read('web/src/components/board/board-markdown.frame.js');

  it('every web renderer that makes pills drops the written title first', () => {
    const body = /export function renderMarkdownWithRefs\([\s\S]*?\n}\n/.exec(md)?.[0] ?? '';
    expect(body).toMatch(/if \(taskIds === 'pills'\) preprocessed = absorbWrittenTaskTitles\(/);
    // A renderer of its own: every marked parse that links task pills absorbs first.
    for (const r of Object.keys(CHAT)) {
      const src = read(r);
      if (!/linkTaskMentions\(raw\)/.test(src)) continue;
      const parses = (src.match(/marked\.parse(?:Inline)?\(/g) ?? []).length;
      const absorbed = (src.match(/entityRefsToHtml\(absorbWrittenTaskTitles\(text\)\)/g) ?? []).length;
      expect(absorbed, r).toBe(parses);
    }
  });

  it('the Board frame mirrors the rule and runs it before its inline passes', () => {
    expect(frame).toMatch(/var s = absorbTaskTitles\(raw\)\.replace\(CODE_RE/);
    const lits = (src: string, decl: string) => (new RegExp(`${decl} = \\[([\\s\\S]*?)\\];`).exec(src)?.[1] ?? '').split('\n').map((l) => l.trim().replace(/,$/, '')).filter(Boolean);
    expect(lits(md, 'const NOT_PILL_RES')).toHaveLength(3);
    expect(lits(frame, 'var NOT_CHIP_RES')).toEqual(lits(md, 'const NOT_PILL_RES'));
    for (const name of ['ELLIPSIS_END_RE', 'PAREN_BEFORE_RE', 'CLOSE_AFTER_RE', 'LIST_SEP_AFTER_RE', 'DASH_BEFORE_RE', 'DASH_AFTER_RE', 'PAREN_AFTER_RE', 'SPACE_AFTER_RE']) {
      const ts = new RegExp(`const ${name} = (/.*/);`).exec(core)?.[1];
      const js = new RegExp(`var ${name} = (/.*/);`).exec(frame)?.[1];
      expect(ts, name).toBeTruthy();
      expect(js, name).toBe(ts);
    }
  });

  it('the phone runs it inside rewriteRefs, which every place that links mentions calls', () => {
    const mentions = read('ios-native/Walnut/Markdown/TaskMentions.swift');
    expect(mentions).toMatch(/static func rewriteRefs\([^)]*\) -> String \{\n\s+var out = TaskTitleAbsorb\.absorbWrittenTitles\(text, resolver: resolver\)/);
    const swift = (function walkSwift(dir: string, out: string[] = []): string[] {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walkSwift(p, out); else if (e.name.endsWith('.swift')) out.push(p);
      }
      return out;
    })(path.join(ROOT, 'ios-native/Walnut')).map(rel);
    const linking = swift.filter((r) => /TaskMentions\.apply\(/.test(read(r)));
    expect(linking.length).toBeGreaterThan(0);
    expect(linking.filter((r) => !/TaskMentions\.rewriteRefs\(/.test(read(r)))).toEqual([]);
  });

  it('all three test suites read the shared cases', () => {
    for (const r of ['tests/web/markdown/task-title-absorb.test.ts', 'tests/web/board-markdown.test.ts', 'ios-native/WalnutTests/TaskTitleAbsorbTests.swift']) {
      expect(read(r), r).toContain('fixtures/task-title-absorb.json');
    }
  });
});
