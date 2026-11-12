import { Fragment, useState, useCallback, useContext, useLayoutEffect, useMemo, useRef, memo, type ReactNode } from 'react';
import { holdImageBoxesIn } from '@/utils/image-size-hold';
import type { SessionHistoryMessage, SessionHistoryTool } from '@/types/session';
import type { StreamingBlock } from '@/stream/stream-reducer';
import {
  renderMarkdownWithRefs, extractMarkdownFields, injectJsonIdLinks,
  extractContentBlockImages, findImagePaths, isImageFilePath, resolveImagePath,
} from '@/utils/markdown';
import { useEntityClickHandler } from '@/hooks/useEntityClickHandler';
import { useAgentFileOpener, useSessionTextRender } from '@/hooks/useAgentFileOpener';
import { AgentText } from '@/components/common/AgentText';
import { localImageSrc, sessionTextSource } from '@/utils/agent-text-source';
import { peekSessionRecord } from '@/api/sessions';
import { useEntityLabelsVersion } from '@/hooks/useEntityLabels';
import { useStableHtml, stableHtml } from '@/hooks/useStableHtml';
import { useLivePlanContent } from '@/contexts/PlanContentContext';
import { BackgroundTasksChip, type KnownAgent } from './BackgroundTasksPanel';
import { agentResultText } from './background-ledger';
import { MessageMetaRow, UUID_RE } from './MessageMetaRow';
import { UserRowAttachmentsContext } from './user-row-attachments';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu';
import { useSessionPinsApi } from '@/contexts/SessionPinsContext';
import { useSessionRewindApi } from '@/contexts/SessionRewindContext';
import { useSessionReader } from './reader-split';
import { pinLabelFor } from '@/hooks/useSessionPins';
import { copyRichText, copyTextRobust } from '@/utils/clipboard';
import { markdownToRichHtml } from '@/utils/markdown';
import { SuggestSegments, useSuggestSegments } from '@/components/chat/SuggestSegments';
import { RichMarkdown } from '@/components/chat/RichBlocks';
import { disclosureIds, useRowDisclosure } from './row-disclosure';
import { StepIcon, toolDisplayName, toolStepIcon } from './StepIcon';
import { RunLive, useInFoldBody, useRunLive } from './fold-body-context';

/** The most calls a run lays out as rows of an opened fold (ToolRunShell `flat`). */
const FLAT_RUN_MAX = 40;
import { toolTarget } from './step-target';
import '@/styles/step-rows.css';
import { toolMergesIntoRun } from '@/stream/tool-merge';
import { useSelectionFrozenWith } from '@/utils/selection-guard';
import { BashToolCall } from './BashToolCall';
import { parseSessionEnvelopes, type EnvelopeSegment } from '@open-walnut/history-session-envelope';
import { injectedContextKind } from './injected-context';
import { detectOutboundCalls } from './session-outbound';
import { detectOutboundSend, walnutToolView } from './session-outbound';
import { SessionEnvelopeSegments } from './SessionProvenanceCard';
import { SessionOutboundCards } from './SessionOutboundCard';
import { splitLeadingBanners } from '@open-walnut/history-injected-banner';
import { attachmentParts } from '@/api/file-upload';
import { MessageAttachments } from './MessageAttachments';
import { injectedContextLabel } from '@open-walnut/walnut-added';
import { splitRiders } from '@open-walnut/history-walnut-riders';
import '@/styles/session-riders.css';
import { ProcessFoldRow } from './TurnFolds';
import { CLI_ERROR_VARIANT, envelopeSteps, foldStepsPhrase, systemRowVariant, systemRunLabel, systemRunShows } from './fold-steps';
import { IdleCompactLine } from './IdleCompactLine';
import { isIdleCompactLine } from '../../../../src/core/sessions/prompt-cache';
import { QUESTION_BANNER_RE, stripQuestionTag } from '@/utils/question-tag';
import { useShowWalnutAdditions } from '@/hooks/useShowWalnutAdditions';
import { showHintTagsAsTyped } from '@/utils/hint-display';
import { stripTurnMarker } from '@/utils/turn-end-marker';
import { MessageAbout, MessageAboutContext, rowAbout } from './message-about';
import { shortenFileAboutLine } from '@/utils/thread-tree';
import { InjectedBannerRow } from './InjectedBannerRow';
import { searchPromptBannerSplit } from './search-ask';
import { SearchAnswerCard } from './SearchAnswerCard';
import { isRoutedQuestion, isUserDenied, runSegments, toolRunPhrase, type RunCall } from './tool-run-phrase';
import { AnswerText } from './RuleDetail';
import { answeredCallState, callAnswerText, callDecisionLabel, runAnswerLines, SoleCallContext, useSoleCall, useDeniedNow, useToolDecisions, useWaitingTools } from './waiting-tools';
import { toolCallsLabel } from './tool-call-grouping';
import { splitSearchAnswerMessage } from '@open-walnut/search-transcript';
import { log } from '@/utils/log';
import { usePhoneLayout } from '@/hooks/usePhoneLayout';
import { KebabVerticalIcon } from '@/components/common/PhoneIcons';
import { computeLineDiff, editDiffIsLarge, toolCardKind, toolDescription, toolInputSummary } from '@open-walnut/tool-header-text';

// ── Edit Diff View ──

interface EditDiffViewProps {
  filePath: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
  status: 'calling' | 'done' | 'error';
  result?: string;
  onViewFile?: (path: string) => void;
  /** The edit's tool call, so the card keeps its state when its row is drawn again. */
  toolUseId?: string;
}

function EditDiffView({ filePath, oldString, newString, replaceAll, status, result, onViewFile, toolUseId }: EditDiffViewProps) {
  const runLive = useRunLive();
  const [collapsed, setCollapsed] = useRowDisclosure(disclosureIds.diff(toolUseId), false);
  const totalLines = oldString.split('\n').length + newString.split('\n').length;
  const isLarge = editDiffIsLarge(oldString, newString);
  const [expanded, setExpanded] = useRowDisclosure(disclosureIds.diffFull(toolUseId), !isLarge);

  const diffLines = useMemo(
    () => computeLineDiff(oldString, newString),
    [oldString, newString],
  );

  const statusIcon = <StepIcon name={status === 'error' ? 'alert' : 'pen'} />;
  const statusClass = status === 'error' ? 'chat-tool-block-error'
    : status === 'done' ? 'chat-tool-block-done' : 'chat-tool-block-calling';

  const filename = filePath.split('/').pop() ?? filePath;

  return (
    <div className={`chat-tool-block ${statusClass}${collapsed ? '' : ' chat-tool-block--open'}`}>
      <button className="chat-tool-block-header" aria-expanded={!collapsed} onClick={() => setCollapsed(p => !p)}>
        <span className="chat-tool-block-icon">{statusIcon}</span>
        <span className="chat-tool-block-name">Edit</span>
        <span className="edit-diff-filename" title={filePath}>{filename}</span>
        {replaceAll && <span className="edit-diff-replace-all">(replace all)</span>}
        {status === 'calling' && runLive && <span className="chat-tool-block-calling-dot" />}
        <span className="chat-tool-block-arrow"><StepIcon name="chevron" /></span>
        {onViewFile && (
          <span
            className="edit-diff-view-file"
            role="button"
            tabIndex={0}
            title="View full file"
            onClick={(e) => { e.stopPropagation(); onViewFile(filePath); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onViewFile(filePath); } }}
          >
            &#x1F4C4;
          </span>
        )}
      </button>
      {!collapsed && (
        <div className="edit-diff-body">
          {!expanded ? (
            <button className="edit-diff-expand" onClick={() => setExpanded(true)}>
              Show diff ({totalLines} lines)
            </button>
          ) : (
            <pre className="edit-diff-pre">
              {diffLines.map((dl, i) => (
                <div key={i} className={`edit-diff-line edit-diff-line--${dl.type}`}>
                  <span className="edit-diff-prefix">
                    {dl.type === 'removed' ? '-' : dl.type === 'added' ? '+' : ' '}
                  </span>
                  <span className="edit-diff-text">{dl.text || '\u00A0'}</span>
                </div>
              ))}
            </pre>
          )}
          {status === 'error' && result && (
            <div className="edit-diff-error">{result}</div>
          )}
        </div>
      )}
    </div>
  );
}

/** Tool results and injected context are data: a task id in them stays the id,
 *  clickable, never swapped for the task's title. */
const DATA_RENDER = { taskIds: 'links' } as const;

/** Unframed text in a user row is the person's (send-frame.ts frames every other sender), so it is the primary's. */
const PERSON_TEXT = { host: '__local__' } as const;

/** Hide the image's parent container on load error (broken remote images, etc.).
 *  Hides .tool-result-image-item if present (caption + img), else hides parent element. */
const hideOnImgError = (e: React.SyntheticEvent<HTMLImageElement>) => {
  const img = e.target as HTMLImageElement;
  const container = img.closest('.tool-result-image-item') ?? img.parentElement;
  if (container instanceof HTMLElement) container.style.display = 'none';
};

/**
 * The previews under a reply for the image paths its text names. One component
 * for the persisted row and the streaming reply, so the strip is the same
 * before and after the handover (a broken image hides itself in both).
 */
