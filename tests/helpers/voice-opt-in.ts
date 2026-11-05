/**
 * The test runner is an isolated server, where voice is off
 * (src/core/stt/voice-here.ts). A test that runs a speech engine itself (a fake
 * binary or daemon, or a mocked engine behind the real routing) opts in the way
 * a person would, with WALNUT_STT_AUTO_SETUP=1, for the describe block or file
 * it is called in, and the value it found is put back after.
 *
 * Never in a test that boots a whole server: there the same opt-in also lets the
 * boot job install the voice model.
 */
import { afterAll, beforeAll } from 'vitest';

export function optInToVoice(): void {
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env.WALNUT_STT_AUTO_SETUP;
    process.env.WALNUT_STT_AUTO_SETUP = '1';
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.WALNUT_STT_AUTO_SETUP;
    else process.env.WALNUT_STT_AUTO_SETUP = saved;
  });
}
