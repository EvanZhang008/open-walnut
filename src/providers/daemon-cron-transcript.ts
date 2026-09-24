import fsp from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import { computeCliLoadedChain, type TranscriptChainLine } from '../core/transcript-chain.js'
import { createCliTranscriptPrefilter } from '../core/transcript-chain-prefilter.js'

export interface CronRestoreConfig {
  enabled: boolean
  recurringMaxAgeMs: number
  oneShotMaxMs: number
  oneShotFloorMs: number
  oneShotMinuteMod: number
}

export const DEFAULT_CRON_RESTORE_CONFIG: CronRestoreConfig = {
  enabled: true,
  recurringMaxAgeMs: 604800000,
  oneShotMaxMs: 90000,
  oneShotFloorMs: 0,
  oneShotMinuteMod: 30,
}

export interface CronTranscriptLine extends TranscriptChainLine {
  cronCalls?: Array<{ toolUseId: string; cron: string; hasPrompt: boolean }>
  cronDeletes?: string[]
  cronResults?: Array<{ toolUseId: string; id?: string; durable: boolean; recurring: boolean }>
}

export interface CronRestoreFacts {
  status: 'active' | 'inactive' | 'unknown'
  ids: string[]
  reason: string | null
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
}

export function slimCronTranscriptLine(raw: Record<string, unknown>): CronTranscriptLine {
  const line: CronTranscriptLine = {}
  for (const key of ['type', 'subtype', 'uuid', 'timestamp'] as const) {
    if (typeof raw[key] === 'string') line[key] = raw[key]
  }
  if (typeof raw.parentUuid === 'string' || raw.parentUuid === null) line.parentUuid = raw.parentUuid
  if (typeof raw.isSidechain === 'boolean') line.isSidechain = raw.isSidechain
  if (raw.type === 'last-prompt') {
    if (typeof raw.leafUuid === 'string' || raw.leafUuid === null) line.leafUuid = raw.leafUuid
    if (raw.explicit === true) line.explicit = true
  }
  const attachment = object(raw.attachment)
  if (raw.type === 'attachment' && typeof attachment?.type === 'string') line.attachment = { type: attachment.type }
  const segment = object(object(raw.compactMetadata)?.preservedSegment)
  if (segment) {
    line.compactMetadata = { preservedSegment: {} }
    for (const key of ['headUuid', 'anchorUuid', 'tailUuid'] as const) {
      if (typeof segment[key] === 'string') line.compactMetadata.preservedSegment![key] = segment[key]
    }
  }
  const preserved = object(object(raw.compactMetadata)?.preservedMessages)
  if (preserved) {
    if (typeof preserved.anchorUuid !== 'string' || !Array.isArray(preserved.uuids)
      || preserved.uuids.some((uuid) => typeof uuid !== 'string')) throw new Error('Invalid preserved transcript list')
    line.compactMetadata ??= {}
    line.compactMetadata.preservedMessages = { anchorUuid: preserved.anchorUuid, uuids: [...preserved.uuids] }
  }
  const message = object(raw.message)
  if (!message) return line
  const blocks = Array.isArray(message.content) ? message.content.map(object).filter((v) => v !== null) : []
  line.message = {
    ...(typeof message.id === 'string' ? { id: message.id } : {}),
    content: blocks.map((b) => ({ type: typeof b.type === 'string' ? b.type : '' })),
  }
  if (line.type === 'assistant') {
    for (const block of blocks) {
      if (block.type !== 'tool_use') continue
      const input = object(block.input)
      if (block.name === 'CronCreate' && typeof block.id === 'string' && input) {
        if (typeof input.cron === 'string') {
          (line.cronCalls ??= []).push({ toolUseId: block.id, cron: input.cron, hasPrompt: typeof input.prompt === 'string' })
        }
      } else if (block.name === 'CronDelete' && typeof input?.id === 'string') {
        (line.cronDeletes ??= []).push(input.id)
      }
    }
  } else if (line.type === 'user') {
    const result = object(raw.toolUseResult)
    if (result) {
      for (const block of blocks) {
        if (block.type === 'tool_result' && !block.is_error && typeof block.tool_use_id === 'string') {
          (line.cronResults ??= []).push({
            toolUseId: block.tool_use_id, ...(typeof result.id === 'string' ? { id: result.id } : {}),
            durable: result.durable === true, recurring: result.recurring !== false,
          })
        }
      }
    }
  }
  return line
}

