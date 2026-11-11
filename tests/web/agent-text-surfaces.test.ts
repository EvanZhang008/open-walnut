import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readSources, rendererUses, type RendererUse } from './agent-guard-ast';
import { plainAgentFields, scanAgentText } from './agent-text-scan';

const root = path.resolve('web/src');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

/** Files whose plain agent-field hits are not agent words, each with why (stale ones fail). */
const plainAllowed: Record<string, string> = {
  'components/chat/MentionPalette.tsx': 'selection-menu result labels are not an interactive document',
  'components/settings/sections/MailRulesList.tsx': 'saved rule names inside a selection list',
  'apps/mail/MailCorrectStepRule.tsx': 'saved rule option labels inside a selection list',
  'components/tasks/TaskKebabMenu.tsx': 'the snooze row names its watch inside a menu button, where a link cannot sit',
  'components/hosts/HostFailureText.tsx': "a host problem's summary is the SSH output Walnut captured, shown in a pre",
  'components/settings/SettingsSection.tsx': "a settings row's help is Walnut's own copy (Bitwarden's last sync result), not agent words",
  'components/sessions/SessionSpeedReadout.tsx': "the model a switch takes over with is a model name Walnut reads, not agent words",
  'components/tasks/StartQueueLine.tsx': "why a start did not happen is Walnut's own sentence from the server's status (core/user-status.ts), not agent words",
  'components/sessions/MessageCard.tsx': "a message card's summary (sent or received) is a clipped two-line preview inside the card's own Details button (no link may sit in a button); the whole text opens below it through AgentText",
  'components/workspaces/StopFirstDialog.tsx': "the script asked for is a script name from the project's walnut.json, not agent words",
};

/** Whether `file` hands agent words to the shared renderer the way `pred` says (other props free). */
const renders = (file: string, pred: (u: RendererUse) => boolean) => rendererUses(read(file)).some(pred);
const textIs = (text: string, more: Record<string, string | true> = {}) => (u: RendererUse) =>
  u.attrs.text === text && Object.entries(more).every(([k, v]) => u.attrs[k] === v);

