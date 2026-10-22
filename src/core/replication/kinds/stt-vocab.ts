/**
 * The `stt-vocab` copy kind (stage 4d of docs/plan/walnut-companion-unified-replica.md):
 * the Mac's custom speech vocabulary (config/share/stt-vocab.txt, core/stt/vocab.ts)
 * as one row of its words, in `cache/replica/stt-vocab.json` (file-copy.ts), never the
 * live file. The companion transcribes with its own engine whenever the Mac does not
 * take the audio, and answers the vocabulary reads the Mac did not: both read this copy
 * once it is held (core/stt/index.ts loadVocabPrompt, routes/stt.ts readSttVocab), and a
 * word added there needs the Mac (`stt_vocab_writes_need_mac`): the copy is the Mac's, so
 * a word written to the box's own file would never show. Before the first round (an
 * older Mac) the box reads and writes its own file, as before.
 *
 * One row, `vocab` -> `{words}`: the file's words without its comments (the readers' own
 * rule, vocabWords), at most MAX_WORDS of at most MAX_WORD_LEN characters each, a
 * secret-shaped word left out (the follower checks again). A file the Mac cannot read
 * (not a missing one: that is no words) throws, so the round skips the kind. Rides the
 * `config` choice: the vocabulary is one of the user's settings. Unordered, no digest,
 * floor 0 (the one row is never removed).
 */

import fsp from 'node:fs/promises'
import { STT_VOCAB_FILE } from '../../../constants.js'
import { onSttVocabWritten, vocabWords } from '../../stt/vocab.js'
import { secretShapedValue } from '../config-allowlist.js'
import { sha12 } from '../kind.js'
import type { CopyKind } from './copy-kind.js'
import { createFileCopy } from './file-copy.js'
import { copyKindAsOf, keepsCopies } from './gate.js'

export const STT_VOCAB_SCHEMA_VERSION = 1
export const STT_VOCAB_REMOVAL_FLOOR = 0
const KEY = 'vocab'
const MAX_WORDS = 2_000
const MAX_WORD_LEN = 200

export interface SttVocabRow { key: 'vocab'; words: string[] }

function wordOk(w: unknown): w is string {
  return typeof w === 'string' && w.length > 0 && w.length <= MAX_WORD_LEN && w === w.trim() && !w.includes('\n') && secretShapedValue(w) === null
}

async function leaderRows(): Promise<SttVocabRow[]> {
  // The one-time move out of the data dir's root, as every other reader of the file runs it first.
  await (await import('../../stt/index.js')).ensureSttVocabMigrated()
  let raw = ''
  try {
    raw = await fsp.readFile(STT_VOCAB_FILE, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw err
  }
  return [{ key: KEY, words: vocabWords(raw).filter(wordOk).slice(0, MAX_WORDS) }]
}

export const STT_VOCAB_KIND: CopyKind<SttVocabRow> = {
  kind: 'stt-vocab',
  schemaVersion: STT_VOCAB_SCHEMA_VERSION,
  key: (r) => r.key,
  // The follower's own hash of a put row (kind-follower.ts): the same, so a held row is never sent again.
  hash: (r) => sha12(JSON.stringify(r)),
  ordered: false,
  digest: false,
  choice: 'config',
  rows: leaderRows,
  watch: (soon) => onSttVocabWritten(soon),
}

// --- Follower ---

function isRow(v: unknown): v is SttVocabRow {
  const r = v as Record<string, unknown> | null
  return !!r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length === 2 && r.key === KEY
    && Array.isArray(r.words) && r.words.length <= MAX_WORDS && r.words.every((w) => typeof w === 'string')
}

const copy = createFileCopy<SttVocabRow>({
  kind: 'stt-vocab',
  schemaVersion: STT_VOCAB_SCHEMA_VERSION,
  label: 'speech vocabulary copy',
  removalFloor: STT_VOCAB_REMOVAL_FLOOR,
  isRow,
  key: (r) => r.key,
  admit: (r) => r.words.every(wordOk),
})

export const sttVocabFollower = copy.follower

/**
 * The Mac's words and when they were the Mac's, where this server keeps the copy and
 * holds it (the companion, a host replica); null anywhere else, and before the first
 * round, so the caller reads this server's own file.
 */
export async function readSttVocabCopy(): Promise<{ words: string[]; asOf: number } | null> {
  if (!keepsCopies('stt-vocab')) return null
  const asOf = await copyKindAsOf('stt-vocab')
  if (asOf === null) return null
  const rows = await copy.read()
  if (!rows) return null
  return { words: rows[KEY]?.words ?? [], asOf }
}

/** Tests only. */
export function _resetSttVocabCopyForTesting(): void {
  copy.reset()
}