export function ReplyImageStrip({ paths, cwd, host, inlineImages, onClick }: {
  paths: readonly string[];
  cwd?: string;
  /** The machine the session runs on (absent = this one); see useSessionTextRender. */
  host?: string;
  /** False while that machine is unknown: each path shows as a link, no picture loads. */
  inlineImages: boolean;
  /** Opens a path's link; only where no handler around the strip does (a streaming reply). */
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  // Each image keeps its box while it decodes (utils/image-size-hold.ts).
  useLayoutEffect(() => { holdImageBoxesIn(box.current); });
  if (paths.length === 0) return null;
  const resolved = paths
    .map((p) => ({ p, abs: resolveImagePath(p, cwd) }))
    .filter((x): x is { p: string; abs: string } => x.abs !== null);
  if (resolved.length === 0) return null;
  const render = { images: inlineImages, ...(host ? { host } : {}) };
  return (
    <div ref={box} className="tool-result-images" onClick={onClick}>
      {resolved.map(({ p, abs }, i) => {
        const src = localImageSrc(abs, render);
        // Keyed by host: a host change drops the old <img> and its load.
        return (
          <div key={`${host ?? ''}|${i}`} className="tool-result-image-item">
            {src
              ? <img src={src} className="inline-image" data-lightbox-src={src} loading="lazy" onError={hideOnImgError} />
              : <a className="file-link" data-file-path={abs} href="#" title={IMAGE_HOST_UNKNOWN}>{p}</a>}
            {src && <span className="inline-image-path">{p}</span>}
          </div>
        );
      })}
    </div>
  );
}

const IMAGE_HOST_UNKNOWN = 'Picture not loaded: the machine this session runs on is not known yet';

/**
 * Plain markdown prose: a person's own words, and a subagent group's result.
 *
 * Its own leaf so BOTH the html string and the `dangerouslySetInnerHTML` prop are
 * memoized. Rendered inline, these rows rebuilt their DOM on every re-render of
 * the timeline (React 19 writes innerHTML whenever the prop OBJECT changes
 * identity — see hooks/useStableHtml.ts), and a full history refetch re-renders
 * them: selecting a phrase in your own message and then clicking "Show earlier
 * messages" destroyed the selection. Subscribes the label store itself, the way
 * RichChunkView does, so memo() can block everything else without going stale.
 */
export const StableMarkdownBody = memo(function StableMarkdownBody({ text, cwd, host, inlineImages }: {
  text: string;
  cwd?: string;
  /** The session's machine, so an image path loads from it (absent = this one). */
  host?: string;
  /** False while that machine is unknown: image paths stay links. Absent = as before. */
  inlineImages?: boolean;
}) {
  const labelsVersion = useEntityLabelsVersion();
  const noImages = inlineImages === false;
  const html = useMemo(
    () => renderMarkdownWithRefs(text, cwd, host, noImages ? { inlineImages: false } : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- labelsVersion invalidates the pill lookups inside
    [text, cwd, host, noImages, labelsVersion],
  );
  const htmlProp = useStableHtml(html);
  return <div className="markdown-body" dangerouslySetInnerHTML={htmlProp} />;
});

interface SessionMessageProps {
  message: SessionHistoryMessage;
  assistantLabel?: string;
  sessionId?: string;
  sessionCwd?: string;
  sessionHost?: string;
  /** True when the timeline dissolved this message's tools into an adjacent
   *  merged run — render only the prose/thinking here. */
  suppressTools?: boolean;
  /** The words alone, as a question's comment card shows its answer: no tools
   *  and no thinking (whose part of the turn it was is not knowable there). */
  answerOnly?: boolean;
  /** The notes Walnut put in front of the person's words are drawn by the fold
   *  right above this row (SessionChatHistory), so this row draws the words alone. */
  ridersFolded?: boolean;
  /** The notes after the person's words are drawn by the fold right below this row. */
  trailingFolded?: boolean;
  /** Only the last assistant output renders copy actions, keeping middle rows compact. */
  showCopyActions?: boolean;
  /** The calls of a row whose words drew it already (SessionChatHistory's
   *  `toolsAfter`): no second copy, pin or time strip for the same message. */
  noActions?: boolean;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  onFileOpen?: (path: string, line?: number) => void;
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Muted collapsed "Thinking ›" row — same visual language as merged tool
 *  runs (ToolRunShell). `live` appends the pulsing dot while tokens stream. */
export function SessionThinking({ text, live, disclosureId }: { text: string; live?: boolean; disclosureId?: string }) {
  const [open, setOpen] = useRowDisclosure(disclosureId, false);
  // Signature-only thinking has no displayable text — render nothing rather
  // than an expandable-but-blank row.
  if (!text.trim()) return null;
  // A step row like every other (step-rows.css): the icon, the word, and the thought's
  // first line, muted, so a reader scanning an opened turn reads what it was thinking.
  const firstLine = open ? '' : thinkingFirstLine(text);
  return (
    <div className="tool-run-row tool-run-row--step">
      <button className="tool-run-toggle" aria-expanded={open} onClick={() => setOpen((p) => !p)}>
        <StepIcon name="thought" className="tool-run-icon" />
        <span className="tool-run-label">Thinking</span>
        {firstLine && <span className="tool-run-detail" data-find-skip="">{firstLine}</span>}
        {live && <span className="tool-run-live-dot" />}
        <span className={`tool-run-chevron${open ? ' tool-run-chevron--open' : ''}`}><StepIcon name="chevron" /></span>
      </button>
      {open && (
        <div className="tool-run-body">
          <div className="chat-thinking-content">{text}</div>
        </div>
      )}
    </div>
  );
}

/** A thought's first words, one line (bold marks, code ticks and blank lines dropped; an
 *  identifier's underscores stay). */
export function thinkingFirstLine(text: string, max = 160): string {
  const line = text.split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').replace(/\*\*|`/g, '').trim()).find((l) => l.length > 0) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}\u2026` : line;
}

/** Collapsed single-line row for Write to plans/ */
export function CollapsedPlanWrite({ filePath }: { filePath: string }) {
  const filename = filePath.split('/').pop() ?? filePath;
  return (
    <div className="session-plan-write-muted">
      <span className="chat-tool-block-icon"><StepIcon name="pen" /></span>
      <span>Wrote plan to <code>{filename}</code></span>
    </div>
  );
}

/** Accent-bordered card rendering the plan markdown, collapsible.
 *  Consumes PlanContentContext to show live plan content (bypasses memo).
 *  Falls back to the snapshot `content` prop when context is null (initial load, non-plan session). */
export function PlanCard({ content, disclosureId, sessionId, sessionCwd, sessionHost, onTaskClick, onSessionClick, onFileOpen }: {
  content: string;
  disclosureId?: string;
  /** The plan's session: pictures load from its machine, clicks use the panel's onFileOpen. */
  sessionId?: string;
  sessionCwd?: string;
  sessionHost?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  onFileOpen?: (path: string, line?: number) => void;
}) {
  const livePlan = useLivePlanContent();
  const displayContent = livePlan?.content ?? content;
  const [open, setOpen] = useRowDisclosure(disclosureId, true);
  // A from-plan live plan is another writer's: its machine, never this session's host or opener.
  const foreign = livePlan && livePlan.writerSessionId !== sessionId ? livePlan.writerSessionId : undefined;
  const own = useSessionTextRender({ sessionId, sessionHost, sessionCwd });
  const writer = useAgentFileOpener(foreign ? { sessionId: foreign } : undefined);
  const { cwd: planCwd, host: imageHost, images: imagesKnown } = foreign ? writer.render : own;
  const labelsVersion = useEntityLabelsVersion();
  const html = useMemo(
    () => renderMarkdownWithRefs(displayContent, planCwd, imageHost, imagesKnown ? undefined : { inlineImages: false }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- labelsVersion invalidates the pill lookups inside
    [displayContent, planCwd, imageHost, imagesKnown, labelsVersion],
  );
  const handleLinks = useEntityClickHandler(
    onTaskClick, onSessionClick,
    foreign ? writer.onFileOpen : onFileOpen,
    foreign ? writer.fileHost : sessionHost,
    foreign ? writer.fileSessionId : sessionId,
    foreign ? writer.refusesAll : undefined,
  );
  // Opened once here: the row's handler must not open it again.
  const handleBodyClick = useCallback((e: React.MouseEvent) => {
    handleLinks(e);
    if (e.defaultPrevented) e.stopPropagation();
  }, [handleLinks]);

  const handleExpandClick = useCallback(() => {
    // Open the unified plan modal (listened by SessionPanel)
    window.dispatchEvent(new CustomEvent('open-plan-modal'));
  }, []);

  return (
    <div className="session-plan-card">
      <div className="session-plan-card-header">
        <button className="session-plan-card-toggle" onClick={() => setOpen((p) => !p)}>
          <span className="session-plan-card-icon">{open ? '\u25BC' : '\u25B6\uFE0E'}</span>
          <span className="session-plan-card-title">Plan</span>
        </button>
        <button
          className="plan-card-expand-btn"
          onClick={handleExpandClick}
          title="Expand plan"
          aria-label="Expand plan to popup"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="10 2 14 2 14 6" />
            <polyline points="6 14 2 14 2 10" />
            <line x1="14" y1="2" x2="9" y2="7" />
            <line x1="2" y1="14" x2="7" y2="9" />
          </svg>
        </button>
      </div>
      {open && (
        <div className="session-plan-card-body">
          <div
            className="markdown-body"
            onClick={handleBodyClick}
            dangerouslySetInnerHTML={stableHtml(html)}
          />
        </div>
      )}
    </div>
  );
}

/** HTML-escape a string for safe insertion into innerHTML */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** CLI-injected user line (skill dump, compaction summary, …) — a muted
 *  one-line context row (Claude Code app style), click to expand the content. */
function InjectedContextRow({ text }: { text: string }) {
  const [open, setOpen] = useRowDisclosure(disclosureIds.content('inject', text), false);
  return (
    <div className="tool-run-row">
      <button className="tool-run-toggle" onClick={() => setOpen((p) => !p)}>
        <span className="tool-run-label">{injectedContextLabel(text)}</span>
        <span className={`tool-run-chevron${open ? ' tool-run-chevron--open' : ''}`}><StepIcon name="chevron" /></span>
      </button>
      {open && (
        <div className="tool-run-body">
          {/* No writer of its own: never the receiving session's machine. */}
          <AgentText className="chat-tool-block-result" text={text} unknownSource taskIds={DATA_RENDER.taskIds} />
        </div>
      )}
    </div>
  );
}

// ── Merged tool-run row (Claude Code app style) ──
// Consecutive generic tool calls collapse into ONE muted line: "Ran 3 commands,
// read a file ›". Click expands the individual tool cards. Task/Agent groups
// and plan cards stay standalone — only generic tools merge.

export { toolRunPhrase };

/** Shared merged-row shell: muted phrase line + expandable children. */
export function ToolRunShell({ phrase, calls, failCount, running, count, disclosureId, peek, children }: {
  phrase: string;
  /** What the run does now (StepRows LivePeek), under the closed line while it runs. */
  peek?: React.ReactNode;
  /** The run's tool calls: the line then counts them by outcome (ran, denied, waiting for
   *  an open prompt) and names the person's answers to the prompts they passed through
   *  (waiting-tools.ts). Without them the line is `phrase`. */
  calls?: readonly RunCall[];
  /** What the run shows (disclosureIds.run), so a reader who opened it keeps
   *  it open when the row is drawn again (its saved twin, a rebuilt lane). */
  disclosureId?: string;
  failCount: number;
  /** How many tool calls the run holds: a phone reads the row as `<n> tool calls`. */
  count?: number;
  /** True while a member is still receiving tokens (the reasoning streaming
   *  inside the run) — pulse dot, the same one a lone "Thinking ›" row shows. */
  running?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useRowDisclosure(disclosureId, false);
  const waiting = useWaitingTools();
  const decisions = useToolDecisions();
  const deniedNow = useDeniedNow();
  // Inside an opened fold a run of calls is no second line to open: its calls are
  // rows of the fold's one list, each with its own answer (design 1, 2026-11-11).
  // A run past FLAT_RUN_MAX calls stays one row to open, so opening a whale turn's fold
  // never mounts hundreds of cards at once.
  const flat = useInFoldBody() && (calls?.length ?? 0) > 0 && (calls?.length ?? 0) <= FLAT_RUN_MAX;
  // A call answered "no" reads as denied before its result is in (answeredCallState).
  const segments = calls ? runSegments(calls.map((c) => (!c.denied && answeredCallState(c.toolUseId, c.toolUseId ? decisions.get(c.toolUseId) : undefined, deniedNow) === 'denied' ? { ...c, denied: true } : c)), waiting) : [];
  // Every answer, in the order the calls were made.
  const answered = calls ? calls.flatMap((c) => {
    const line = c.toolUseId ? decisions.get(c.toolUseId) : undefined;
    const command = typeof c.input?.command === 'string' ? c.input.command : undefined;
    return line ? [{ line, command }] : [];
  }) : [];
  const answers = runAnswerLines(answered.map((a) => a.line), answered.map((a) => a.command));
  // Chevron first, as the turn's fold line reads (design 1, 2026-11-11).
  const line = (
    <>
      <span className={`tool-run-chevron tool-run-chevron--lead${open ? ' tool-run-chevron--open' : ''}`}><StepIcon name="chevron" /></span>
      <span className="tool-run-label">
        {segments.length === 0 ? phrase : segments.map((seg, i) => (
          <Fragment key={seg.kind}>
            {i > 0 && ', '}
            {seg.kind === 'ran' ? seg.text : <span className={`tool-run-${seg.kind}`}>{seg.text}</span>}
          </Fragment>
        ))}
      </span>
      {count !== undefined && count > 0 && <span className="tool-run-count">{toolCallsLabel(count)}</span>}
      {failCount > 0 && <span className="tool-run-fail">{failCount} failed</span>}
      {running && <span className="tool-run-live-dot" />}
    </>
  );
  if (flat) return <div className="tool-run-row tool-run-flat" data-flat="true"><RunLive.Provider value={!!running}><SoleCallContext.Provider value={false}>{children}</SoleCallContext.Provider></RunLive.Provider></div>;
  // Opened, each call's own row says its answer.
  const showAnswers = answers.length > 0 && !open;
  return (
    <div className="tool-run-row">
      <button className={`tool-run-toggle${showAnswers ? ' tool-run-toggle--answered' : ''}`} aria-expanded={open} onClick={() => setOpen((p) => !p)}>
        {/* The answers under the line, not squeezed beside its count. */}
        {showAnswers ? (
          <>
            <span className="tool-run-line">{line}</span>
            {/* One answer per line: a note's own words never run into the next call's answer. */}
            <span className="tool-run-decisions" title={answers.join('\n')}>
              {answers.map((a) => <span key={a} className="tool-run-decision"><AnswerText text={a} /></span>)}
            </span>
          </>
        ) : line}
      </button>
      {!open && running && peek && <div className="process-fold-peek" data-testid="run-peek">{peek}</div>}
      {open && <div className="tool-run-body"><SoleCallContext.Provider value={calls?.length === 1}>{children}</SoleCallContext.Provider></div>}
    </div>
  );
}

/** Error lines carry a "!" prefix; everything else has NO icon — matching the
 *  bare "Ran 3 commands ›" tool-run rows for one unified visual language. */
function systemLineIcon(variant: string): string {
  return variant === 'error' || variant === CLI_ERROR_VARIANT ? '!' : '';
}

/** System notice that keeps compact lines inline and collapses verbose payloads. */
export function SystemLineCollapsible({ variant, message, detail, time, noticeId, inOpenedRun }: {
  variant: string;
  message: string;
  detail?: string;
  time?: string;
  /** The notice's id (the history row's msgId, the streamed block's uuid): keeps it open across the swap. */
  noticeId?: string;
  /** Drawn inside a SystemGroupRun the reader opened (the idle compaction's line then shows why at once). */
  inOpenedRun?: boolean;
}) {
  // Kept by the notice's id (row-disclosure.ts), so it stays open when its
  // streamed block gives way to the persisted row; by its words when it has none.
  const [open, setOpen] = useRowDisclosure(noticeId ? `notice-${noticeId}` : disclosureIds.content(`sys-${variant}`, message), false);
  const toggleOpen = () => setOpen((o) => !o);
  const icon = systemLineIcon(variant);
  // Walnut's idle compaction opens, on a click, to why it ran and the setting that decides it.
  if (isIdleCompactLine(message)) return <IdleCompactLine message={message} time={time} noticeId={noticeId} inOpenedRun={inOpenedRun} />;
  if (detail && detail.length > 80) {
    return (
      <div className="tool-run-row">
        <button className="tool-run-toggle" onClick={toggleOpen}>
          <span className={`tool-run-label${variant === 'error' ? ' tool-run-label--error' : ''}`}>
            {icon ? `${icon} ${message}` : message}
          </span>
          <span className={`tool-run-chevron${open ? ' tool-run-chevron--open' : ''}`}><StepIcon name="chevron" /></span>
        </button>
        {open && (
          <div className="tool-run-body">
            <pre className="session-system-detail-pre">{detail}</pre>
            {time && <div className="session-system-detail">{time}</div>}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className={`session-system-line session-system-line--${variant}`}>
      {icon && <span className="session-system-icon">{icon}</span>}
      <span className="session-system-text">{message}</span>
      {detail && <span className="session-system-detail">{detail}</span>}
      {time && <span className="session-system-detail session-system-time">{time}</span>}
    </div>
  );
}

export interface SystemGroupMember {
  variant: string;
  message: string;
  detail?: string;
  time?: string;
  key?: string;
}

/** Map persisted system history onto the shared compact/verbose row shape. */
export function systemGroupMemberFromHistory(message: SessionHistoryMessage): SystemGroupMember {
  const text = message.text ?? '';
  // A row that shipped its own detail (a compaction's numbers) is already split
  // the way the live row is — use it verbatim so the two are indistinguishable.
  // Only unsplit rows fall back to truncating a long single string.
  const isVerbose = !message.systemDetail && text.length > 160;
  return {
    variant: systemRowVariant(message),
    message: isVerbose ? `${text.slice(0, 80)}…` : text,
    detail: message.systemDetail ?? (isVerbose ? text : undefined),
    time: formatTime(message.timestamp),
    key: message.msgId ?? message.walnutMessageId,
  };
}

/** Collapsed run of consecutive system notices from history or the live stream. */
export const SystemGroupRun = memo(function SystemGroupRun({ members }: { members: SystemGroupMember[] }) {
  // Closed until the reader opens it, an idle compaction's run too (2026-11-09, the user: "no, auto hide
  // cusotmer cna open if needed"; tests/web/notice-rows-start-closed.test.ts).
  const [open, setOpen] = useRowDisclosure(members[0] ? disclosureIds.content(`sysrun-${members[0].variant}`, members[0].message) : undefined, false);
  const toggle = () => setOpen((o) => !o);
  const allErrors = members.length > 0 && members.every((member) => member.variant === 'error' || member.variant === CLI_ERROR_VARIANT);
  // A compaction's run says so (its explanation and numbers are inside).
  const label = allErrors ? `${members.length} errors` : systemRunLabel(members);
  // A line that names Walnut's compaction already says its size: the compaction's own row under it
  // would say it again (2026-11-05 review), so the run shows Walnut's notice of why.
  const shown = systemRunShows(members);
  return (
    <div className="tool-run-row">
      <button className="tool-run-toggle" onClick={toggle}>
        <span className={`tool-run-label${allErrors ? ' tool-run-label--error' : ''}`}>{label}</span>
        <span className={`tool-run-chevron${open ? ' tool-run-chevron--open' : ''}`}><StepIcon name="chevron" /></span>
      </button>
      {open && (
        <div className="tool-run-body">
          {shown.map((member, i) => (
            <SystemLineCollapsible
              key={member.key ?? `${member.variant}:${member.message}:${i}`}
              variant={member.variant}
              message={member.message}
              detail={member.detail}
              time={member.time}
              {...(member.key ? { noticeId: member.key } : {})}
              inOpenedRun
            />
          ))}
        </div>
      )}
    </div>
  );
});

/** History-side merged run of generic tools. */
function ToolRunRow({ tools, assistantLabel, sessionId, sessionCwd, sessionHost, onTaskClick, onSessionClick, onFileOpen }: {
  tools: SessionHistoryTool[];
} & Omit<SessionToolCallProps, 'tool'>) {
  const phrase = toolRunPhrase(tools);
  const failCount = tools.filter(t => t.isError && !isRoutedQuestion(t.name, t.result) && !isUserDenied(t.result)).length;
  return (
    <ToolRunShell phrase={phrase} calls={tools.map(historyRunCall)} failCount={failCount} running={tools.some((t) => t.liveStatus === 'calling')} count={tools.length} disclosureId={disclosureIds.run({ toolUseId: tools[0]?.toolUseId })}>
      {tools.map((t, i) => (
        <SessionToolCall key={t.toolUseId ?? i} tool={t} {...(t.liveStatus ? { status: t.liveStatus } : {})} assistantLabel={assistantLabel} sessionId={sessionId} sessionCwd={sessionCwd} sessionHost={sessionHost} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />
      ))}
    </ToolRunShell>
  );
}

/** True when a history tool merges into a run (generic tools only). */
export function isMergeableHistoryTool(tool: SessionHistoryTool): boolean {
  // The live stream's rule too (stream/tool-merge.ts).
  return toolMergesIntoRun(tool);
}

/** True when an entire persisted message can dissolve into a cross-message
 *  tool run: assistant, no visible text, and every tool is generic. The CLI
 *  emits one assistant message per tool call, so consecutive tool-only
 *  messages are the "Ran 3 commands, read 2 files" case. */
export function isToolOnlyMessage(m: SessionHistoryMessage): boolean {
  return m.role === 'assistant'
    && !(m.text ?? '').trim()
    && !!m.tools && m.tools.length > 0
    && m.tools.every(isMergeableHistoryTool);
}

/** Assistant message that is ONLY thinking (no prose, no tools). Consecutive
 *  ones collapse into a single "Thinking ›" row instead of stacking. */
export function isThinkingOnlyMessage(m: SessionHistoryMessage): boolean {
  return m.role === 'assistant'
    && !(m.text ?? '').trim()
    && (!m.tools || m.tools.length === 0)
    && !!(m.thinking ?? '').trim();
}

/** One thinking-only message standing for a stretch of them: the first row's
 *  identity, every row's reasoning joined — what a run with no tool in it
 *  renders as (one "Thinking ›" row). */
export function mergeThinkingOnly(messages: readonly SessionHistoryMessage[]): SessionHistoryMessage {
  if (messages.length === 1) return messages[0];
  return { ...messages[0], thinking: messages.map(m => m.thinking ?? '').filter(s => s.trim()).join('\n\n') };
}

/** Where a history run's members end when a visible non-run message follows
 *  it: always the whole run. Thinking-only rows at its end led to the message
 *  that follows, and they stay inside the run rather than splitting off as a
 *  "Thinking ›" row of their own (2026-10-04) — the history twin of
 *  trailingThinkingStart (group-blocks.ts). */
export function trailingThinkingOnlyStart(run: readonly SessionHistoryMessage[]): number {
  return run.length;
}

/** Assistant message carrying BOTH prose and (all-generic) tools. The CLI's
 *  content order is text first, tool_use after — so the prose renders as its
 *  own message while the tools dissolve forward into the adjacent run instead
 *  of splitting two runs apart. */
export function isTextPlusMergeableTools(m: SessionHistoryMessage): boolean {
  return m.role === 'assistant'
    && !!(m.text ?? '').trim()
    && !!m.tools && m.tools.length > 0
    && m.tools.every(isMergeableHistoryTool);
}

/** Words with calls that are all steps, one of them a message sent to another
 *  session (the rest generic tools): the words stay on screen and the calls fold
 *  after them as one closed line ("Sent 1 message"), never the send's whole card
 *  between two paragraphs of the answer (2026-11-09, the user: "the message
 *  should also be auto collapsed ... like send message 1"). */
export function isTextPlusStepTools(m: SessionHistoryMessage): boolean {
  return m.role === 'assistant'
    && !!(m.text ?? '').trim()
    && !!m.tools && m.tools.length > 0
    && m.tools.every((t) => isMergeableHistoryTool(t) || detectOutboundCalls(t, t.result).length > 0);
}

/** A streaming run member: a generic tool (running or done), or the reasoning
 *  around it. The stream hands the two over as separate blocks; the run keeps them
 *  side by side the way the persisted message will (thinking, then its tools). */
export type StreamRunMember = StreamingBlock & { type: 'tool_call' | 'thinking' };

/** Is any of a run's streaming members a tool still running? The run's row then
 *  breathes: the call is inside the closed run, not a card of its own. */
export function streamRunHasCallingTool(members: readonly StreamRunMember[]): boolean {
  return members.some((b) => b.type === 'tool_call' && b.status === 'calling');
}

/** The collapsed line and failure count of a run's streaming members. Reasoning
 *  is deliberately not a verb in the phrase: the row says what the turn DID, and
 *  it must read exactly as the persisted run it turns into once history absorbs
 *  it, or the line changes wording under the reader at turn end. */
export function streamRunSummary(members: readonly StreamRunMember[]): { phrase: string; failCount: number; calls: RunCall[] } {
  const tools = members.filter((b): b is StreamingBlock & { type: 'tool_call' } => b.type === 'tool_call');
  return {
    phrase: toolRunPhrase(tools.map(b => ({ name: b.name ?? 'unknown', input: b.input }))),
    failCount: tools.filter(b => b.status === 'error' && !isRoutedQuestion(b.name, b.result) && !isUserDenied(b.result)).length,
    calls: tools.map(streamRunCall),
  };
}

/** A persisted call as its run's line counts it (ToolRunShell `calls`). */
function historyRunCall(t: SessionHistoryTool): RunCall {
  return { name: t.name, input: t.input, toolUseId: t.toolUseId, denied: !!t.isError && isUserDenied(t.result), done: t.result !== undefined };
}

/** A streaming call as its run's line counts it: the same reading as its persisted twin. */
function streamRunCall(b: StreamingBlock & { type: 'tool_call' }): RunCall {
  return { name: b.name ?? 'unknown', input: b.input, toolUseId: b.toolUseId, denied: b.status === 'error' && isUserDenied(b.result), done: b.status !== 'calling' };
}

/** A run row's React key: the identity of its first member (a tool's id, a
 *  thinking block's message id), never its position — rows ahead of it fold and
 *  shift positions while the reader has it open. A thinking-only stretch and
 *  the run it becomes once a tool joins share the key on purpose. */
export function runRowKey(blocks: readonly StreamRunMember[], fallback: number): string {
  const first = blocks[0];
  if (first?.type === 'tool_call') return `run-${first.toolUseId}`;
  return `run-${first?.msgId ?? `at${fallback}`}`;
}

/** A live call as the saved tool it will be (SessionToolCall reads one shape). */
function streamToolOf(b: StreamingBlock & { type: 'tool_call' }): SessionHistoryTool {
  return {
    name: b.name ?? 'unknown', input: b.input ?? {}, toolUseId: b.toolUseId,
    ...(b.result !== undefined ? { result: b.result } : {}),
  } as SessionHistoryTool;
}

/** A merged run's streaming members, in arrival order: each thinking block its
 *  own "Thinking ›" row, each tool its card (a running one says so) — the same
 *  body a persisted run shows (MergedHistoryToolRun), so the row does not change
 *  shape when history absorbs it. `live` marks the last member as still
 *  receiving tokens. */
export function StreamRunMembers({ members, live, sessionId, sessionCwd, sessionHost, onTaskClick, onSessionClick, onFileOpen }: {
  members: readonly StreamRunMember[];
  live?: boolean;
  sessionId?: string;
  sessionCwd?: string;
  sessionHost?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  onFileOpen?: (path: string, line?: number) => void;
}) {
  return (
    <>
      {members.map((b, i) => b.type === 'thinking' ? (
        <SessionThinking key={b.msgId ? `think-${b.msgId}-${i}` : `think-${i}`} text={b.content} live={live && i === members.length - 1} disclosureId={disclosureIds.thinking(b.msgId)} />
      ) : (
        <SessionToolCall
          key={b.toolUseId ?? i}
          tool={streamToolOf(b)}
          assistantLabel="Claude Code"
          status={b.status === 'error' ? 'error' : b.status === 'calling' ? 'calling' : 'done'}
          sessionCwd={sessionCwd}
          sessionHost={sessionHost}
          sessionId={sessionId}
          onTaskClick={onTaskClick}
          onSessionClick={onSessionClick}
          onFileOpen={onFileOpen}
        />
      ))}
    </>
  );
}

/** Cross-MESSAGE merged tool run (the iOS look): consecutive tool-only
 *  assistant messages collapse into ONE muted line. Expanding shows each
 *  message's thinking + tool cards.
 *  `trailingBlocks` are the live turn's first stream blocks when they continue
 *  this run across the history/stream boundary (tools and the reasoning between
 *  them); `trailingLive` says the last of them is still streaming.
 *  memo: the parent re-renders every 150ms streaming flush; with a stable
 *  `messages` array (built once in the memoized history-parts pass) this
 *  entire subtree skips — the fix for whale-session scroll/typing lag. */
export const MergedHistoryToolRun = memo(function MergedHistoryToolRun({ messages, trailingBlocks = [], trailingLive, assistantLabel = 'Claude Code', sessionId, sessionCwd, sessionHost, onTaskClick, onSessionClick, onFileOpen }: {
  messages: SessionHistoryMessage[];
  trailingBlocks?: readonly StreamRunMember[];
  trailingLive?: boolean;
  assistantLabel?: string;
  sessionId?: string;
  sessionCwd?: string;
  sessionHost?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  onFileOpen?: (path: string, line?: number) => void;
}) {
  const allTools = messages.flatMap(m => m.tools ?? []);
  const trailingTools = trailingBlocks.filter((b): b is StreamingBlock & { type: 'tool_call' } => b.type === 'tool_call');
  const phrase = toolRunPhrase([
    ...allTools,
    ...trailingTools.map(b => ({ name: b.name ?? 'unknown', input: b.input })),
  ]);
  const failCount = allTools.filter(t => t.isError && !isRoutedQuestion(t.name, t.result) && !isUserDenied(t.result)).length
    + trailingTools.filter(b => b.status === 'error' && !isRoutedQuestion(b.name, b.result) && !isUserDenied(b.result)).length;
  // The run's first member, as the live run names it (runRowKey): a message's
  // reasoning streams before its tools.
  const head = messages[0];
  const first = head ? (head.thinking ? { msgId: head.msgId } : { toolUseId: head.tools?.[0]?.toolUseId })
    : trailingBlocks[0]?.type === 'tool_call' ? { toolUseId: trailingBlocks[0].toolUseId } : { msgId: trailingBlocks[0]?.msgId };
  return (
    <ToolRunShell phrase={phrase} calls={[...allTools.map(historyRunCall), ...trailingTools.map(streamRunCall)]} failCount={failCount} running={trailingLive || allTools.some((t) => t.liveStatus === 'calling')} count={allTools.length + trailingTools.length} disclosureId={disclosureIds.run(first)}>
      {messages.map((m, mi) => (
        // Each member counts its own words in a find (PageFind's row ids).
        <div key={m.msgId ?? mi} data-find-row={m.msgId ?? m.walnutMessageId}>
          {m.thinking && <SessionThinking text={m.thinking} disclosureId={disclosureIds.thinking(m.msgId)} />}
          {(m.tools ?? []).map((t, ti) => (
            <SessionToolCall key={t.toolUseId ?? ti} tool={t} {...(t.liveStatus ? { status: t.liveStatus } : {})} assistantLabel={assistantLabel} sessionId={sessionId} sessionCwd={sessionCwd} sessionHost={sessionHost} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />
          ))}
        </div>
      ))}
      <StreamRunMembers
        members={trailingBlocks}
        live={trailingLive}
        sessionId={sessionId}
        sessionCwd={sessionCwd}
        sessionHost={sessionHost}
        onTaskClick={onTaskClick}
        onSessionClick={onSessionClick}
        onFileOpen={onFileOpen}
      />
    </ToolRunShell>
  );
});

interface GenericToolCallProps {
  /** `toolUseId` names the call, so its card keeps its state when the row is drawn again. */
  tool: { name: string; input: Record<string, unknown>; toolUseId?: string };
  /** Tool execution status. Defaults to 'done' (preserves history behavior). */
  status?: 'calling' | 'done' | 'error';
  /** Tool result text (streaming path provides this separately from tool.result). */
  result?: string;
  /** Session working directory — used to resolve relative image paths */
  sessionCwd?: string;
  /** Session host — used to resolve relative file paths on click (remote sessions) */
  sessionHost?: string;
  /** Session id — lets path resolution consult this session's transcript, which
   *  is the cheapest and most accurate way to turn a partial path into a real one. */
  sessionId?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  onFileOpen?: (path: string, line?: number, term?: undefined, endLine?: number) => void;
}

// memo: hundreds of these render inside a whale session's history; the
// streaming flush re-renders the parent every 150ms. tool/input are stable
// object refs from the parsed history rows, so memo actually skips.
export const GenericToolCall = memo(function GenericToolCall(props: GenericToolCallProps) {
  // A session→session SEND is provenance, not a tool run: card it the same way
  // the RECEIVING side is carded, so both halves of one conversation read alike.
  // Before the Bash dispatch, because most sends are a `walnut tools call` line.
  const sendResult = props.result ?? (props.tool as { result?: string }).result;
  const outbound = useMemo(() => detectOutboundCalls(props.tool as SessionHistoryTool, sendResult), [props.tool, sendResult]);
  if (outbound.length > 0) {
    return <SessionOutboundCards calls={outbound} toolUseId={props.tool.toolUseId} running={sendResult === undefined && props.status === 'calling'} result={sendResult} sessionCwd={props.sessionCwd} sessionHost={props.sessionHost} sessionId={props.sessionId} onTaskClick={props.onTaskClick} onSessionClick={props.onSessionClick} />;
  }
  // A Walnut op through the CLI (`walnut tools call <op> …`) renders as the MCP
  // tool it stands in for, never as a raw Bash card.
  const asTool = walnutToolView(props.tool as SessionHistoryTool);
  if (asTool !== props.tool) return <GenericToolCallInner {...props} tool={asTool} />;
  // Bash gets terminal-style rendering (real newlines, plain-pre output, popup)
  // instead of the JSON input dump. Dispatch BEFORE any hooks; single choke
  // point covering history, streaming, and ClaudeStreamView callers alike.
  if (props.tool.name === 'Bash' && typeof props.tool.input?.command === 'string') {
    return <BashToolCall tool={props.tool} status={props.status} result={props.result} sessionCwd={props.sessionCwd} sessionHost={props.sessionHost} sessionId={props.sessionId} onFileOpen={props.onFileOpen} />;
  }
  return <GenericToolCallInner {...props} />;
});

function GenericToolCallInner({ tool, status: statusProp = 'done', result: resultProp, sessionCwd, sessionHost, sessionId, onTaskClick, onSessionClick, onFileOpen }: GenericToolCallProps) {
  const runLive = useRunLive();
  const [open, setOpen] = useRowDisclosure(disclosureIds.tool(tool.toolUseId), useSoleCall());
  // Pill titles resolve from the entity-label store — memo boundary is at
  // GenericToolCall, so this leaf must subscribe itself to see title changes.
  const labelsVersion = useEntityLabelsVersion();
  // The tool output's writer (this session) for pictures and clicks; unknown with no host and no session.
  const file = useAgentFileOpener(sessionTextSource({ sessionId, sessionHost, sessionCwd }, peekSessionRecord));
  const { host: imageHost, images: imagesKnown } = file.render;
  // Merge result from explicit prop (streaming path) and tool.result (persisted history path)
  const result = resultProp ?? (tool as { result?: string }).result;
  const waitingTools = useWaitingTools();
  const toolDecisions = useToolDecisions();
  const decision = tool.toolUseId ? toolDecisions.get(tool.toolUseId) : undefined;
  // Persisted history carries isError (tool_result.is_error) — a failed tool must
  // render ✗ after reload, matching what the streaming view showed live. A
  // worker's question sent to its leader is denied by design, not failed.
  const routed = isRoutedQuestion(tool.name, result);
  const answered = answeredCallState(tool.toolUseId, decision, useDeniedNow());
  const denied = (isUserDenied(result) && ((tool as { isError?: boolean }).isError || statusProp === 'error'))
    || (result === undefined && answered === 'denied');
  // Held by a prompt still open: no result yet, so not done (waiting-tools.ts).
  const waiting = !denied && result === undefined && !!tool.toolUseId && waitingTools.has(tool.toolUseId);
  // Sent beside a call whose prompt is open: the CLI runs nothing until it is answered.
  const queued = !waiting && !denied && !answered && result === undefined && waitingTools.size > 0 && !(tool as { isError?: boolean }).isError && statusProp !== 'error';
  const status = waiting || queued ? 'waiting' : denied ? 'denied'
    : (tool as { isError?: boolean }).isError && !routed ? 'error'
    : statusProp === 'error' && routed ? 'done' : statusProp;
  const safeInput = (tool.input && typeof tool.input === 'object') ? tool.input : {};
  const description = toolDescription(safeInput);
  // Memoized: JSON.stringify over a large Write/Edit input on EVERY render was
  // the measured hot spot behind whale-session slow commits (5-32s).
  const inputSummary = useMemo(() => toolTarget(tool.name, safeInput), [safeInput, tool.name]);

  // Dynamic icon and class based on status
  // A denied call: the person's no, not a failure (isUserDenied).
  // One icon per kind of tool (StepIcon.tsx); a failure or the person's no colours it instead.
  const statusIcon = <StepIcon name={status === 'denied' ? 'ban' : status === 'error' ? 'alert' : toolStepIcon(tool.name)} />;
  const statusClass = status === 'waiting' ? 'chat-tool-block-waiting' : status === 'denied' ? 'chat-tool-block-denied' : status === 'error' ? 'chat-tool-block-error'
    : status === 'done' ? 'chat-tool-block-done' : 'chat-tool-block-calling';

  // Detect long multiline string values in input and render as markdown.
  // Only computed when expanded (open) to avoid eager parsing cost.
  // Dependency is tool.input (stable ref) — safeInput creates a new {} each render when falsy.
  const markdownFields = useMemo(() => {
    if (!open || !tool.input) return [];
    const input = (typeof tool.input === 'object') ? tool.input : {};
    return extractMarkdownFields(input, { host: imageHost, inlineImages: imagesKnown });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- labelsVersion invalidates ref lookups inside
  }, [tool.input, open, labelsVersion, imageHost, imagesKnown]);

  // Expanded JSON with pill links injected
  const expandedJsonHtml = useMemo(() => {
    if (!open) return '';
    const jsonStr = JSON.stringify(safeInput, null, 2);
    return injectJsonIdLinks(escapeHtml(jsonStr));
  }, [safeInput, open]);

  // Result rendering with image detection (base64 content blocks + file paths)
  const { resultImages, resultTextHtml } = useMemo<{
    /** `src` null: a path on a machine not known yet, shown as a link to `path`. */
    resultImages: { src: string | null; path?: string; key: string; caption?: string }[] | null;
    resultTextHtml: string;
  }>(() => {
    if (!open || !result) return { resultImages: null, resultTextHtml: '' };
    const render = { images: imagesKnown, ...(imageHost ? { host: imageHost } : {}) };
    const textOpts = imagesKnown ? DATA_RENDER : { ...DATA_RENDER, inlineImages: false };

    // 1. Check for Anthropic content blocks with base64 images (data URIs: no machine to name)
    const extracted = extractContentBlockImages(result);
    if (extracted) {
      const images = extracted.imageSrcs.map((src, i) => ({ src, key: `b64-${i}` }));
      const text = extracted.textParts.length > 0
        ? renderMarkdownWithRefs(extracted.textParts.join('\n'), undefined, imageHost, textOpts)
        : '';
      return { resultImages: images, resultTextHtml: text };
    }

    // 2. Check for image file paths in result text (skip unresolvable relative paths)
    const paths = findImagePaths(result);
    const resolved = paths
      .map((p, i) => {
        const abs = resolveImagePath(p, sessionCwd);
        return abs ? { src: localImageSrc(abs, render), path: abs, key: `path-${imageHost ?? ''}-${i}`, caption: p } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const images = resolved.length > 0 ? resolved : null;

    // 3. The whole text (a cut mid-path linked a wrong path); the box scrolls, rendered only while open.
    const text = renderMarkdownWithRefs(result, undefined, imageHost, textOpts);
    return { resultImages: images, resultTextHtml: text };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- labelsVersion invalidates ref lookups inside
  }, [result, open, sessionCwd, labelsVersion, imageHost, imagesKnown]);

  // Input image preview: if file_path/path/filename points to an image file, show thumbnail
  const inputImage = useMemo<{ src: string | null; path: string } | null>(() => {
    if (!open) return null;
    const fp = safeInput.file_path ?? safeInput.path ?? safeInput.filename;
    if (typeof fp !== 'string' || !isImageFilePath(fp)) return null;
    // Skip if result already has images (avoids showing same image twice for Read tool)
    if (resultImages && resultImages.length > 0) return null;
    const resolved = resolveImagePath(fp, sessionCwd);
    if (!resolved) return null;
    return { src: localImageSrc(resolved, { images: imagesKnown, ...(imageHost ? { host: imageHost } : {}) }), path: resolved };
  }, [safeInput, open, resultImages, sessionCwd, imageHost, imagesKnown]);

  // Unified click handler for entity ref links (.task-link, .session-link, .file-link) inside tool blocks
  // The caller's opener (the panel's hand-off) first, else the writer's; one handler for the whole body.
  const handleLinks = useEntityClickHandler(onTaskClick, onSessionClick, onFileOpen ?? file.onFileOpen, sessionHost, sessionId, file.refusesAll);
  // The shared handler marks a link it took (preventDefault); the row's handler must not take it too.
  const handleBodyClick = useCallback((e: React.MouseEvent) => {
    handleLinks(e);
    if (e.defaultPrevented) e.stopPropagation();
  }, [handleLinks]);

  // [View File] button for tools that operate on files
  const toolFilePath = typeof safeInput.file_path === 'string' ? safeInput.file_path : null;
  const showViewFile = onFileOpen && toolFilePath && ['Edit', 'Read', 'Write', 'NotebookEdit'].includes(tool.name);

  return (
    <div className={`chat-tool-block ${statusClass}${open ? ' chat-tool-block--open' : ''}`}>
      <button className="chat-tool-block-header" aria-expanded={open} onClick={() => setOpen((p) => !p)}>
        <span className="chat-tool-block-icon">{statusIcon}</span>
        <span className="chat-tool-block-name" title={tool.name}>{toolDisplayName(tool.name)}</span>
        {description && (
          <span className="chat-tool-block-desc">· {description}</span>
        )}
        {status === 'waiting' && <span className="chat-tool-block-waiting-label">{queued ? 'Queued' : tool.name === 'AskUserQuestion' ? 'Waiting for your answer' : 'Waiting for approval'}</span>}
        {status !== 'waiting' && decision && <span className="chat-tool-block-decision" title={decision}><AnswerText text={callDecisionLabel(decision)} /></span>}
        {!open && inputSummary && (
          <span className="chat-tool-block-summary">{inputSummary}</span>
        )}
        {status === 'calling' && runLive && <span className="chat-tool-block-calling-dot" />}
        <span className="chat-tool-block-arrow"><StepIcon name="chevron" /></span>
        {showViewFile && (
          <span
            className="edit-diff-view-file"
            role="button"
            tabIndex={0}
            title="View full file"
            onClick={(e) => { e.stopPropagation(); onFileOpen!(toolFilePath!); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onFileOpen!(toolFilePath!); } }}
          >
            &#x1F4C4;
          </span>
        )}
      </button>
      {open && (
        <div className="chat-tool-block-body" onClick={handleBodyClick}>
          <div className="chat-tool-block-section">
            <div className="chat-tool-block-section-label">Input</div>
            <pre className="chat-tool-block-pre" dangerouslySetInnerHTML={stableHtml(expandedJsonHtml)} />
            {markdownFields.map(f => (
              <div key={f.key} className="chat-tool-block-field-markdown">
                <div className="chat-tool-block-field-label">{f.key}</div>
                <div className="chat-tool-block-result markdown-body"
                     dangerouslySetInnerHTML={stableHtml(f.html)} />
              </div>
            ))}
            {inputImage && (
              <div className="tool-result-images">
                {inputImage.src
                  ? <img key={inputImage.src} src={inputImage.src} className="inline-image" data-lightbox-src={inputImage.src} loading="lazy" onError={hideOnImgError} />
                  : <a className="file-link" data-file-path={inputImage.path} href="#" title={IMAGE_HOST_UNKNOWN}>{inputImage.path}</a>}
              </div>
            )}
          </div>
          {/* The whole answer, which the header line cuts to fit. */}
          {status !== 'waiting' && decision && (
            <div className="chat-tool-block-section">
              <div className="chat-tool-block-section-label">Answer</div>
              <div className="chat-tool-block-answer"><AnswerText text={callAnswerText(decision, typeof safeInput.command === 'string' ? safeInput.command : undefined)} /></div>
            </div>
          )}
          {status !== 'calling' && (resultImages || resultTextHtml) && (
            <div className="chat-tool-block-section">
              <div className="chat-tool-block-section-label">Result</div>
              {resultImages && (
                <div className="tool-result-images">
                  {resultImages.map(img => (
                    <div key={img.key} className="tool-result-image-item">
                      {img.src
                        ? <img src={img.src} className="inline-image" data-lightbox-src={img.src} loading="lazy" onError={hideOnImgError} />
                        : <a className="file-link" data-file-path={img.path} href="#" title={IMAGE_HOST_UNKNOWN}>{img.caption ?? img.path}</a>}
                      {img.src && img.caption && <span className="inline-image-path">{img.caption}</span>}
                    </div>
                  ))}
                </div>
              )}
              {resultTextHtml && (
                <div className="chat-tool-block-result markdown-body"
                     dangerouslySetInnerHTML={stableHtml(resultTextHtml)} />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Extract plan content from an ExitPlanMode tool — checks planContent field, then input.plan */
function getExitPlanContent(tool: { input: Record<string, unknown>; planContent?: string }): string | null {
  if (tool.planContent) return tool.planContent;
  if (typeof tool.input?.plan === 'string' && tool.input.plan) return tool.input.plan;
  return null;
}

interface SessionToolCallProps {
  tool: SessionHistoryTool;
  assistantLabel: string;
  /** A live call's state; a saved one reads its own (`isError`). */
  status?: 'calling' | 'done' | 'error';
  sessionId?: string;
  sessionCwd?: string;
  sessionHost?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  onFileOpen?: (path: string, line?: number) => void;
}

/** Tool names that should render as collapsible groups with child messages. */
const GROUPABLE_HISTORY_TOOLS = new Set(['Task', 'Agent']);

/** Short model label for the task-group header chip (full Bedrock IDs → "opus-4-8"). */
export function agentModelLabel(input?: Record<string, unknown>): string {
  const model = input?.model;
  if (typeof model !== 'string' || !model) return '';
  const last = model.split('.').pop() ?? model;
  return last.replace(/^claude-/, '').replace(/-v\d+.*$/, '').replace(/\[[^\]]*\]$/, '');
}

/** Collapsed-by-default row inside a task-group body exposing the subagent's
 *  full input: prompt text + remaining settings (model, effort, isolation…).
 *  Opt-in visibility — header stays uncluttered. */
export function TaskGroupPrompt({ input, toolUseId }: { input?: Record<string, unknown>; toolUseId?: string }) {
  const [open, setOpen] = useRowDisclosure(disclosureIds.prompt(toolUseId), false);
  const prompt = typeof input?.prompt === 'string' ? input.prompt : '';
  const settings = Object.entries(input ?? {})
    .filter(([k, v]) => k !== 'prompt' && k !== 'description' && v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  if (!prompt && settings.length === 0) return null;
  return (
    <div className="task-group-prompt">
      <button className="task-group-prompt-toggle" onClick={() => setOpen(p => !p)}>
        <span className="task-group-chevron">{open ? '▼' : '▶︎'}</span>
        <span className="task-group-prompt-title">Prompt &amp; settings</span>
        {!open && prompt && (
          <span className="task-group-prompt-preview">{prompt.slice(0, 120)}</span>
        )}
      </button>
      {open && (
        <div className="task-group-prompt-body">
          {settings.length > 0 && (
            <div className="task-group-prompt-settings">{settings.join(' · ')}</div>
          )}
          {prompt && <pre className="task-group-prompt-pre">{prompt}</pre>}
        </div>
      )}
    </div>
  );
}

/** What the conversation knows about one Agent tool call, for the Background tasks panel. */
export function knownAgentFromTool(tool: SessionHistoryTool): KnownAgent {
  const description = typeof tool.input?.description === 'string'
    ? tool.input.description
    : typeof tool.input?.prompt === 'string'
      ? (tool.input.prompt as string).slice(0, 80) + ((tool.input.prompt as string).length > 80 ? '...' : '')
      : tool.name;
  return {
    toolUseId: tool.toolUseId,
    agentId: tool.agentId,
    description,
    subagentType: typeof tool.input?.subagent_type === 'string' ? tool.input.subagent_type : undefined,
    // A background agent's tool_result is launch metadata written while it still
    // runs, so result-presence is not "finished"; the parser's bgTaskFinished stamp
    // is (task-notification for background agents, the settled tool_result for sync ones).
    finished: !!tool.bgTaskFinished,
    result: agentResultText(tool.result),
    promptInput: tool.input,
    preloaded: tool.childMessages?.length ? tool.childMessages : undefined,
  };
}

/** A lone Agent tool (a call site that renders tools one at a time): still the chip,
 *  never a card — the panel is where an agent is read. */
function TaskGroup({ tool, sessionId }: SessionToolCallProps) {
  const agents = useMemo(() => [knownAgentFromTool(tool)], [tool]);
  if (!sessionId) return null;
  return <BackgroundTasksChip sessionId={sessionId} agents={agents} />;
}

/** One tool call's card, live or saved: both draw it through this one dispatcher,
 *  so a card never changes form when its saved twin takes over (an Edit was a
 *  plain card live and a diff once saved). */
export function SessionToolCall({ tool, assistantLabel, status, sessionId, sessionCwd, sessionHost, onTaskClick, onSessionClick, onFileOpen }: SessionToolCallProps) {
  // Task/Agent tool with childMessages or agentId → its chip. A call still
  // streaming (`liveStatus`, a subagent's lane) is the chip from its first
  // frame, as its saved row will be.
  // How the call is drawn decides its header's words too: the whole-session find
  // counts them with the same function (@open-walnut/tool-header-text).
  const kind = toolCardKind(tool);
  if (kind === 'chip') {
    return <TaskGroup tool={tool} assistantLabel={assistantLabel} sessionId={sessionId} sessionCwd={sessionCwd} sessionHost={sessionHost} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />;
  }

  // ExitPlanMode with plan content → render PlanCard
  if (kind === 'plan') {
    return <PlanCard content={getExitPlanContent(tool) ?? ''} disclosureId={disclosureIds.plan(tool.toolUseId)} sessionId={sessionId} sessionCwd={sessionCwd} sessionHost={sessionHost} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />;
  }

  // Write to plans → collapsed row
  if (kind === 'plan-write') {
    return <CollapsedPlanWrite filePath={tool.input.file_path as string} />;
  }

  // Edit tool with old_string/new_string → render as diff view
  if (kind === 'edit' && typeof tool.input.file_path === 'string'
    && typeof tool.input.old_string === 'string' && typeof tool.input.new_string === 'string') {
    return (
      <EditDiffView
        filePath={tool.input.file_path}
        oldString={tool.input.old_string}
        newString={tool.input.new_string}
        replaceAll={tool.input.replace_all === true}
        status={status === 'error' || (tool as { status?: string }).status === 'error' || (tool as { isError?: boolean }).isError ? 'error' : status === 'calling' ? 'calling' : 'done'}
        result={(tool as { result?: string }).result}
        onViewFile={onFileOpen}
        toolUseId={tool.toolUseId}
      />
    );
  }

  return <GenericToolCall tool={tool} {...(status ? { status } : {})} sessionCwd={sessionCwd} sessionHost={sessionHost} sessionId={sessionId} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />;
}


/**
 * The rows that are not a message bubble: a system line, the interrupt marker
 * and a collapsed CLI-injected context row. `undefined` means "render the
 * bubble". Pure (no hooks), so the dispatcher below can branch on it.
 */
function specialSessionRow({ message }: SessionMessageProps): ReactNode | undefined {
  const { role, text: rawText, timestamp } = message;
  const text = role === 'assistant' ? stripQuestionTag(rawText ?? '') : rawText;
  const time = formatTime(timestamp);
  const isUser = role === 'user';

  // System lines from persisted history (compact boundary, API errors, model
  // substitution notices) — same visual language as the streaming system blocks
  // (session-system-line), never a chat bubble.
  if (role === 'system') {
    // The member's key is for a grouped list; spread into JSX it is a key React warns about.
    const { variant, message: line, detail, time: lineTime } = systemGroupMemberFromHistory(message);
    return <SystemLineCollapsible variant={variant} message={line} detail={detail} time={lineTime} noticeId={message.msgId} />;
  }

  // Interrupt marker — render as muted system banner, not a "You" bubble.
  // Claude CLI writes `[Request interrupted by user]` whenever its
  // AbortController fires without a reason — walnut's health-monitor idle
  // reap triggers it via SIGINT, but it's indistinguishable from a real
  // user-clicked Interrupt. Showing it as a blue "You" bubble is misleading.
  // Both CLI variants: "[Request interrupted by user]" and
  // "[Request interrupted by user for tool use]" (62 of the latter in corpus).
  if (isUser && text && /^\[Request interrupted by user( for tool use)?\]$/.test(text.trim())) {
    return (
      <div className="chat-interrupt-banner">
        <span className="chat-interrupt-text">Turn interrupted</span>
        {time && <span className="chat-interrupt-time">{time}</span>}
      </div>
    );
  }

  // CLI-injected context (skill content dump, compaction summary, image
  // metadata) — the human never typed this. Collapsed row, click to expand.
  // Which lines count lives in injected-context.ts (the timeline folds them too).
  if (isUser && text && injectedContextKind(message)) {
    return <InjectedContextRow text={text} />;
  }

  return undefined;
}

/** Walnut's notes above a person's words, folded; the line counts them (fold-steps.ts). */
function RiderFold({ foldId, segments, children }: { foldId: string; segments: EnvelopeSegment[]; children: ReactNode }) {
  return (
    <ProcessFoldRow foldId={foldId} foldKey={`rider:${foldId === 'rider' ? '' : foldId}`} testId="rider-fold"
      phrase={foldStepsPhrase(envelopeSteps(segments))}>
      {children}
    </ProcessFoldRow>
  );
}

/**
 * A special row and a bubble are two components, so React remounts across the
 * switch instead of running a different number of hooks when a row changes kind
 * (a list keyed by position hands a row another message when earlier history
 * loads). tests/web/hook-order-ratchet.test.ts pins this.
 */
export const SessionMessage = memo(function SessionMessage(props: SessionMessageProps) {
  const special = specialSessionRow(props);
  if (special !== undefined) return special;
  return <SessionMessageBubble {...props} />;
});

function SessionMessageBubble({ message, assistantLabel = 'Claude Code', sessionId, sessionCwd, sessionHost, suppressTools, answerOnly, ridersFolded, trailingFolded, showCopyActions = false, noActions = false, onTaskClick, onSessionClick, onFileOpen }: SessionMessageProps) {
  const { role, text: arrivingText, timestamp, tools: rawTools, thinking } = message;
  // A reply still arriving is this same row (SessionChatHistory draws a stream
  // block as the row its persisted twin will be): its words hold while the
  // person selects inside it, or each delta would rebuild the DOM their
  // selection lives in. A stored row's words never change, so nothing holds.
  const contentRef = useRef<HTMLDivElement | null>(null);
  const rawText = useSelectionFrozenWith(contentRef, arrivingText);
  // A reply's `[Q<n>]` tag names its question (question-tag.ts); the label above
  // the turn shows the number, so the line itself never renders. Nor does the
  // "no action needed" marker line (turn-end-marker.ts): it is for the timeline.
  const text = role === 'assistant' ? stripTurnMarker(stripQuestionTag(rawText ?? '')) : rawText;
  // In Main's or a lead's chat, the tasks a reply is about show under it (message-about.tsx).
  const showAbout = useContext(MessageAboutContext);
  const aboutIds = useMemo(() => (showAbout && role === 'assistant' ? rowAbout(message.about, rawText) : []), [showAbout, role, message.about, rawText]);
  const tools = suppressTools || answerOnly ? undefined : rawTools;
  const time = formatTime(timestamp);
  const isUser = role === 'user';

  // Walnut puts its own notices IN FRONT of the person's words (place note, org
  // digest, routing rules, app state: history-walnut-riders.ts), in the same
  // stored line. The notices are Walnut's and the words are the person's: split
  // the notices off first, so they render as their own card row above the bubble
  // and everything below works on the row without them. A row holding an envelope
  // used to lose its bubble entirely, which drew the person's words on the AI side.
  // Notes the queue put AFTER the words (they came while the line waited) split off the same way.
  const riderSplit = useMemo(() => (isUser && text ? splitRiders(text) : null), [isUser, text]);
  const ownText = riderSplit ? riderSplit.body : text;

  // Walnut sometimes PREPENDS a machine block ("[Conversation context]…") to the
  // message it hands the CLI, so the transcript stores that block inside the
  // human's own turn and the bubble used to open with prose they never typed.
  // Peel the leading blocks off: they fold into disclosure rows above the prose,
  // and everything downstream (envelope parsing, markdown, copy/pin/rewind) then
  // works on the typed text alone. `null` for an ordinary message, so that
  // message takes exactly the path it took before.
  // The ✦ AI search's prompt is machine text too — Walnut's own question plus a
  // seed-row dump — and it arrives in this panel because the search's session is
  // adoptable ("Open as session"). It is not bracket-fenced, so the banner scan
  // cannot find it; recognizing it produces the same split, which leaves the
  // QUERY as the bubble and folds the prompt into one disclosure row.
  const bannerSplit = useMemo(() => {
    if (!isUser || !ownText) return null;
    const split = searchPromptBannerSplit(ownText) ?? splitLeadingBanners(ownText);
    if (!split) return null;
    // The question-number banner (`[Question Q4]`) asks the model for its reply
    // tag; the turn label and the sidebar already show the number, so the
    // bubble drops it rather than folding it (a fold per bubble was the noise
    // the label replaced).
    const banners = split.banners.filter((b) => !QUESTION_BANNER_RE.test(b.name));
    return banners.length === split.banners.length ? split : { ...split, banners };
  }, [isUser, ownText]);
  // A question about a FILE passage opens with ``About `<absolute path>`:``; the
  // bubble shows that path relative to the session's cwd.
  const bodyText = useMemo(() => {
    const body = bannerSplit ? bannerSplit.body : ownText;
    return isUser && body ? shortenFileAboutLine(body, sessionCwd) : body;
  }, [bannerSplit, ownText, isUser, sessionCwd]);
  // The attachments a person sent ride in front of their words as headers
  // naming the saved paths (`[Images attached …]`, `[Files attached …]`): drawn
  // as pictures and file cards above the words instead of as path lists.
  const attachmentSplit = useMemo(() => (isUser && bodyText ? attachmentParts(bodyText) : null), [isUser, bodyText]);
  const shownUserText = attachmentSplit ? attachmentSplit.body : bodyText;

  // …and its ANSWER is a JSON object, usually with the model's own reasoning
  // above it ("Looking at the seed results, I can see strong matches for …" plus
  // a numbered list). Split, don't choose: the words render as words and the
  // object renders as the same rows the ✦ card shows. A reply with no answer
  // object in it (pure narration between searches) parses to null and is
  // untouched.
  const searchAnswer = useMemo(
    () => (!isUser && text ? splitSearchAnswerMessage(text) : null),
    [isUser, text],
  );

  // Detect image paths in assistant text and render inline previews
  const textImagePaths = useMemo(() => {
    if (!text || isUser) return [];
    return findImagePaths(text);
  }, [text, isUser]);

  // A Walnut session envelope (another session's message / reply / notice)
  // renders as a provenance card instead of a wall of blue bubble. Parsing is
  // pure and returns null for anything that is not an envelope, so an ordinary
  // message takes exactly the path it took before.
  const envelopeSegments = useMemo(
    () => (isUser && bodyText ? parseSessionEnvelopes(bodyText) : null),
    [isUser, bodyText],
  );

  // What Walnut added to a person's message (its notes in front, the context it
  // prepended) stays out of the chat unless the person asked to always see it
  // (ui.show_walnut_additions); the footer's "Walnut added N" shows it for this one
  // message (2026-10-29, the user: hidden by default behind a "more", always visible
  // for me). Its message hints are never drawn (2026-11-01, the user: "just remove
  // this, no idea why we need this"): they are for the model, and the session's
  // "Raw input & output" shows them. A row that is only Walnut's (no words of the
  // person) is drawn as it always was: it IS the message there.
  const personWords = !(envelopeSegments || (bannerSplit && !bodyText));
  const alwaysShowAdded = useShowWalnutAdditions();
  const [addedOpen, setAddedOpen] = useRowDisclosure(disclosureIds.added(message.walnutMessageId ?? message.msgId), false);
  const showAdded = alwaysShowAdded || addedOpen;
  const addedCount = !isUser ? 0
    : (personWords ? (riderSplit?.riders.length ?? 0) + (riderSplit?.trailing.length ?? 0) + (bannerSplit && bodyText ? bannerSplit.banners.length : 0) : 0);
  const toggleAdded = useCallback(() => setAddedOpen((o) => !o), []);
  const walnutAdded = useMemo(
    () => (!alwaysShowAdded && addedCount > 0 ? { count: addedCount, open: addedOpen, onToggle: toggleAdded } : undefined),
    [alwaysShowAdded, addedCount, addedOpen, toggleAdded],
  );
  // A step row inside an opened fold (a call, a card sent or received, no words of the
  // person's or its own) is a row, not a message: no copy, pin or time line under it.
  const inFold = useInFoldBody();
  const stepInFold = inFold && !walnutAdded && (isUser ? !personWords : !bodyText?.trim());

  // `<suggest>` action cards in a session's own answer: a session's prose can
  // carry a card just like the Personal AI's — same parser, same invoke endpoint,
  // same persisted receipts. Rendering never depends on how the author learned
  // the syntax.
  // Scope = this message's stable id: `msgId` is the API `message.id` for
  // assistant messages (else the JSONL line uuid), and the SAME id rides the live
  // stream deltas, so a card's receipt key is identical mid-turn and after a
  // reload. User text never parses cards (it renders verbatim).
  const { segments, useSegments } = useSuggestSegments(isUser ? '' : text, message.msgId);

  // Unified click handler for entity ref links + file links in message content
  const handleContentClick = useEntityClickHandler(onTaskClick, onSessionClick, onFileOpen, sessionHost, sessionId);
  // Pictures load from the session's machine (links while unknown); clicks keep onFileOpen.
  const { host: imageHost, images: imagesKnown } = useSessionTextRender({ sessionId, sessionHost, sessionCwd });

  // Subscribe pill titles for the inline renderMarkdownWithRefs below — this
  // component is memoized, so it must re-render itself on label changes.
  useEntityLabelsVersion();

  /**
   * Right-click a transcript row: the same actions as the hover strip
   * (MessageMetaRow), reachable without hunting for a strip that only appears on
   * hover — plus the message id, which is what you need when tracing one message
   * through the logs. Selecting text first still yields the browser's own menu.
   */
  const rowMenu = useContextMenu<void>();
  // A phone has no hover: one quiet "Message actions" button opens this row's
  // menu (copy, pin, rewind) instead of an MD / Rich / pin / time strip under
  // every bubble (N8), which doubled each short message's height.
  const phone = usePhoneLayout();
  const pins = useSessionPinsApi();
  const rewind = useSessionRewindApi();
  const reader = useSessionReader();
  const msgId = message.msgId ?? message.walnutMessageId;
  const rowMenuItems = (): ContextMenuItem[] => {
    // bodyText, not text: copying/pinning a turn must yield what the human typed,
    // never the machine block Walnut prepended to it.
    const hasText = !!bodyText && !!bodyText.trim();
    return [
      { key: 'copy', label: 'Copy message', when: hasText, onSelect: () => { void copyTextRobust(bodyText); } },
      {
        key: 'copy-rich', label: 'Copy as rich text', when: hasText,
        title: 'Keeps formatting when pasted into a doc or email',
        onSelect: () => { void copyRichText(markdownToRichHtml(bodyText), bodyText); },
      },
      {
        key: 'walnut-added', label: addedOpen ? 'Hide what Walnut added' : `Show what Walnut added (${addedCount})`,
        when: !!walnutAdded, onSelect: toggleAdded,
      },
      {
        key: 'read-split', label: 'Read in split', when: !!reader && hasText,
        title: 'This message stays on top while you ask below',
        onSelect: () => reader?.open(contentRef.current ?? null),
      },
      { divider: true },
      {
        key: 'pin', label: pins.isPinned(msgId) ? 'Unpin from outline' : 'Pin to outline', when: !!msgId,
        onSelect: () => pins.toggle({ msgId, role, text: bodyText, timestamp }),
      },
      {
        // Same predicate as the hover strip: only the user's own messages, and
        // only CLI transcript uuids, are rewindable.
        key: 'rewind', label: 'Rewind to here',
        when: rewind.available && isUser && !!msgId && UUID_RE.test(msgId),
        onSelect: () => rewind.request(msgId!, pinLabelFor(bodyText, 'this message')),
      },
      { divider: true },
      {
        // A part of a reply split at its question tags (`<id>~1`) copies the transcript's id.
        key: 'copy-id', label: 'Copy message ID', when: !!msgId, title: msgId?.replace(/~\d+$/, ''),
        onSelect: () => { void copyTextRobust(msgId!.replace(/~\d+$/, '')); },
      },
    ];
  };

  const riderSegments = useMemo(
    () => (riderSplit?.riders.length ? riderSplit.riders.map((envelope) => ({ kind: 'envelope' as const, envelope })) : null),
    [riderSplit],
  );
  const trailSegments = useMemo(
    () => (riderSplit?.trailing.length ? riderSplit.trailing.map((envelope) => ({ kind: 'envelope' as const, envelope })) : null),
    [riderSplit],
  );
  // A host's line under the bubble (user-row-attachments.ts): none outside the browser side panel.
  const attachmentsOf = useContext(UserRowAttachmentsContext);
  const requestedHints = (message as { requestedHints?: Record<string, { arg?: string }> }).requestedHints;
  const attached = isUser && attachmentsOf && personWords ? attachmentsOf({ hints: message.hints, requestedHints, text: bodyText }) : null;

  const row = (
    <div
      className={`session-msg ${envelopeSegments || (bannerSplit && !bodyText) ? 'session-msg-envelope'
        : isUser ? 'session-msg-user' : 'session-msg-assistant'}`}
      onContextMenu={(e) => rowMenu.open(e, undefined)}
    >
      <div className="session-msg-content" ref={contentRef} onClick={handleContentClick}>
        {thinking && !answerOnly && <SessionThinking text={thinking} disclosureId={disclosureIds.thinking(message.msgId)} />}
        {/* Folded machine blocks first, then the human's words — the typed text
            stays the dominant part of the bubble. A turn that was ONLY banners
            drops the bubble chrome entirely (session-msg-envelope above): there is
            no human message there to attribute one to. */}
        {(showAdded || !bodyText) && bannerSplit?.banners.map((banner, i) => (
          <InjectedBannerRow key={`${banner.name}-${i}`} banner={banner} disclosureId={disclosureIds.added(`${message.walnutMessageId ?? message.msgId ?? message.timestamp}-${banner.name}-${i}`)} />
        ))}
        {bodyText && envelopeSegments ? (
          <SessionEnvelopeSegments segments={envelopeSegments} plainSource={PERSON_TEXT} />
        ) : bodyText && searchAnswer ? (
          <>
            {searchAnswer.before && <RichMarkdown text={searchAnswer.before} cwd={sessionCwd} host={imageHost} inlineImages={imagesKnown} scope={message.msgId} />}
            <SearchAnswerCard answer={searchAnswer.answer} onOpenTask={onTaskClick} />
            {searchAnswer.after && <RichMarkdown text={searchAnswer.after} cwd={sessionCwd} host={imageHost} inlineImages={imagesKnown} scope={`${message.msgId ?? ''}:after`} />}
          </>
        ) : bodyText && (useSegments ? (
          <SuggestSegments segments={segments} cwd={sessionCwd} host={imageHost} inlineImages={imagesKnown} scope={message.msgId} />
        ) : isUser ? (
          // The rich path is for MODEL output only. A person's own text goes
          // through plain markdown: pasting a reply back (or quoting an
          // ```html-app fence) must not mount a live widget in their own
          // bubble — that showed up as a stray "building interactive block…"
          // placeholder inside a user message, and it would also make anything
          // they copied off a web page render as DOM rather than as the text
          // they can see they pasted.
          <>
            {attachmentSplit && (
              <MessageAttachments images={attachmentSplit.images} files={attachmentSplit.files} host={sessionHost} {...(onFileOpen ? { onFileOpen } : {})} />
            )}
            {shownUserText && <StableMarkdownBody text={showHintTagsAsTyped(shownUserText)} cwd={sessionCwd} host={imageHost} inlineImages={imagesKnown} />}
          </>
        ) : (
          <RichMarkdown text={bodyText} cwd={sessionCwd} host={imageHost} inlineImages={imagesKnown} scope={message.msgId} />
        ))}
        {bodyText && aboutIds.length > 0 && <MessageAbout ids={aboutIds} />}
        {tools && tools.length > 0 && (() => {
          // CLI content order is prose first, tool_use blocks after — render
          // in that order. Merge consecutive generic tools into one "Ran 3
          // commands, read a file ›" row (Claude Code app style). Special
          // tools (Task/Agent groups, plan cards, plan writes) break the run
          // and render solo.
          const out: React.ReactNode[] = [];
          let run: SessionHistoryTool[] = [];
          const flush = () => {
            if (!run.length) return;
            // Single tools use the same muted row ("Ran a command ›") — one
            // visual language for all generic tool activity, like the iOS app.
            const key = `run-${run[0].toolUseId ?? out.length}`;
            out.push(<ToolRunRow key={key} tools={run} assistantLabel={assistantLabel} sessionId={sessionId} sessionCwd={sessionCwd} sessionHost={sessionHost} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />);
            run = [];
          };
          for (let i = 0; i < tools.length; i++) {
            const t = tools[i];
            if (isMergeableHistoryTool(t)) { run.push(t); continue; }
            flush();
            // A burst of subagents (parallel Agent tool_use blocks) is ONE chip,
            // "5 running tasks", never five rows — the panel lists them.
            if (GROUPABLE_HISTORY_TOOLS.has(t.name) && sessionId) {
              let j = i;
              while (j < tools.length && GROUPABLE_HISTORY_TOOLS.has(tools[j].name)) j++;
              const burst = tools.slice(i, j).map(knownAgentFromTool);
              out.push(<BackgroundTasksChip key={t.toolUseId ?? `agents-${i}`} sessionId={sessionId} agents={burst} />);
              i = j - 1;
              continue;
            }
            out.push(<SessionToolCall key={t.toolUseId ?? `solo-${i}`} tool={t} {...(t.liveStatus ? { status: t.liveStatus } : {})} assistantLabel={assistantLabel} sessionId={sessionId} sessionCwd={sessionCwd} sessionHost={sessionHost} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />);
          }
          flush();
          return out;
        })()}
        <ReplyImageStrip paths={textImagePaths} cwd={sessionCwd} host={imageHost} inlineImages={imagesKnown} />
        {/* Hover strip: copy / pin / rewind / time. Every message gets one (the
            CSS keeps it invisible until the row is hovered); the live tail's last
            reply keeps its actions on screen, which is what showCopyActions has
            always meant. */}
        {noActions || stepInFold ? null : phone ? ((!!bodyText?.trim() || !!msgId) && (
          <button
            type="button"
            className="msg-more-btn"
            aria-label="Message actions"
            aria-haspopup="menu"
            title={timestamp ? new Date(timestamp).toLocaleString() : undefined}
            onClick={(e) => { e.stopPropagation(); rowMenu.open(e, undefined); }}
          >
            <KebabVerticalIcon size={16} />
          </button>
        )) : (
          <MessageMetaRow
            msgId={msgId}
            role={role}
            text={bodyText}
            timestamp={timestamp}
            alwaysVisible={showCopyActions}
            walnutAdded={walnutAdded}
          />
        )}
      </div>
      {attached}
      {rowMenu.state && (
        <ContextMenu
          point={rowMenu.state.point}
          items={rowMenuItems()}
          onClose={rowMenu.close}
          ariaLabel="Message actions"
          testId="session-msg-ctx-menu"
        />
      )}
    </div>
  );
  const leadShown = !!riderSegments && !(personWords && (!showAdded || ridersFolded));
  // The notes after the words: the history places them in the fold of the turn they start
  // (SessionChatHistory `trailingFolded`); drawn here only when it did not.
  // A row with no words of the person shows them as they are: they are the message.
  const trailShown = !!trailSegments && !trailingFolded && (!personWords || showAdded);
  if (!leadShown && !trailShown) return row;
  // Not `.session-msg-content`: that class marks THE message body, which quote
  // pins and passage selection find as the row's first match.
  const cardsOf = (segments: EnvelopeSegment[]) => (
    <div className="session-msg-rider-content" onClick={handleContentClick}>
      <SessionEnvelopeSegments segments={segments} />
    </div>
  );
  // Beside a person's words the notices are not for the reader: one muted
  // "Received a message ›" line, the cards one click away, never a card row of
  // their own (2026-10-25, the user: "the user doesn't care"). Ahead of another
  // envelope the row already sits in a turn's fold, so the cards show as they are.
  const id = msgId ?? timestamp ?? 'rider';
  return (
    <>
      {leadShown && (
        <div className="session-msg session-msg-envelope session-msg-riders" data-testid="session-rider-row">
          {personWords ? (
            <RiderFold foldId={id} segments={riderSegments!}>{cardsOf(riderSegments!)}</RiderFold>
          ) : cardsOf(riderSegments!)}
        </div>
      )}
      {row}
      {trailShown && (
        <div className="session-msg session-msg-envelope session-msg-riders" data-testid="session-rider-row">
          {personWords ? (
            <RiderFold foldId={`${id}:after`} segments={trailSegments!}>{cardsOf(trailSegments!)}</RiderFold>
          ) : cardsOf(trailSegments!)}
        </div>
      )}
    </>
  );
}
