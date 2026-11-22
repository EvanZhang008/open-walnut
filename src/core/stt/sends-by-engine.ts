/**
 * What each speech-to-text engine sends off this computer when it hears a take:
 * `audio` for an engine that uploads it to a cloud service, `nothing` for one
 * that runs here (a local process, or a daemon on 127.0.0.1). Typed over every
 * engine name in the config, so a new engine must say which it is: Voice
 * Accuracy asks for consent before it re-hears takes with one that uploads.
 * Kept apart from index.ts so reading it loads no engine.
 */
import type { Config } from '../types.js'

export type SttEngineName = NonNullable<NonNullable<Config['stt']>['engine']>

export const STT_ENGINE_SENDS: Readonly<Record<SttEngineName, 'nothing' | 'audio'>> = {
  qwen: 'nothing',
  'sherpa-onnx': 'nothing',
  openai: 'audio',
  'whisper-cpp': 'nothing',
  'whisper-server': 'nothing',
  mlx: 'nothing',
}