describe('agent text cannot silently become plain JSX on a new surface', () => {
  it('enumerates direct agent-body fields from the source, not only existing renderer calls', () => {
    const found = [...scanAgentText(readSources(root), root)]
      .map(([file, hits]) => ({ file: path.relative(root, file).split(path.sep).join('/'), fields: hits }))
      .filter((r) => r.fields.length);
    const off = found.filter((r) => !plainAllowed[r.file]);
    expect(off, 'render agent reply, preview and last words with AgentText or the shared rich renderer').toEqual([]);
    const stale = Object.keys(plainAllowed).filter((f) => !found.some((r) => r.file === f));
    expect(stale, 'allowed files that no longer render a plain agent field: drop them from plainAllowed').toEqual([]);
  });

  it('agent words handed to another component as a prop are followed into it, in any file', () => {
    const scan = (files: Record<string, string>) => {
      const out = scanAgentText(Object.fromEntries(Object.entries(files).map(([f, t]) => [`/v/${f}`, t])), '/v');
      return Object.fromEntries([...out].filter(([, h]) => h.length).map(([f, h]) => [f.slice(3), h]));
    };
    const card = 'export function NewCard({ summary }) { return <div>{summary}</div>; }';
    expect(scan({ 'Parent.tsx': "import { NewCard } from './NewCard';\nexport const Parent = () => <NewCard summary={task.summary} />;", 'NewCard.tsx': card }))
      .toEqual({ 'NewCard.tsx': ['props.summary (from Parent.tsx: task.summary)'] });
    // props.<name>, a renamed prop, an aliased import through a barrel, and a default export.
    expect(scan({
      'Parent.tsx': "import { Shown as S } from './index';\nimport Quote from './Quote';\nexport const Parent = () => <><S words={thread.reply} /><Quote said={t.user_status?.now} /></>;",
      'index.ts': "export { Card as Shown } from './Card';",
      'Card.tsx': 'export const Card = memo((props) => <p>{props.words}</p>);',
      'Quote.tsx': 'export default function Quote({ said: line }) { return <span>{line.trim()}</span>; }',
    })).toEqual({ 'Card.tsx': ['props.words (from Parent.tsx: thread.reply)'], 'Quote.tsx': ['props.said (from Parent.tsx: t.user_status.now)'] });
    // Several layers, and a local component of the same file.
    expect(scan({
      'Parent.tsx': "import { Outer } from './Outer';\nexport const Parent = () => <Outer body={letter.textPreview} />;",
      'Outer.tsx': "import { Inner } from './Inner';\nconst Mid = ({ text }) => <Inner line={text} />;\nexport const Outer = ({ body }) => <Mid text={body} />;",
      'Inner.tsx': 'export function Inner(props) { const { line } = props; return <em>{`said: ${line}`}</em>; }',
    })).toEqual({ 'Inner.tsx': ['props.line (from Parent.tsx: letter.textPreview)'] });
  });

  it('discovers a new frame text sink and follows folded prose through aliases and escaping', () => {
    const scan = (source: string) => [...scanAgentText({ '/v/new.frame.js': source }, '/v').values()].flat();
    expect(scan('const words = choice.summary; kit.setHtml(row, esc(words.slice(0, 140)));')).toEqual(['choice.summary']);
    expect(scan("const summary = el.getAttribute('summary'); row.innerHTML = '<span>' + esc(summary) + '</span>';"))
      .toEqual(['summary attribute']);
    expect(scan('const reply = task.last_words; row.textContent = reply.text;')).toEqual(['reply.text']);
    expect(scan('const words = message.text; kit.setHtml(row, esc(words));')).toEqual(['message.text']);
    expect(scan('const words = choice.summary; kit.setHtml(row, kit.richText(words));')).toEqual([]);
  });

  it('a prop chain is safe once it reaches the shared renderer, and props that carry no agent words stay clean', () => {
    const scan = (files: Record<string, string>) => {
      const out = scanAgentText(Object.fromEntries(Object.entries(files).map(([f, t]) => [`/v/${f}`, t])), '/v');
      return [...out].filter(([, h]) => h.length).map(([f, h]) => `${f.slice(3)}: ${h.join(', ')}`);
    };
    const agentText = 'export function AgentText({ text }) { return <div dangerouslySetInnerHTML={{ __html: text }} />; }';
    // Handed on to AgentText (renamed on import too) and to a component that renders through it.
    expect(scan({
      'AgentText.tsx': agentText,
      'Parent.tsx': "import { Linked } from './Linked';\nimport { AgentText as AT } from './AgentText';\nexport const Parent = () => <><Linked words={thread.reply} /><AT text={task.summary} /></>;",
      'Linked.tsx': "import { AgentText } from './AgentText';\nexport const Linked = ({ words }) => <AgentText compact text={words} />;",
    })).toEqual([]);
    // Same-named components in two files: only the imported one is tainted.
    expect(scan({
      'Parent.tsx': "import { Card } from './a/Card';\nexport const Parent = () => <Card summary={task.summary} />;",
      'a/Card.tsx': "import { AgentText } from '../AgentText';\nexport const Card = ({ summary }) => <AgentText text={summary} />;",
      'b/Card.tsx': 'export const Card = ({ summary }) => <div>{summary}</div>;',
      'AgentText.tsx': agentText,
    })).toEqual([]);
    // A count, a label, a DOM attribute, the user's own draft and a settings label are not agent words.
    expect(scan({
      'Parent.tsx': "import { Row } from './Row';\nexport const Parent = () => <><Row summary={rule.label} /><Row count={thread.reply.length} /><Row draft={draft.text} /><div title={thread.reply} /></>;",
      'Row.tsx': 'export const Row = ({ summary, count, draft }) => <p>{summary}{count}{draft}</p>;',
    })).toEqual([]);
  });

  it('a newly added plain agent-text component fails discovery before it has a renderer', () => {
    expect(plainAgentFields('NewCard.tsx', 'const Card = () => <div>{thread.reply}</div>')).toEqual(['thread.reply']);
    expect(plainAgentFields('NewCard.tsx', "const Card = () => <>{thread.reply ?? ''}</>")).toEqual(['thread.reply']);
    expect(plainAgentFields('NewCard.tsx', 'const Card = () => <div>{vm.summary.text}</div>')).toEqual(['vm.summary']);
    expect(plainAgentFields('NewCard.tsx', 'const summary = thread.reply; const Card = () => <div>{summary}</div>')).toEqual(['thread.reply']);
    expect(plainAgentFields('NewCard.tsx', 'const Card = () => <div>{truncText(task.summary, 100)}</div>')).toEqual(['task.summary']);
    expect(plainAgentFields('NewCard.tsx', 'const Card = () => <AgentText text={thread.reply} />')).toEqual([]);
    // A task's conversation log is many sessions' words; a plain description or note stays a user field.
    expect(plainAgentFields('NewCard.tsx', 'const Card = () => <div>{truncLog(ctx.conversation_log)}</div>')).toEqual(['ctx.conversation_log']);
    expect(plainAgentFields('NewCard.tsx', 'const Card = () => <div>{draft.description}{draft.note}</div>')).toEqual([]);
  });

  it('follows template expressions, map callbacks, destructured names and helper chains', () => {
    const scan = (code: string) => plainAgentFields('NewCard.tsx', code);
    expect(scan('const Card = () => <div>{`Waiting on ${task.user_status.waitingOn}`}</div>')).toEqual(['task.user_status.waitingOn']);
    expect(scan('const Card = () => <p>{status.ask}</p>')).toEqual(['status.ask']);
    expect(scan('const Card = () => <p>{task.user_status?.now?.trim()}</p>')).toEqual(['task.user_status.now']);
    // Needs you's line: the helper's `.text` is the agent's words, its `.label` is Walnut's.
    expect(scan('const need = done ? null : needsLine(task); const Card = () => <span>{need.text}</span>')).toEqual(['needsLine()']);
    expect(scan("const need = needsLine(task); const r = key === 'waiting' ? waitingReason(task) : need ? [need.label, need.text].filter(Boolean).join(': ') : ''; const Card = () => <span>{r}</span>"))
      .toEqual(['needsLine()', 'waitingReason()']);
    // A map callback's item goes back to its array, spreads and all.
    expect(scan('const said = last ? [...askedOf(task, line), last] : []; const Card = () => <div>{said.map((s) => <p>{s}</p>)}</div>')).toEqual(['askedOf()']);
    expect(scan('const Card = () => <ul>{threads.map(({ reply }) => <li>{reply}</li>)}</ul>')).toEqual(['reply']);
    expect(scan('const { answer: words } = thread; const Card = () => <p>{words}</p>')).toEqual(['answer']);
    expect(scan('const { text } = needsLine(task); const Card = () => <p>{text}</p>')).toEqual(['needsLine()']);
    // A helper of this file: its return, and what it pushed into the array it returns.
    expect(scan('function detail(t) { const lines = []; const on = t.user_status?.waitingOn?.trim(); if (on) lines.push(`Waiting on ${on}.`); lines.push("A message here moves it to Working."); return lines; }\n'
      + 'const Card = () => { const lines = detail(task); return <div>{lines.map((l, i) => <div key={i}>{l}</div>)}</div>; }')).toEqual(['t.user_status.waitingOn']);
    expect(scan('const lastReply = useLastReply(id, status); const Card = () => <div>{lastReply === null ? "Loading" : lastReply ? lastReply : "No reply yet."}</div>')).toEqual(['useLastReply()']);
    expect(scan('const Card = () => <div>{stripMarkdown(thread.reply)}</div>')).toEqual(['thread.reply']);
  });

  it('never takes labels, titles, counts or the user\'s own input for agent words', () => {
    const scan = (code: string) => plainAgentFields('NewCard.tsx', code);
    expect(scan('const need = needsLine(task); const Card = () => <span>{need.label}{need.text ? ":" : ""}</span>')).toEqual([]);
    expect(scan('const Card = () => <p>{draft.text}</p>')).toEqual([]);
    expect(scan("const [text, setText] = useState(''); const Card = () => <p>{text}</p>")).toEqual([]);
    expect(scan('const Card = ({ messages }) => <div>{messages.map((m) => <p>{m.text}</p>)}</div>')).toEqual([]);
    expect(scan('const Card = () => <p>{task.title}</p>')).toEqual([]);
    expect(scan('const Card = () => <p>{`${row.label} · ${count}`}</p>')).toEqual([]);
    expect(scan('const Card = () => <p>{thread.reply.length}</p>')).toEqual([]);
    expect(scan("const labels = ['Focus', 'Needs you']; const Card = () => <ul>{labels.map((l) => <li>{l}</li>)}</ul>")).toEqual([]);
    expect(scan('function Fold({ summary }: { summary: ReactNode }) { return <summary>{summary}</summary>; }')).toEqual([]);
    // Agent words handed to the renderer, or in an attribute, are not plain children.
    expect(scan('const said = askedOf(task, line); const Card = () => <div>{said.map((s) => <AgentText text={s} />)}</div>')).toEqual([]);
    expect(scan('const Card = () => <span title={thread.reply}>{thread.title}</span>')).toEqual([]);
  });

  it('the Needs you and Waiting lines, the wait card, the extension panel and the taskbar card render agent words linked', () => {
    for (const file of ['components/tasks/StatusSections.tsx', 'components/tasks/WaitingChip.tsx', 'popout/PopoutExtTasks.tsx', 'components/sessions/SessionTaskbar.tsx']) {
      expect(plainAgentFields(path.join(root, file)), file).toEqual([]);
    }
    // Checked on the AST: any other prop (a task, a host, a cwd for its paths) may sit beside these.
    expect(renders('components/tasks/StatusSections.tsx', textIs('need.text', { className: 'needs-line-text', compact: true, inline: true }))).toBe(true);
    expect(renders('components/tasks/StatusSections.tsx', (u) => u.attrs.text === 'reasonText' && u.attrs.testId === 'status-card-reason'
      && String(u.attrs.className).startsWith('`status-card-reason') && u.attrs.inline === true)).toBe(true);
    expect(renders('components/tasks/WaitingChip.tsx', textIs('l', { className: 'task-waiting-card-line', compact: true }))).toBe(true);
    expect(read('components/tasks/WaitingChip.tsx')).toMatch(/lines\.map\(\(l, i\) => <AgentText\b/);
    const popout = read('popout/PopoutExtTasks.tsx');
    // No <p> around the renderer's block, a task opens in a new tab, and the message is never cut.
    expect(renders('popout/PopoutExtTasks.tsx', textIs('s', { onTaskClick: 'openTask', compact: true }))).toBe(true);
    expect(popout).toMatch(/said\.map\(\(s, i\) => <AgentText\b/);
    expect(popout).not.toMatch(/<p[^>]*>\{s\}<\/p>/);
    expect(popout).not.toContain('LAST_MESSAGE_MAX');
    expect(renders('components/triage/TriagePanel.tsx', (u) => /^summary\b/.test(String(u.attrs.text)))).toBe(true);
    expect(read('components/triage/TriagePanel.tsx')).not.toContain('summary.slice(0,');
    expect(renders('apps/mail/MailGroupLine.tsx', textIs('summary', { compact: true, inline: true }))).toBe(true);
    expect(popout.slice(popout.indexOf('function useLastMessage'), popout.indexOf('function TaskReply'))).not.toMatch(/\.slice\(|replace\(\/\\s\+\/g/);
    const taskbar = read('components/sessions/SessionTaskbar.tsx');
    expect(renders('components/sessions/SessionTaskbar.tsx', textIs('line', { compact: true, inline: true }))).toBe(true);
    expect(renders('components/sessions/SessionTaskbar.tsx', textIs('lastReply', { compact: true, inline: true }))).toBe(true);
    // The reply reaches the renderer as written: stripping Markdown first rewrote paths.
    expect(taskbar).not.toContain('stripMarkdown');
    // The portalled card is still the draggable chip's React child: a dragged link is no chip move.
    expect(taskbar).toMatch(/onDragStart=\{\(e\) => \{ if \(chipRef\.current\?\.contains\(e\.target as Node\)\) onDragStart\(e\); \}\}/);
    // The rows keep their one line: AgentText's own rule wraps, these do not.
    expect(fs.readFileSync(path.join(root, 'styles/status-sections.css'), 'utf8'))
      .toContain('.status-card-reason[data-agent-text], .status-card-needs-line .needs-line-text[data-agent-text] { white-space: nowrap; overflow-wrap: normal; }');
    const taskbarCss = fs.readFileSync(path.join(root, 'styles/session-taskbar.css'), 'utf8');
    expect(taskbarCss).toMatch(/\.session-taskbar-card-reply \{[^}]*-webkit-line-clamp: 4;/);
    expect(taskbarCss).toMatch(/\.session-taskbar-card-reply \{[^}]*flex-shrink: 0;/);
    expect(fs.readFileSync(path.join(root, 'apps/mail/mail-groups.css'), 'utf8')).toMatch(/\.mail-group-summary \{[^}]*user-select: text;/);
    expect(read('apps/mail/MailGroupLine.tsx')).toMatch(/import \{[^}]*\bselectingInside\b[^}]*\} from '\.\/MailMessageRow'/);
    expect(read('apps/mail/MailGroupLine.tsx')).toContain('if (event.detail > 0 && fromSummary && summary && selectingInside(summary)) return;');
  });

  it('a new AgentText with no writer is unknown by default, never an implicit primary', () => {
    expect(read('components/common/AgentText.tsx')).toContain('unknownSource: unknownSource ?? (!task && host === undefined && !sessionId)');
  });

  it('side answers use their saved session, while untracked subagents and mixed context have no guessed source', () => {
    expect(renders('components/sessions/SideQuestionDrawer.tsx', textIs("q.answer ?? ''", { sessionId: 'q.sessionId', unknownSource: '!q.sessionId' }))).toBe(true);
    expect(renders('components/common/ClaudeStreamView.tsx', textIs('displayContent', { unknownSource: true }))).toBe(true);
    expect(renders('components/chat/SubagentBlock.tsx', textIs('block.result', { unknownSource: true }))).toBe(true);
    expect(renders('components/context/ContextInspectorPanel.tsx', textIs('text', { unknownSource: true, taskIds: 'links' }))).toBe(true);
    expect(read('components/common/ClaudeStreamView.tsx')).toContain('onFileOpen={file.onFileOpen}');
    for (const file of ['components/common/ClaudeStreamView.tsx', 'components/context/ContextInspectorPanel.tsx', 'components/sessions/SideQuestionDrawer.tsx']) {
      expect(read(file), file).not.toContain('dangerouslySetInnerHTML');
    }
  });

  it('existing derived prose slots cannot regress to plain text', () => {
    const slots: Record<string, string[]> = {
      'components/org/OrgTaskRail.tsx': ['summary', 'more', 'note'],
      'components/chat/ChatMessage.tsx': ['ctx.summary', 'ctx.description', 'ctx.note', "ctx.conversation_log ?? ''"],
      'components/sessions/LatestUpdatePopover.tsx': ['overview', 'recap'],
      'components/sessions/SessionRecapTip.tsx': ['recap'],
      'components/board/BoardStatusView.tsx': ['s.now', 's.next', 'line.text'],
      'components/board/kanban/KanbanCard.tsx': ['vm.summary.text'],
      'components/board/kanban/KanbanCardDetail.tsx': ['card.summary.text'],
    };
    for (const [file, expressions] of Object.entries(slots)) {
      const source = read(file);
      for (const expression of expressions) {
        expect(renders(file, textIs(expression)), `${file}: ${expression}`).toBe(true);
        expect(source, `${file}: ${expression}`).not.toContain(`>{${expression}}<`);
      }
    }
  });

  it('reported summaries, agent letter turns and previews use the shared renderer', () => {
    // The node's summary and Walnut's stand-in line (cut from an answer or a post) both go through it.
    expect(rendererUses(read('components/org/OrgThreads.tsx')).filter((u) => u.attrs.text === 'card.summary.text').length).toBeGreaterThanOrEqual(2);
    expect(renders('components/inbox/LetterEnvelopeRow.tsx', textIs('letter.textPreview'))).toBe(true);
    const thread = read('components/inbox/LetterThread.tsx');
    expect(thread).toContain("const person = entry.from === 'human' && !by;");
    expect(rendererUses(thread).some((u) => u.attrs.text === 'entry.text')).toBe(true);
    expect(read('components/board/TaskBoardPane.tsx')).toMatch(/out\[text\] = renderMarkdownWithRefs\(/);
    expect(read('components/board/board-markdown.frame.js')).toContain('return rendered[raw]');
    const runtime = read('components/board/board-runtime.frame.js');
    expect(runtime).toContain('state.renderedText = obj(d.renderedText)');
    expect(runtime).toMatch(/function setFold\(id, open\) \{[\s\S]{0,220}send\(\{ t: 'wn-board:view', view: captureView\(\) \}\)/);
    const board = read('components/board/TaskBoardPane.tsx');
    const folded = read('components/board/board-items.frame.js');
    expect(folded).toContain('kit.richText(summary)');
    expect(folded).toContain('kit.richText(words)');
    expect(folded).not.toContain('said.slice(');
    expect(folded).not.toContain('esc(summary)');
    expect(read('components/board/board-runtime.css.ts')).toMatch(/\.wn-fold-sum \{[^}]*overflow-x: auto;/);
    expect(read('components/board/board-runtime.css.ts')).toMatch(/\.wn-fold-sum \{[^}]*padding-bottom: 12px;/);
    expect(board).toContain('for (const summary of summaryTexts) add(summary.text);');
    expect(board).toContain('boardSummaryRange(summary, offset, offset + req.path.length)');
    expect(board).toContain('boardReferenceSources(ownerId, board, range.start, range.end)');
    expect(board).not.toContain('boardReferenceSources(ownerId, board, summary.start, summary.end)');
    expect(board).toMatch(/t: 'wn-board:sending'[^\n]*rendered: renderMarkdownWithRefs\(text/);
    expect(board).toMatch(/t: 'wn-board:sent'[^\n]*rendered: renderMarkdownWithRefs\(res\.message\.text/);
    expect(read('components/board/TaskBoardPane.tsx')).toContain('linkAgentHtml(html');
    expect(read('components/inbox/LetterBody.tsx')).toContain('linkAgentHtml(plan.head + body.slice(plan.consumed) + plan.tail');
    const chat = read('components/chat/ChatMessage.tsx');
    expect(chat.slice(chat.indexOf('const collapsedSummary ='), chat.indexOf('// Notification header'))).not.toContain('.slice(0,');
  });
});
