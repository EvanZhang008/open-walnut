/**
 * The shared fixture server (test-server.ts) for stt-install.spec.ts, the one spec that really
 * installs Whisper (WALNUT_STT_REAL_INSTALL=1, the weekly nightly job). The spec ends on the
 * model rows, which show only once the engine answers, and a test server runs no voice
 * (src/core/stt/voice-here.ts): on 2026-11-10 (run 42810680950) the setup finished and its row
 * stayed. So that run turns voice on, with Whisper already chosen so the boot installs no Qwen
 * beside it, on ports of its own so it never adopts a speech daemon of the machine's.
 * tests/core/stt-real-install-fixture.test.ts checks those premises against the real rules.
 */
export const REAL_VOICE_STT = { engine: 'whisper-server', whisper_server_port: 18791, mlx_port: 18792, cleanup_port: 18793 } as const

export function realVoiceInstall(env: NodeJS.ProcessEnv): boolean {
  return env.WALNUT_STT_REAL_INSTALL === '1'
}
