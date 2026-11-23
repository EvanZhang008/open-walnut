/**
 * The training pairs Voice Accuracy keeps for later: every edited take (a dictation the user changed
 * before sending, paired with its send by recording id, sent-text.ts) as one JSON line of its audio,
 * the engine's text and the text sent. Only a message made from one dictation, edited and nothing
 * added, is exported (training-pair.ts says which). Nothing is trained here; the file is for the user to take. Read from the
 * comparison store: the pairs are its entries, never a second copy.
 */
import { compareStore } from './store.js'
import { inUseEngineOf, takeAudioPath } from './takes-source.js'
import { isTrainingPair } from './training-pair.js'

export { isTrainingPair }

export interface TrainingPair {
  id: string
  at: string
  /** Where the recording is on this computer; null when it is no longer kept. */
  audioPath: string | null
  engineText: string
  sentText: string
  engine: string | null
  model: string | null
}

/** Every training pair, newest first, one at a time. */
export async function* trainingPairs(): AsyncGenerator<TrainingPair> {
  for (const take of (await compareStore.all()).filter(isTrainingPair)) {
    const [audio, made] = await Promise.all([takeAudioPath(take.audioRef).catch(() => null), inUseEngineOf(take.audioRef).catch(() => ({}) as { engine?: string; model?: string })])
    yield {
      id: take.id, at: take.at, audioPath: audio?.path ?? null,
      engineText: take.inUseText!, sentText: take.sentText!,
      engine: made.engine ?? null, model: made.model ?? null,
    }
  }
}
