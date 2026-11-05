/**
 * Whether this server may run voice: start, adopt or talk to a local speech
 * process (the ASR daemons, whisper-cli, the in-process sherpa model, the
 * transcript cleanup daemon), or record on this machine (the microphone through
 * ffmpeg, system audio through ScreenCaptureKit).
 *
 * An isolated server does none of it unless asked: the test runner, an
 * ephemeral child, a data home in a temp dir or a task dir, a HOME that is not
 * the account's own (the rule search uses for its model, semantic-default.ts,
 * with WALNUT_SEARCH_V2_SEMANTIC ignored, as auto-setup.ts reads it). Such a
 * server would load a model of gigabytes next to the user's own server, adopt
 * the warm daemon that server keeps on its shared port, or start recording the
 * user's Mac from a recording state its copied data home carries (2026-11-05: an
 * isolated test server whose data home was a task directory started the speech
 * daemon because the Mac already had the model). WALNUT_STT_AUTO_SETUP=1 opts one
 * in; WALNUT_STT_AUTO_SETUP=0 only stops the install and never turns voice off on
 * the user's own server.
 *
 * An opted-in server runs voice exactly as the user's own does, the warm daemons
 * on the shared ports included: it adopts them, retires one loaded for another
 * model, and shuts one down when its own voice config changes. Give it its own
 * stt.mlx_port and stt.cleanup_port (WALNUT_STT_LLAMA_PORT for llama-server) to
 * keep it apart.
 *
 * Every function that spawns or adopts such a process, loads a model or opens a
 * recording asks here first (tests/core/stt-voice-here-ratchet.test.ts finds
 * them in the source). Sync and cheap: semantic-default.ts memoizes the paths.
 */

import { IS_EPHEMERAL, WALNUT_HOME } from '../../constants.js';
import { semanticLaneDecision, type SemanticLaneInputs, type SemanticLaneReason } from '../search/semantic-default.js';

/** Why a server is a throwaway one. */
export type VoiceIsolation = Exclude<SemanticLaneReason, 'opt-in' | 'opt-out' | 'default'>;

const ISOLATION_WORDS: Record<VoiceIsolation, string> = {
  'test-runner': 'the test runner',
  ephemeral: 'an ephemeral server',
  'temp-home': 'its data home is in a temp directory',
  'task-dir': 'its data home is in a task directory',
  'fake-home': "HOME is not the account's own",
};

let isolationForTest: VoiceIsolation | null | undefined;

/** Test hook: pretend this server is (a reason) or is not (null) isolated; undefined reads the process again. */
export function _setVoiceIsolationForTest(isolation: VoiceIsolation | null | undefined): void {
  isolationForTest = isolation;
}

/**
 * Why a server with these facts is isolated, or null when it is the user's own.
 * The search model's switch plays no part: a person who turned semantic search
 * off (or on) for their server changed nothing about voice.
 */
export function isolationOf(inputs: SemanticLaneInputs): VoiceIsolation | null {
  // Getters, not a spread: a spread would read them, and the test runner is
  // decided before either is needed (a test's mocked constants need not carry them).
  const decision = semanticLaneDecision({
    env: { ...inputs.env, WALNUT_SEARCH_V2_SEMANTIC: undefined },
    get isEphemeral() { return inputs.isEphemeral; },
    get walnutHome() { return inputs.walnutHome; },
    tmpRoots: inputs.tmpRoots,
    taskDirRoots: inputs.taskDirRoots,
    accountHome: inputs.accountHome,
  });
  return decision.on ? null : decision.reason as VoiceIsolation;
}

/** Why this server is isolated, or null when it is the user's own. */
export function isolatedHere(): VoiceIsolation | null {
  if (isolationForTest !== undefined) return isolationForTest;
  return isolationOf({
    env: process.env,
    get isEphemeral() { return IS_EPHEMERAL; },
    get walnutHome() { return WALNUT_HOME; },
  });
}

/** The sentence a person reads when voice is off here, or null when it may run. */
export function voiceOffReason(isolation: VoiceIsolation | null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!isolation || env.WALNUT_STT_AUTO_SETUP === '1') return null;
  return `Voice is off on this isolated server (${ISOLATION_WORDS[isolation]}), so it starts no speech process and records nothing. ` +
    'Start the server with WALNUT_STT_AUTO_SETUP=1 to turn voice on here.';
}

/** Null when this server may run voice, else why not. */
export function voiceOffHere(): string | null {
  if (process.env.WALNUT_STT_AUTO_SETUP === '1') return null;
  return voiceOffReason(isolatedHere());
}

/** Voice was asked of a server that runs none. */
export class VoiceOffHereError extends Error {
  readonly code = 'voice_off_here';
  constructor(message: string) {
    super(message);
    this.name = 'VoiceOffHereError';
  }
}

/** Throws VoiceOffHereError unless this server may run voice. */
export function assertVoiceHere(): void {
  const off = voiceOffHere();
  if (off) throw new VoiceOffHereError(off);
}
