/**
 * The kanban's shared contract: the names every kanban component, hook and
 * test agrees on (modes, chips, write / filter / seen / toast APIs, component
 * props). Types and constants only; the view models live in kanban-*-model.ts.
 */
import type { RefObject } from 'react';
import type { ProjectOf } from '../board-view-projects';
import type { BoardLane } from '../../../../../src/core/boards/board-lanes';
import type { BoardKanbanSeen, BoardKanbanSeenCard } from '../board-model';
import type { DeletePreview } from '../../../../../src/core/boards/board-lanes';
import type { KanbanCardVM } from './kanban-card-model';
import type { KanbanBoardVM, KanbanLaneVM, KanbanLeaderVM } from './kanban-model';

/** Wide = lanes side by side; narrow = lanes as foldable sections (pane < 600px, back at >= 624px). */
export type KanbanMode = 'wide' | 'narrow';
export const KANBAN_NARROW_BELOW = 600;
export const KANBAN_WIDE_FROM = 624;
/** Below this pane width, opening the Board tab collapses the chat. */
export const KANBAN_COLLAPSE_CHAT_BELOW = 480;

export type KanbanChipId = 'needs' | 'sev1' | 'stale' | 'changed' | 'running';
/** Chip order in the filter row ('sev1' shows only when the team has more than one sev value). */
export const KANBAN_CHIP_ORDER: readonly KanbanChipId[] = ['needs', 'sev1', 'stale', 'changed', 'running'];
/** What a filter can be: a chip, or the rollup's "task still open" button. */
export type KanbanFilterKey = KanbanChipId | 'still-open';

export const READ_ONLY_TITLE = 'Boards are edited on the Mac';

/** Done lanes show this many cards until `Show all N`. */
export const DONE_LANE_PREVIEW = 5;
/** No progress for this long = stale. */
export const STALE_AFTER_MS = 48 * 3_600_000;

export interface KanbanToastAction {
  label: string;
  testId?: string;
  run: () => void | Promise<void>;
}

export interface KanbanToast {
  id?: string;
  text: string;
  tone?: 'info' | 'error';
  actions?: KanbanToastAction[];
  /** Default 8000. */
  ttlMs?: number;
}

export interface KanbanToastApi {
  push(t: KanbanToast): string;
  dismiss(id: string): void;
}

export type SetCardResult =
  | { ok: true }
  | { ok: false; conflict: { current: string; at: string; by: string } }
  | { ok: false; error: string };

export interface KanbanCardPatch {
  summary?: string;
  waiting_on?: string;
  /** '' = back to the automatic lane. */
  lane?: string;
}

export interface KanbanMoveOptions {
  /** Position in the target lane's full display order (default: top). */
  index?: number;
  /** A reorder inside the lane: rank only, placement untouched. */
  rankOnly?: boolean;
  /** For the log line and the toast ('drag', 'menu', 'keyboard', 'accept', 'undo'). */
  reason?: string;
}

export interface KanbanWriteApi {
  readOnly: boolean;
  saveLanes(next: BoardLane[]): Promise<boolean>;
  moveCard(taskId: string, lane: string, opts?: KanbanMoveOptions): Promise<boolean>;
  setCard(taskId: string, patch: KanbanCardPatch, ifUnchangedSince?: string): Promise<SetCardResult>;
  addTask(laneId: string, title: string, tags: string[]): Promise<{ ok: true; taskId: string } | { ok: false; error: string }>;
  completeTask(taskId: string): Promise<boolean>;
  reopenTask(taskId: string): Promise<boolean>;
  answerSuggestion(taskId: string, action: 'accept' | 'dismiss'): Promise<boolean>;
}

export interface KanbanFilterApi {
  chip: KanbanFilterKey | null;
  query: string;
  /** A chip or a query is on. */
  active: boolean;
  toggleChip(chip: KanbanFilterKey): void;
  setChip(chip: KanbanFilterKey | null): void;
  setQuery(q: string): void;
  isVisible(taskId: string): boolean;
  /** Matched when the chip was turned on, no longer matches (G13): shown at 50% with `Handled`. */
  isHandled(taskId: string): boolean;
  /** The centre line when the active chip's live count is 0 ('' otherwise). */
  emptyText: string;
  showStillOpen(): void;
  /** One board project's cards only (its id), intersected with the chip and the search; null = every card. */
  project: string | null;
  /** The filtered project's title, '' with none. */
  projectTitle: string;
  setProject(projectId: string | null): void;
}

export interface KanbanSeenApi {
  baseline: BoardKanbanSeen | null;
  baselineAt: string | null;
  previousAt: string | null;
  markCardSeen(taskId: string): void;
  markAllSeen(): void;
}

/** A session prompt the card answers in place (G3); fromTaskId / fromTitle when it is a nested worker's. */
export interface KanbanPromptRequest {
  sessionId: string;
  requestId?: string;
  toolName: string;
  detail?: string;
  fromTaskId?: string;
  fromTitle?: string;
}

// ── Component props ──

export interface KanbanHeaderProps {
  board: KanbanBoardVM;
  filter: KanbanFilterApi;
  seen: KanbanSeenApi;
  mode: KanbanMode;
  ownerId: string;
  onJumpToLane(laneId: string): void;
  onRevealCard(taskId: string): void;
  onOpenTask(taskId: string): void;
  searchRef?: RefObject<HTMLInputElement | null>;
}

export interface KanbanLaneHeadProps {
  lane: KanbanLaneVM;
  lanes: readonly BoardLane[];
  index: number;
  mode: KanbanMode;
  folded: boolean;
  onToggleFold(): void;
  /** Cards shown under the active filter (`2 / 6`); undefined = no filter. */
  shown?: number;
  api: KanbanWriteApi;
  flashing: boolean;
  deletePreview(laneId: string): DeletePreview;
}

export interface KanbanAddLaneProps {
  lanes: readonly BoardLane[];
  mode: KanbanMode;
  api: KanbanWriteApi;
  onAdded(laneId: string): void;
}

export interface KanbanCardPromptProps {
  request: KanbanPromptRequest;
  onAnswered(): void;
}

export interface KanbanLeaderRowProps {
  leader: KanbanLeaderVM;
  onOpenTask(taskId: string): void;
}

export interface KanbanCardEditorProps {
  field: 'summary' | 'waiting_on';
  card: KanbanCardVM;
  /** The field's `*_at` when the editor opened (G31 conflict check). */
  openedAt: string | undefined;
  api: KanbanWriteApi;
  onClose(): void;
}

export interface KanbanCardComposerProps {
  card: KanbanCardVM;
  onSent(): void;
  onClose(): void;
}

export interface KanbanCardStartProps {
  card: KanbanCardVM;
  leader: { taskId: string; title: string; sessionId?: string };
  laneName: string;
}

export interface KanbanToastsProps {
  toasts: ReadonlyArray<KanbanToast & { id: string }>;
  onDismiss(id: string): void;
}

// ── Hook types ──

export type UseKanbanFilter = (board: KanbanBoardVM, projectOf?: ProjectOf) => KanbanFilterApi;
export type UseKanbanSeen = (
  ownerId: string,
  payload: { kanban_seen: BoardKanbanSeen | null } | null,
  opts: { visible: boolean; getSnapshot: () => Record<string, BoardKanbanSeenCard> },
) => KanbanSeenApi;
export type UseKanbanToasts = () => KanbanToastApi & { list: ReadonlyArray<KanbanToast & { id: string }> };
