/**
 * Every kind of row the session timeline draws, and the element that is its line
 * (or its two lines). One rule holds for all of them (step-rows.css, "One line, or
 * two"): line one is the icon, the name or who, the title and the chevron; line
 * two, when there is one, is its summary or answer alone, under the text after
 * the icon; each is cut with an ellipsis and nothing wraps in a column beside the
 * title, open or closed (2026-11-11, the user: "if 1 line just 1 line, if 2 line
 * just have the title in one and detail or summary in next", "same for all the
 * tools box").
 *
 * tests/e2e/browser/step-row-lines.spec.ts draws one row of each kind here and
 * measures its lines; tests/web/step-row-kinds.test.ts fails when a kind here has
 * no row in that spec. The tool and envelope lists are typed over their unions,
 * so a new card kind or envelope kind does not type-check until it is listed.
 */
import type { ToolCardKind } from '@open-walnut/tool-header-text';
import type { SessionEnvelopeKind } from '@open-walnut/history-session-envelope';

/** A call's row, by how it is drawn (tool-header-text.ts toolCardKind). */
export const TOOL_ROW_LINES = {
  chip: '.bg-tasks-chip',
  plan: '.session-plan-card-header',
  'plan-write': '.session-plan-write-muted',
  edit: '.chat-tool-block > .chat-tool-block-header',
  bash: '.chat-tool-block-bash > .chat-tool-block-header',
  generic: '.chat-tool-block > .chat-tool-block-header',
} as const satisfies Record<ToolCardKind, string>;

/** A message received, by its envelope kind (the card, its opened detail left out). */
export const ENVELOPE_ROW_LINES = {
  reply: '.provenance-card[data-envelope-kind="reply"]',
  'peer-note': '.provenance-card[data-envelope-kind="peer-note"]',
  notification: '.provenance-card[data-envelope-kind="notification"]',
  'reply-request': '.provenance-card[data-envelope-kind="reply-request"]',
  trigger: '.provenance-card[data-envelope-kind="trigger"]',
  'app-state': '.provenance-card[data-envelope-kind="app-state"]',
} as const satisfies Record<SessionEnvelopeKind, string>;

/** Every other row: a message sent, the runtime's lines, reasoning, words, folds. */
export const OTHER_ROW_LINES = {
  /** A message sent (a send, a reply, a letter, a thread or Brief write). */
  sent: '.provenance-card[data-envelope-kind="outbound"]',
  /** A run of calls (or a long one) on its own line, with the answers it got. */
  run: '.tool-run-row:not(.tool-run-row--step):not(.tool-run-flat) > .tool-run-toggle',
  /** Reasoning alone. */
  thinking: '.tool-run-row--step > .tool-run-toggle',
  /** The session's words on the way, folded. */
  words: '.tool-run-row--words > .tool-run-toggle',
  /** A line the runtime wrote (an API error, a retry, a compaction). */
  system: '.session-system-line, .tool-run-row > .tool-run-toggle',
  /** Context the CLI put in (a loaded skill). */
  context: '.tool-run-row > .tool-run-toggle',
  /** A finished turn's fold line, and a running turn's. */
  fold: '.process-fold > .tool-run-toggle',
  /** A step that stopped on the person, above its fold. */
  lifted: '.step-lifted',
} as const;

/** The parts of a row that are its opened detail, never its line. */
export const ROW_DETAIL_PARTS = '.op-card-detail, .chat-tool-block-body, .tool-run-body, .process-fold-body, .session-plan-card-body, .session-system-detail';
