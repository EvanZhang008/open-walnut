/**
 * ACP projector output → Walnut session events.
 *
 * AcpJournalProjector is the sole ACP grammar/identity implementation. This
 * module only maps its provider-neutral events onto the existing bus contract.
 */

import {
  AcpJournalProjector,
  type AcpProjectedEvent,
} from './acp-journal-projector.js'
import type { JournalRecord } from './acp-worker/protocol.js'

export interface NormalizedEvent {
  name:
    | 'session:text-delta'
    | 'session:thinking-delta'
    | 'session:tool-use'
    | 'session:tool-result'
    | 'session:result'
    | 'session:error'
    | 'session:permission-request'
    | 'session:permission-resolved'
    | 'session:system-event'
    | 'session:usage-update'
  payload: Record<string, unknown>
}

export class AcpStreamNormalizer {
  /** The answer so far: the turn's text after its last tool call. */
  private answer = ''

  constructor(private readonly projector: AcpJournalProjector) {}

  normalize(record: JournalRecord): NormalizedEvent[] {
    // A resume replays the whole past conversation: none of it is this turn's answer.
    const replay = record.kind === 'acp' && record.source === 'provider-replay'
    return this.projector.project(record).flatMap((event) => {
      if (replay) return normalizeProjectedEvent(event)
      // `session:result` carries the turn's final answer, as Claude Code's own
      // result does: the text the agent wrote after its last tool call. An ACP
      // turn end names no text, so it is collected here. 2026-10-30: every lane
      // turn on OpenCode (Ask Walnut, routines) stored an empty reply, because
      // lane-turn.ts reads its answer from this field.
      if (event.type === 'user') this.answer = ''
      else if (event.type === 'text') this.answer += event.text
      else if (event.type === 'tool-use') this.answer = ''
      // A provider retry replaces what it had written and streams the answer again.
      else if (event.type === 'system' && event.replacesMsgId) this.answer = ''
      else if (event.type === 'result') {
        const result = this.answer.trim()
        this.answer = ''
        return normalizeProjectedEvent(event).map((e) => ({ ...e, payload: { ...e.payload, result } }))
      }
      return normalizeProjectedEvent(event)
    })
  }
}

/**
 * Compatibility helper for isolated one-record callers. Stateful live/history
 * paths must retain an AcpStreamNormalizer instance across records.
 */
export function normalizeJournalRecord(
  record: JournalRecord,
  projector = new AcpJournalProjector('legacy'),
): NormalizedEvent[] {
  return projector.project(record).flatMap(normalizeProjectedEvent)
}

function normalizeProjectedEvent(event: AcpProjectedEvent): NormalizedEvent[] {
  switch (event.type) {
    case 'text':
      return [{
        name: 'session:text-delta',
        payload: { delta: event.text, msgId: event.msgId },
      }]
    case 'thinking':
      return [{
        name: 'session:thinking-delta',
        payload: { delta: event.text, msgId: event.msgId },
      }]
    case 'tool-use':
      return [{
        name: 'session:tool-use',
        payload: {
          toolName: event.toolName,
          toolUseId: event.toolUseId,
          input: event.input,
        },
      }]
    case 'tool-result':
      return [{
        name: 'session:tool-result',
        payload: {
          toolUseId: event.toolUseId,
          result: event.result,
          isError: event.isError,
        },
      }]
    case 'permission-request':
      return [{
        name: 'session:permission-request',
        payload: {
          requestId: event.requestId,
          toolName: event.toolName,
          input: event.input,
          acpOptions: event.options,
        },
      }]
    case 'permission-resolved':
      return [{
        name: 'session:permission-resolved',
        payload: {
          requestId: event.requestId,
          allowed: event.allowed,
          // Withdrawn ≠ denied: server.ts's task-phase pullback and the feed
          // stamp both branch on this flag (a bare allowed:false would record
          // an auto-cancel as the human's "Denied" and wrongly resume the row).
          ...(event.cancelled ? { cancelled: true } : {}),
        },
      }]
    case 'usage':
      return [{
        name: 'session:usage-update',
        // Spoken in the Claude event's vocabulary too, so the composer's
        // context badge reads an ACP session the same way.
        payload: {
          used: event.used,
          size: event.size,
          inputTokens: event.used,
          ...(event.size > 0 ? { contextWindow: event.size, contextPercent: Math.round(event.used / event.size * 100) } : {}),
        },
      }]
    case 'system':
      return [{
        name: 'session:system-event',
        payload: {
          variant: event.variant,
          message: event.message,
          msgId: event.msgId,
          uuid: event.msgId,
          ...(event.detail ? { detail: event.detail } : {}),
          ...(event.replacesMsgId ? { replacesMsgId: event.replacesMsgId } : {}),
        },
      }]
    case 'error':
      return [{
        name: 'session:error',
        payload: {
          error: event.error,
          errorKind: 'provider_error',
          msgId: event.msgId,
        },
      }]
    case 'result':
      return [{
        name: 'session:result',
        payload: {
          result: '',
          isError: false,
          stopReason: event.stopReason,
          commandId: event.commandId,
        },
      }]
    case 'user':
      // The optimistic queue bubble is the live user representation. The
      // durable user message appears through history projection after refresh.
      return []
    default:
      return []
  }
}