export function collectCronRestoreFacts(
  lines: readonly CronTranscriptLine[],
  config: CronRestoreConfig,
  now: number,
  oneShotTime: (cron: string, createdAt: number, id: string, config: CronRestoreConfig) => number | null,
): CronRestoreFacts {
  if (!config.enabled) return { status: 'inactive', ids: [], reason: 'cron-disabled' }
  const loaded = computeCliLoadedChain(lines)
  if (loaded.clearedToEmpty) return { status: 'inactive', ids: [], reason: 'cli-cleared' }
  if (loaded.leafUuid === null) return { status: 'unknown', ids: [], reason: 'no-resumable-chain' }
  const byUuid = new Map(lines.filter((line) => typeof line.uuid === 'string').map((line) => [line.uuid!, line]))
  const calls: Array<{ toolUseId: string; cron: string; hasPrompt: boolean; createdAt: number }> = []
  const results = new Map<string, NonNullable<CronTranscriptLine['cronResults']>[number]>()
  const deleted = new Set<string>()
  for (const uuid of loaded.chain) {
    const line = byUuid.get(uuid)!
    for (const call of line.cronCalls ?? []) calls.push({ ...call, createdAt: Date.parse(line.timestamp ?? '') })
    for (const result of line.cronResults ?? []) results.set(result.toolUseId, result)
    // CLI resume collects deletions from the call input, so a cron stays deleted even when CronDelete returned an error.
    for (const id of line.cronDeletes ?? []) deleted.add(id)
  }
  const ids: string[] = []
  for (const call of calls) {
    const result = results.get(call.toolUseId)
    if (!result || result.id === undefined || result.durable || deleted.has(result.id) || !call.hasPrompt) continue
    if (!Number.isFinite(call.createdAt)) return { status: 'unknown', ids: [], reason: 'invalid-cron-timestamp' }
    if (result.recurring) {
      if (config.recurringMaxAgeMs !== 0 && now - call.createdAt >= config.recurringMaxAgeMs) continue
    } else {
      const fireAt = oneShotTime(call.cron, call.createdAt, result.id, config)
      if (fireAt === null || fireAt < now) continue
    }
    ids.push(result.id)
  }
  return { status: ids.length ? 'active' : 'inactive', ids, reason: null }
}

export async function readCronTranscript(
  jsonlPath: string,
  signal: AbortSignal,
  disablePrecompactSkip = false,
): Promise<CronTranscriptLine[]> {
  signal.throwIfAborted()
  const file = await fsp.open(jsonlPath, 'r')
  try {
    const before = await file.stat()
    const prefilter = createCliTranscriptPrefilter(before.size, disablePrecompactSkip)
    const lines: CronTranscriptLine[] = []
    const window = Buffer.alloc(64 * 1024)
    let parts: Buffer[] = []
    let offset = 0
    while (offset < before.size) {
      signal.throwIfAborted()
      const { bytesRead } = await file.read(window, 0, Math.min(window.length, before.size - offset), offset)
      if (!bytesRead) throw new Error('Transcript changed during cron observation')
      offset += bytesRead
      let start = 0
      for (let end = 0; end < bytesRead; end++) {
        if (window[end] !== 10) continue
        const piece = window.subarray(start, end)
        const bytes = parts.length ? Buffer.concat([...parts, piece]) : piece
        const text = bytes.toString('utf8')
        parts = []
        start = end + 1
        if (!text.trim()) continue
        const parsed: unknown = JSON.parse(text)
        const raw = object(parsed)
        if (!raw || Array.isArray(parsed)) throw new Error('Invalid transcript line')
        prefilter.push(bytes, raw, lines.length)
        lines.push(slimCronTranscriptLine(raw))
      }
      if (start < bytesRead) parts.push(Buffer.from(window.subarray(start, bytesRead)))
      await setImmediate(undefined, { signal })
    }
    signal.throwIfAborted()
    const after = await fsp.stat(jsonlPath)
    if (parts.length || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('Transcript changed during cron observation')
    }
    return prefilter.apply(lines)
  } finally {
    await file.close()
  }
}
